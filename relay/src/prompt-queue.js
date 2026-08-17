/* Long-poll Foundry chat queue. */

import { existsSync, rmSync } from 'node:fs';

const LISTENER_TIMEOUT_MS = 45_000; // active window, ~1.5x slow loop cadence
const SWEEP_INTERVAL_MS = 10_000;
const LONG_POLL_TIMEOUT_MS = 25_000; // under MCP's 60s and LISTENER_TIMEOUT_MS
const TERMINATORS = new Set(['/exit', '/stop', '/quit']); // DESIGN §10 stop words

export class PromptQueue {
  constructor({ dispatcher, audit, stopFilePath, capabilitySet }) {
    this.dispatcher = dispatcher;
    this.audit = audit;
    this.stopFilePath = stopFilePath;
    this.capabilitySet = capabilitySet;
    this.queue = [];
    this.terminate = false;
    this.listenerLastSeen = 0;
    this.listenerActive = false;
    this.activeListenerId = null;
    this._sweep = null;
    this._waiters = new Set(); // in-flight long-poll resolvers

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

  _onPrompt({ promptId, text }) {
    const trimmed = (text || '').trim();
    if (TERMINATORS.has(trimmed.toLowerCase())) {
      this.terminate = true;
      this.audit.log('chat.terminate', { via: trimmed.toLowerCase() });
      this._broadcastStatus();
      this._wake();
      return;
    }
    this.queue.push({ promptId: promptId || `p-${Date.now()}`, text: text ?? '', ts: new Date().toISOString() });
    this.audit.log('chat.in', { promptId, len: (text || '').length });
    this._broadcastStatus(); // reflect listener presence as the user types
    this._wake(); // release any in-flight long-poll immediately
  }

  /* Check the local kill file. */
  _checkStopFile() {
    if (!this.stopFilePath || !existsSync(this.stopFilePath)) return;
    if (!this.terminate) {
      this.terminate = true;
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
      this._broadcastStatus();
    }
    const prompts = this.queue.splice(0, this.queue.length);
    return { prompts, terminate };
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
