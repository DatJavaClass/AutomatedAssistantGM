// Phase 2 — the Foundry → Claude Code direction. The in-Foundry chat box sends
// `claude.prompt` notifications; this queue buffers them for a polling /loop on
// the Claude Code side (via the foundry_get_prompts MCP tool). Replies travel
// back the other way as `claude.reply` notifications (see dispatcher.notifyBridge).
//
// Why a queue + poll instead of a push: nothing can inject a prompt into a
// running Claude Code session — MCP is Claude-initiated. So Claude Code polls
// here in a loop, and the relay holds messages until it does.

import { existsSync, rmSync } from 'node:fs';

// A listener (a draining /loop) is considered "active" if foundry_get_prompts
// has been called within this window. Sized at ~1.5× a slow loop cadence.
const LISTENER_TIMEOUT_MS = 45_000;
const SWEEP_INTERVAL_MS = 10_000;
// foundry_get_prompts long-polls: it blocks until a message/terminator arrives
// or this elapses, then returns (empty if nothing). Near-zero pickup latency
// when active; ~1 call per this interval when idle. Kept well under the MCP
// client's 60s request timeout, and < LISTENER_TIMEOUT_MS so an alive,
// idle-but-polling loop still reads as "ready".
const LONG_POLL_TIMEOUT_MS = 25_000;
// Typed control words that mean "stop the loop" — see DESIGN §10 Phase 2.
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
    this._sweep = null;
    this._waiters = new Set();   // resolve fns for in-flight long-poll calls

    dispatcher.subscribe('claude.prompt', (p) => this._onPrompt(p || {}));
    // Box opened (or reconnected): it wants the current status immediately.
    dispatcher.subscribe('claude.hello', () => this._broadcastStatus());
  }

  start() {
    if (this._sweep) return;
    // If a listener goes quiet (loop stopped/crashed), flip the box back to
    // "no-listener" so DatJavaClass isn't typing into a void without knowing.
    this._sweep = setInterval(() => {
      // Catch a .loop-stop dropped during an otherwise-idle long-poll so the
      // loop ends within a sweep tick, not only on the next timeout.
      this._checkStopFile();
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
    // Reflect listener presence as the user types, not just on poll.
    this._broadcastStatus();
    this._wake();   // release any in-flight long-poll immediately
  }

  // .loop-stop is a local kill file — a terminator that works even if the
  // box/relay link is down. Idempotent: logs/sets terminate at most once.
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

  // Long-poll: resolve as soon as there is work (a queued prompt or a pending
  // terminate) or after timeoutMs. drain() is called by the tool right after.
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

  // Called by the foundry_get_prompts MCP tool after waitForWork. Draining
  // counts as a poll, so the box flips to "ready".
  drain() {
    this.listenerLastSeen = Date.now();
    if (!this.listenerActive) {
      this.listenerActive = true;
      this._broadcastStatus();
    }
    this._checkStopFile();
    // Consume-once: report terminate to the loop that's draining, then clear it
    // so a freshly-started loop isn't instantly killed by a stale flag (no
    // relay restart needed after an /exit).
    const terminate = this.terminate;
    this.terminate = false;
    const prompts = this.queue.splice(0, this.queue.length);
    return { prompts, terminate };
  }

  _broadcastStatus() {
    // Module localizes the state into DatJavaClass's language (project rule: strings
    // live in lang/en.json, not here). 'disconnected' is detected box-side.
    const state = this.listenerActive ? 'ready' : 'no-listener';
    this.dispatcher.notifyBridge({ capabilitySet: 'debug', method: 'claude.status', params: { state } });
  }
}
