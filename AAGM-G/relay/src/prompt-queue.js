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
    this.interactionMode = 'internal'; // /int default, /ext stands aside
    this.busy = 0;
    this.onLocal = null;
    this.queue = [];
    this.parked = []; // queued prompts held by /ext
    this.terminate = false;
    this.listenerLastSeen = 0;
    this.listenerActive = false;
    this.activeListenerId = null;
    this._sweep = null;
    this._waiters = new Set(); // in-flight long-poll resolvers

    tabs.onClose = (tabId) => {
      const external = this.interactionMode === 'external';
      this.queue.push({
        promptId: `close-${tabId}-${Date.now()}`, text: TAB_CLOSE, tabId, close: true,
        ...(external ? { interrupt: true } : {}), ts: new Date().toISOString(),
      });
      this.audit.log('chat.close', { tabId });
      this._wake();
    };

    dispatcher.subscribe('aagm.prompt', (p) => this._onPrompt(p || {}));
    dispatcher.subscribe('aagm.status.request', () => this._broadcastStatus());
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
      const mode = INTERACTION_COMMANDS.get(command);
      this.tabs.setMode(tabId, mode);
      this.setInteractionMode(mode, command);
      this.onLocal?.('mode', mode);
      return;
    }
    if (command === '/log' || command.startsWith('/log ')) {
      this.audit.log('chat.command', { command: '/log' });
      this.onLocal?.('log', trimmed.slice(4).trim());
      return;
    }
    if (command === '/rollback' || command.startsWith('/rollback ')) {
      this.audit.log('chat.command', { command: '/rollback' });
      this.onLocal?.('rollback', trimmed.slice(9).trim());
      return;
    }
    const external = this.interactionMode === 'external';
    const interrupt = this.tabs.isWorking(tabId) || this.busy > 0 || external;
    const id = this.tabs.prompt(tabId, text ?? '');
    this.queue.push({
      promptId: promptId || `p-${Date.now()}`, text: text ?? '', tabId: id,
      ...(interrupt ? { interrupt: true } : {}), ...(external ? { external: true } : {}),
      ts: new Date().toISOString(),
    });
    if (external) this.onLocal?.('held', text ?? '');
    this.audit.log('chat.in', { promptId, tabId: id, interrupt, external, text: truncateForLog(text ?? '') });
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
    if (this.interactionMode === 'external' && !terminate) {
      this.activeListenerId = null;
      this.listenerActive = false;
      this._broadcastStatus();
      return { prompts: [], terminate: false, hold: true, mode: this.interactionMode };
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

  markBusy(on) { this.busy = Math.max(0, this.busy + (on ? 1 : -1)); }

  /* Pull interrupt prompts. Omit tabId for every tab. */
  takeInterrupt(tabId) {
    if (tabId) return this.drainInterrupts(tabId);
    const prompts = [];
    this.queue = this.queue.filter((prompt) => {
      if (!prompt.interrupt) return true;
      prompts.push(prompt);
      return false;
    });
    return prompts;
  }

  setInteractionMode(mode, via = 'relay') {
    if (mode !== 'internal' && mode !== 'external') return false;
    const prev = this.interactionMode;
    this.interactionMode = mode;
    if (mode === 'external' && prev !== 'external') {
      const parked = this.queue.filter((prompt) => !prompt.close);
      this.queue = this.queue.filter((prompt) => prompt.close);
      for (const prompt of this.queue) prompt.interrupt = true; // closes still reach outside Grok
      if (parked.length) {
        this.parked.push(...parked);
        this.audit.log('chat.external.parked', { count: parked.length });
      }
    } else if (mode === 'internal' && prev === 'external' && this.parked.length) {
      const count = this.parked.length;
      this.queue = [...this.parked.splice(0), ...this.queue];
      this.audit.log('chat.internal.unparked', { count });
    }
    this.audit.log('chat.mode', { mode, via });
    this.dispatcher.notifyBridge({
      capabilitySet: this.capabilitySet, method: 'aagm.mode', params: { mode },
    });
    this._wake();
    return true;
  }

  status() {
    return { state: this.listenerActive ? 'ready' : 'no-listener' };
  }

  _broadcastStatus() {
    /* Foundry detects disconnection locally. */
    const state = this.listenerActive ? 'ready' : 'no-listener';
    this.dispatcher.notifyBridge({
      capabilitySet: this.capabilitySet,
      method: 'aagm.status',
      params: { state, mode: this.interactionMode },
    });
  }
}
