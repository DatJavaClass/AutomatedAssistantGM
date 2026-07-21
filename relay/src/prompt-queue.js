/* Phase 2 queue: box prompts wait for the polling /loop.
   MCP is Claude-initiated, so push is impossible - poll it is. */

import { existsSync, rmSync } from 'node:fs';

const LISTENER_TIMEOUT_MS = 45_000; // active window, ~1.5x slow loop cadence
const SWEEP_INTERVAL_MS = 10_000;
const LONG_POLL_TIMEOUT_MS = 25_000; // under MCP's 60s and LISTENER_TIMEOUT_MS
const TERMINATORS = new Set(['/exit', '/stop', '/quit']); // DESIGN §10 stop words

export class PromptQueue {
  constructor({ dispatcher, audit, stopFilePath }) {
    this.dispatcher = dispatcher;
    this.audit = audit;
    this.stopFilePath = stopFilePath;
    this.queue = [];
    this.terminate = false;
    this.listenerLastSeen = 0;
    this.listenerActive = false;
    this._sweep = null;
    this._waiters = new Set(); // in-flight long-poll resolvers

    dispatcher.subscribe('claude.prompt', (p) => this._onPrompt(p || {}));
    dispatcher.subscribe('claude.hello', () => this._broadcastStatus()); // fresh box wants status now
  }

  start() {
    if (this._sweep) return;
    // Quiet listener flips the box to "no-listener" - no typing into the void.
    this._sweep = setInterval(() => {
      this._checkStopFile(); // catch .loop-stop mid-idle, not next timeout
      if (this.terminate) this._wake();
      if (this.listenerActive && Date.now() - this.listenerLastSeen > LISTENER_TIMEOUT_MS) {
        this.listenerActive = false;
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

  // Kill file works even with the box/relay link down. Idempotent.
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

  // Long-poll: resolves on work or timeout; drain() follows.
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

  // Draining counts as a poll; the box flips "ready".
  drain() {
    this.listenerLastSeen = Date.now();
    if (!this.listenerActive) {
      this.listenerActive = true;
      this._broadcastStatus();
    }
    this._checkStopFile();
    // Consume-once terminate: a stale flag never kills a fresh loop.
    const terminate = this.terminate;
    this.terminate = false;
    const prompts = this.queue.splice(0, this.queue.length);
    return { prompts, terminate };
  }

  _broadcastStatus() {
    // Strings live in lang/en.json; 'disconnected' is detected box-side.
    const state = this.listenerActive ? 'ready' : 'no-listener';
    this.dispatcher.notifyBridge({ capabilitySet: 'debug', method: 'claude.status', params: { state } });
  }
}
