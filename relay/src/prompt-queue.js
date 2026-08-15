// Phase 2 chat queue: box claude.prompt in, claude.reply back.
// Poll not push; MCP is Claude-initiated (foundry_get_prompts drains).

import { existsSync, rmSync } from 'node:fs';

const LISTENER_TIMEOUT_MS = 45_000; /* "active" window, ~1.5x slow loop */
const SWEEP_INTERVAL_MS = 10_000;
// Long-poll cap: under MCP's 60s timeout, under LISTENER_TIMEOUT_MS
// so an idle polling loop still reads "ready".
const LONG_POLL_TIMEOUT_MS = 25_000;
// Typed stop words (DESIGN §10 Phase 2).
const TERMINATORS = new Set(['/exit', '/stop', '/quit']);

export class PromptQueue {
  constructor({ dispatcher, audit, stopFilePath }) {
    this.dispatcher = dispatcher;
    this.audit = audit;
    this.stopFilePath = stopFilePath;
    this.queue = [];
    this.terminate = false;
    this.listenerLastSeen = 0;
    this.listenerActive = false;
    this.activeListenerId = null;
    this._sweep = null;
    this._waiters = new Set(); // resolve fns for in-flight long-polls

    dispatcher.subscribe('claude.prompt', (p) => this._onPrompt(p || {}));
    // Box open/reconnect wants status immediately.
    dispatcher.subscribe('claude.hello', () => this._broadcastStatus());
  }

  start() {
    if (this._sweep) return;
    // Quiet listener flips box to "no-listener".
    this._sweep = setInterval(() => {
      // Sweep catches .loop-stop dropped mid-idle-poll.
      this._checkStopFile();
      if (this.terminate) this._wake();
      if (this.listenerActive && Date.now() - this.listenerLastSeen > LISTENER_TIMEOUT_MS) {
        this.listenerActive = false;
        this.activeListenerId = null; /* quiet loop frees the slot */
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
    // Refresh status as the user types.
    this._broadcastStatus();
    this._wake(); // release in-flight long-polls immediately
  }

  // Local kill file; works even link-down. Idempotent.
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

  // §13.2 single-listener lock; second id refused (-33005).
  // Frees on terminate/timeout. No more split-brain (2026-08-13).
  claimListener(listenerId) {
    if (this.listenerActive && this.activeListenerId && listenerId !== this.activeListenerId) return false;
    this.activeListenerId = listenerId;
    return true;
  }

  // Long-poll: resolve on work/terminate or timeoutMs.
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

  // Draining counts as a poll; box flips "ready".
  drain() {
    this.listenerLastSeen = Date.now();
    if (!this.listenerActive) {
      this.listenerActive = true;
      this._broadcastStatus();
    }
    this._checkStopFile();
    // Consume-once terminate; fresh loop survives stale flag.
    const terminate = this.terminate;
    this.terminate = false;
    if (terminate) {
      // Free slot now; relaunch never waits 45s.
      this.activeListenerId = null;
      this.listenerActive = false;
      this._broadcastStatus();
    }
    const prompts = this.queue.splice(0, this.queue.length);
    return { prompts, terminate };
  }

  _broadcastStatus() {
    // Module localizes; strings live in lang/en.json.
    // 'disconnected' is detected box-side.
    const state = this.listenerActive ? 'ready' : 'no-listener';
    this.dispatcher.notifyBridge({ capabilitySet: 'debug', method: 'claude.status', params: { state } });
  }
}
