/* Long-poll Foundry chat queue. */

import { existsSync, rmSync } from 'node:fs';
import { truncateForLog } from './audit.js';

const LISTENER_TIMEOUT_MS = 45_000; // listener expiry window
const SWEEP_INTERVAL_MS = 10_000; // sweep period
const LONG_POLL_TIMEOUT_MS = 25_000; // stays under MCP 60s
const TERMINATORS = new Set(['/exit', '/stop', '/quit']); // DESIGN §10 stop words

const TAB_CLOSE = '/close'; // close command
const INTERACTION_COMMANDS = new Map([['/int', 'internal'], ['/ext', 'external']]); // mode switch commands

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
    if (this._sweep) return; // already running returns
    /* Expire quiet listeners. */
    this._sweep = setInterval(() => {
      this._checkStopFile(); // catch .loop-stop mid-idle, not next timeout
      if (this.terminate) this._wake(); // terminate wakes pollers
      if (this.listenerActive && Date.now() - this.listenerLastSeen > LISTENER_TIMEOUT_MS) { // quiet listener expires, status broadcast
        this.listenerActive = false;
        this.activeListenerId = null;
        this._broadcastStatus();
      }
    }, SWEEP_INTERVAL_MS);
    this._sweep.unref?.();
  }

  stop() {
    if (this._sweep) { clearInterval(this._sweep); this._sweep = null; } // running sweep cleared
  }

  _onPrompt({ promptId, text, tabId }) {
    const trimmed = (text || '').trim();
    const command = trimmed.toLowerCase();
    if (TERMINATORS.has(command)) { // stop word terminates, returns
      this.terminate = true;
      this.tabs.reset('terminate');
      this.audit.log('chat.terminate', { via: command });
      this._broadcastStatus();
      this._wake();
      return;
    }
    if (command === TAB_CLOSE) { // close command closes tab, returns
      if (this.tabs.tabs.has(tabId)) this.tabs.close(tabId); // known tab closed
      return;
    }
    if (INTERACTION_COMMANDS.has(command)) { // mode command switches mode, returns
      this.setInteractionMode(INTERACTION_COMMANDS.get(command), command);
      this.dispatcher.notifyBridge({ capabilitySet: this.capabilitySet, method: 'aagm.mode', params: { mode: this.interactionMode } });
      return;
    }
    if (this.interactionMode === 'external') { // external mode logs and drops prompt
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
    if (!this.stopFilePath || !existsSync(this.stopFilePath)) return; // no stop file returns
    if (!this.terminate) { // first stop sets terminate
      this.terminate = true;
      this.tabs.reset('terminate');
      this.audit.log('chat.terminate', { via: '.loop-stop' });
    }
    try { rmSync(this.stopFilePath); } catch { /* best-effort; flag already set */ }
  }

  _wake() {
    if (this._waiters.size === 0) return; // no waiters returns
    for (const w of [...this._waiters]) w(); // each waiter released
  }

  /* Claim the single listener slot. */
  claimListener(listenerId) {
    const expired = this.activeListenerId && Date.now() - this.listenerLastSeen > LISTENER_TIMEOUT_MS;
    if (expired) { // expired owner cleared
      this.activeListenerId = null;
      this.listenerActive = false;
    }
    if (this.activeListenerId && listenerId !== this.activeListenerId) return false; // other owner active refuses
    this.activeListenerId = listenerId;
    this.listenerLastSeen = Date.now();
    if (!this.listenerActive) { // first claim broadcasts ready
      this.listenerActive = true;
      this._broadcastStatus();
    }
    return true;
  }

  /* Wait for work or timeout. */
  async waitForWork({ timeoutMs = LONG_POLL_TIMEOUT_MS } = {}) {
    this._checkStopFile();
    if (this.terminate || this.queue.length) return; // work pending returns at once
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return; // repeat finish ignored
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
    if (!this.listenerActive) { // first drain broadcasts ready
      this.listenerActive = true;
      this._broadcastStatus();
    }
    this._checkStopFile();
    /* Consume termination once. */
    const terminate = this.terminate;
    this.terminate = false;
    if (terminate) { // terminate resets listener and tabs
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
    this.queue = this.queue.filter((prompt) => { // keeps all but this tab's interrupts
      if (!prompt.interrupt || prompt.tabId !== tabId) return true; // other prompts stay queued
      prompts.push(prompt);
      return false;
    });
    return prompts;
  }

  setInteractionMode(mode, via = 'relay') {
    if (mode !== 'internal' && mode !== 'external') return false; // unknown mode returns false
    const prev = this.interactionMode;
    this.interactionMode = mode;
    if (mode === 'external') { // external parks non close prompts
      this.tabs.settle('external-mode');
      const parked = this.queue.filter((prompt) => !prompt.close);
      this.queue = this.queue.filter((prompt) => prompt.close);
      if (parked.length) { // parked prompts logged
        this.parked.push(...parked);
        this.audit.log('chat.external.parked', { count: parked.length });
      }
    } else if (prev === 'external' && this.parked.length) { // leaving external restores parked prompts
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
