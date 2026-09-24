/* Long-poll Foundry chat queue. */

import { existsSync, rmSync } from 'node:fs';
import { truncateForLog } from './audit.js';

const LISTENER_TIMEOUT_MS = 45_000; // active window, ~1.5x slow loop cadence
const SWEEP_INTERVAL_MS = 10_000;
const LONG_POLL_TIMEOUT_MS = 25_000; // under MCP's 60s and LISTENER_TIMEOUT_MS
const TERMINATORS = new Set(['/exit', '/stop', '/quit']); // DESIGN §10 stop words

const TAB_CLOSE = '/close';
const INTERACTION_COMMANDS = new Map([['/int', 'internal'], ['/ext', 'external']]);

export class PromptQueue {
  constructor({ dispatcher, audit, stopFilePath, capabilitySet, tabs }) {
    this.dispatcher = dispatcher;
    this.audit = audit;
    this.stopFilePath = stopFilePath;
    this.capabilitySet = capabilitySet;
    this.tabs = tabs;
    this.interactionMode = 'internal';
    this.queue = [];
    this.parked = []; // prompts held while in external mode
    this.terminate = false;
    this.listenerLastSeen = 0;
    this.listenerActive = false;
    this.activeListenerId = null;
    this._sweep = null;
    this._waiters = new Set(); // in-flight long-poll resolvers

    tabs.onClose = (tabId) => {
      this.queue.push({ promptId: `close-${tabId}-${Date.now()}`, text: TAB_CLOSE, tabId, close: true, ts: new Date().toISOString() });
      this.audit.log('chat.close', { tabId });
      this._wake();
    };

    dispatcher.subscribe('aagm.prompt', (p) => this._onPrompt(p || {}));
    dispatcher.subscribe('aagm.status.request', () => {
      this._broadcastStatus();
      this.dispatcher.notifyBridge({
        capabilitySet: this.capabilitySet,
        method: 'aagm.mode',
        params: { mode: this.interactionMode },
      });
    });
  }

  start() {
    if (this._sweep) return;
    /* Expire quiet listeners. */
    this._sweep = setInterval(() => {
      this._checkStopFile(); // catch .loop-stop mid-idle, not next timeout
      if (this.terminate) this._wake();
      if (this.listenerActive && Date.now() - this.listenerLastSeen > LISTENER_TIMEOUT_MS) {
        this.listenerActive = false;
        this.activeListenerId = null;
        this._broadcastStatus();
      }
    }, SWEEP_INTERVAL_MS);
    this._sweep.unref?.();
  }

  stop() {
    if (this._sweep) { clearInterval(this._sweep); this._sweep = null; }
  }

  _onPrompt({ promptId, text, tabId }) {
    const trimmed = (text || '').trim();
    const command = trimmed.toLowerCase();
    if (TERMINATORS.has(command)) {
      this.terminate = true;
      this.tabs.reset('terminate');
      this.audit.log('chat.terminate', { via: command });
      this._broadcastStatus();
      this._wake();
      return;
    }
    if (command === TAB_CLOSE) {
      if (this.tabs.tabs.has(tabId)) this.tabs.close(tabId);
      return;
    }
    if (INTERACTION_COMMANDS.has(command)) {
      this.setInteractionMode(INTERACTION_COMMANDS.get(command), command);
      this.dispatcher.notifyBridge({ capabilitySet: this.capabilitySet, method: 'aagm.mode', params: { mode: this.interactionMode } });
      return;
    }
    if (this.interactionMode === 'external') {
      this.audit.log('chat.external.ignored', { promptId, tabId, text: truncateForLog(text ?? '') });
      this.dispatcher.notifyBridge({ capabilitySet: this.capabilitySet, method: 'aagm.mode', params: { mode: this.interactionMode } });
      return;
    }
    const interrupt = this.tabs.isWorking(tabId);
    const id = this.tabs.prompt(tabId, text ?? '');
    this.queue.push({ promptId: promptId || `p-${Date.now()}`, text: text ?? '', tabId: id, ...(interrupt ? { interrupt: true } : {}), ts: new Date().toISOString() });
    this.audit.log('chat.in', { promptId, tabId: id, interrupt, text: truncateForLog(text ?? '') });
    this._broadcastStatus(); // reflect listener presence as the user types
    this._wake(); // release any in-flight long-poll immediately
  }

  /* Check the local kill file. */
  _checkStopFile() {
    if (!this.stopFilePath || !existsSync(this.stopFilePath)) return;
    if (!this.terminate) {
      this.terminate = true;
      this.tabs.reset('terminate');
      this.audit.log('chat.terminate', { via: '.loop-stop' });
    }
    try { rmSync(this.stopFilePath); } catch { /* best-effort; flag already set */ }
  }

  _wake() {
    if (this._waiters.size === 0) return;
    for (const w of [...this._waiters]) w();
  }

  /* Claim the single listener slot. */
  claimListener(listenerId) {
    const expired = this.activeListenerId && Date.now() - this.listenerLastSeen > LISTENER_TIMEOUT_MS;
    if (expired) {
      this.activeListenerId = null;
      this.listenerActive = false;
    }
    if (this.activeListenerId && listenerId !== this.activeListenerId) return false;
    this.activeListenerId = listenerId;
    this.listenerLastSeen = Date.now();
    if (!this.listenerActive) {
      this.listenerActive = true;
      this._broadcastStatus();
    }
    return true;
  }

  /* Wait for work or timeout. */
  async waitForWork({ timeoutMs = LONG_POLL_TIMEOUT_MS } = {}) {
    this._checkStopFile();
    if (this.terminate || this.queue.length) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this._waiters.add(finish);
    });
  }

  /* Draining activates listener status. */
  drain() {
    this.listenerLastSeen = Date.now();
    if (!this.listenerActive) {
      this.listenerActive = true;
      this._broadcastStatus();
    }
    this._checkStopFile();
    /* Consume termination once. */
    const terminate = this.terminate;
    this.terminate = false;
    if (terminate) {
      this.activeListenerId = null;
      this.listenerActive = false;
      this.tabs.reset('terminate');
      this._broadcastStatus();
    }
    const prompts = this.queue.splice(0, this.queue.length);
    return { prompts, terminate, mode: this.interactionMode };
  }

  /* Consume pending interrupts for one tab. */
  drainInterrupts(tabId) {
    const prompts = [];
    this.queue = this.queue.filter((prompt) => {
      if (!prompt.interrupt || prompt.tabId !== tabId) return true;
      prompts.push(prompt);
      return false;
    });
    return prompts;
  }

  setInteractionMode(mode, via = 'relay') {
    if (mode !== 'internal' && mode !== 'external') return false;
    const prev = this.interactionMode;
    this.interactionMode = mode;
    if (mode === 'external') {
      this.tabs.settle('external-mode');
      const parked = this.queue.filter((prompt) => !prompt.close);
      this.queue = this.queue.filter((prompt) => prompt.close);
      if (parked.length) {
        this.parked.push(...parked);
        this.audit.log('chat.external.parked', { count: parked.length });
      }
    } else if (prev === 'external' && this.parked.length) {
      this.queue = [...this.parked.splice(0), ...this.queue];
      this.audit.log('chat.internal.unparked', { count: this.queue.length });
    }
    this.audit.log('chat.mode', { mode, via });
    this._wake();
    return true;
  }

  status() {
    return { state: this.listenerActive ? 'ready' : 'no-listener' };
  }

  _broadcastStatus() {
    /* Foundry detects disconnection locally. */
    const state = this.listenerActive ? 'ready' : 'no-listener';
    this.dispatcher.notifyBridge({ capabilitySet: this.capabilitySet, method: 'aagm.status', params: { state } });
  }
}
