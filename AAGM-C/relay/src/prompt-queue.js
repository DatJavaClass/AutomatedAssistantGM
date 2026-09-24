// Chat queue: box prompts in, replies back.

import { existsSync, rmSync } from 'node:fs';

const LISTENER_TIMEOUT_MS = 45_000; /* "active" window, ~1.5x slow loop */
const SWEEP_INTERVAL_MS = 10_000;
// Long-poll cap: under MCP's 60s timeout, under LISTENER_TIMEOUT_MS
// so an idle polling loop still reads "ready".
const LONG_POLL_TIMEOUT_MS = 25_000;
// Typed stop words (DESIGN §10 Phase 2).
const TERMINATORS = new Set(['/exit', '/stop', '/quit']);
const TAB_CLOSE = '/close'; /* §14: closes one tab, stops its agent */
const BUSY = new Set(['working', 'gated']); /* prompt lands mid task = interrupt */
const LOG_TAIL = 20;

export class PromptQueue {
  constructor({ dispatcher, audit, stopFilePath, tabs, daylog, rollbacks }) {
    this.dispatcher = dispatcher;
    this.audit = audit;
    this.tabs = tabs; /* §14 tab table; prompts land in a tab */
    this.daylog = daylog;
    this.rollbacks = rollbacks;
    this.surface = 'int'; /* int = box seat, ext = terminal seat */
    this.parked = []; /* prompts typed while ext */
    // Every close path becomes one prompt, never missed
    if (tabs) tabs.onClose = (tabId) => {
      this.queue.push({ promptId: `close-${tabId}-${Date.now()}`, text: TAB_CLOSE, tabId, close: true, ts: new Date().toISOString() });
      this.audit.log('chat.close', { tabId });
      this._wake();
    };
    // Rollback lands in loop's prompt path §15.2
    if (rollbacks) rollbacks.onRolledBack = (r) => {
      if (!r?.rolledBack?.length || r.via === 'tool') return; /* Claude's own: no echo */
      const lines = r.rolledBack.map((p) => `${p.id} ${p.summary} (${p.state})`).join('; ');
      this._system(`Rolled back via ${r.via}: ${lines}. The world is back to before those changes; re-read before continuing.`, r.rolledBack[0].tabId, { rollback: true });
    };
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

  _onPrompt({ promptId, text, tabId }) {
    const trimmed = (text || '').trim();
    const word = trimmed.toLowerCase();
    if (TERMINATORS.has(word)) {
      this.terminate = true;
      this.tabs?.reset('terminate');
      this.audit.log('chat.terminate', { via: word });
      this.daylog?.write('session', `terminate via ${word}`);
      this._broadcastStatus();
      this._wake();
      return;
    }
    if (word === TAB_CLOSE) {
      if (this.tabs?.tabs.has(tabId)) this.tabs.close(tabId); /* onClose enqueues */
      return;
    }
    if (this._command(word, tabId)) return;
    if (this.surface === 'ext') {
      // Parked: transcript keeps the line, tab state untouched.
      const tab = this.tabs ? this.tabs.note(tabId, text ?? '') : tabId;
      this.parked.push({ promptId: promptId || `p-${Date.now()}`, text: text ?? '', tabId: tab, ts: new Date().toISOString() });
      this.daylog?.write('parked', text ?? '', { tabId: tab, surface: this.surface });
      this.audit.log('chat.parked', { promptId, tabId: tab });
      this._reply(`Parked until /int (external seat active).`, tab);
      return;
    }
    const wasBusy = BUSY.has(this.tabs?.tabs.get(tabId)?.state);
    const tab = this.tabs?.prompt(tabId, text ?? '');
    const entry = { promptId: promptId || `p-${Date.now()}`, text: text ?? '', tabId: tab, ts: new Date().toISOString() };
    if (wasBusy) entry.interrupt = true; /* §15.1: mid task addendum */
    this.daylog?.write(entry.interrupt ? 'interrupt' : 'prompt', entry.text, { tabId: tab, surface: this.surface });
    this.queue.push(entry);
    this.audit.log('chat.in', { promptId, tabId: tab, len: (text || '').length, interrupt: !!entry.interrupt });
    // Refresh status as the user types.
    this._broadcastStatus();
    this._wake(); // release in-flight long-polls immediately
  }

  // Box commands relay answers itself; true means consumed
  _command(word, tabId) {
    const [cmd, ...rest] = word.split(/\s+/);
    if (cmd === '/ext' || cmd === '/int') { this.setSurface(cmd.slice(1), 'box'); return true; }
    if (cmd === '/log') {
      const n = Number.parseInt(rest[0], 10);
      const r = this.daylog?.read(undefined, Number.isFinite(n) && n > 0 ? n : LOG_TAIL);
      this._reply(r?.lines?.length ? `${r.path}\n${r.lines.join('\n')}` : `No log yet today.`, tabId);
      return true;
    }
    if (cmd === '/rollback' || cmd === '/rb') {
      if (!this.rollbacks) return true;
      this.rollbacks.rollbackTo(rest[0] || undefined, { via: 'box' })
        .then((r) => { if (r?.refused) this._reply(`Rollback refused: ${r.reason}`, tabId); })
        .catch((err) => this._reply(`Rollback failed: ${err.message}`, tabId));
      return true;
    }
    if (cmd === '/points' || cmd === '/rps') {
      const pts = this.rollbacks?.list() || [];
      this._reply(pts.length ? pts.slice(-LOG_TAIL).map((p) => `${p.id} [${p.state}] ${p.summary} (${p.captured})`).join('\n') : 'No rollback points today.', tabId);
      return true;
    }
    return false;
  }

  // §15.3 seat switch: ext parks box, int releases
  setSurface(mode, via = 'tool') {
    if (mode !== 'ext' && mode !== 'int') return this.surface;
    const prev = this.surface;
    this.surface = mode;
    this.audit.log('surface', { mode, via, prev });
    if (prev !== mode) this.daylog?.write('seat', `${mode === 'ext' ? 'EXTERNAL (terminal Claude)' : 'INTERNAL (box)'} via ${via}`);
    if (mode === 'int' && this.parked.length) {
      for (const p of this.parked.splice(0, this.parked.length)) { this.tabs?.prompt(p.tabId, p.text, { quiet: true }); this.queue.push(p); }
      this._wake();
    }
    this._broadcastStatus();
    return this.surface;
  }

  // Relay-authored line into the box (commands, parking).
  _reply(text, tabId) {
    const routed = this.tabs ? this.tabs.reply(tabId || this.tabs.first().id, text, { final: false, keepState: true }) : { text, tabId };
    this.dispatcher.notifyBridge({ capabilitySet: 'debug', method: 'claude.reply', params: { text: routed.text, tabId: routed.tabId, system: true } });
  }

  // Relay-authored prompt the loop must see (rollback notices).
  _system(text, tabId, flags = {}) {
    const tab = this.tabs?.resolve(tabId) || tabId;
    this.queue.push({ promptId: `sys-${Date.now()}`, text, tabId: tab, system: true, interrupt: true, ...flags, ts: new Date().toISOString() });
    this._reply(text, tab);
    this._wake();
  }

  // §15.1: mid task prompts feed working tool call
  takeInterrupts(tabId) {
    if (!this.queue.length) return [];
    const out = [];
    for (let i = 0; i < this.queue.length; i++) {
      const p = this.queue[i];
      if (p.interrupt && (!tabId || p.tabId === tabId)) { out.push(p); this.queue.splice(i--, 1); }
    }
    if (out.length) this.audit.log('chat.interrupt', { tabId, count: out.length, delivered: 'tool-result' });
    return out;
  }

  // Local kill file; works even link-down. Idempotent.
  _checkStopFile() {
    if (!this.stopFilePath || !existsSync(this.stopFilePath)) return;
    if (!this.terminate) {
      this.terminate = true;
      this.audit.log('chat.terminate', { via: '.loop-stop' });
      this.daylog?.write('session', 'terminate via .loop-stop');
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
      this.daylog?.write('session', `listener ${this.activeListenerId || '?'} polling`);
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
      this.tabs?.reset('terminate'); /* .loop-stop path */
      this._broadcastStatus();
    }

    const prompts = this.queue.splice(0, this.queue.length);
    return { prompts, terminate, surface: this.surface };
  }

  _broadcastStatus() {
    // Module localizes; strings live in lang/en.json.
    // 'disconnected' is detected box-side.
    const state = this.surface === 'ext' ? 'ext' : this.listenerActive ? 'ready' : 'no-listener';
    this.dispatcher.notifyBridge({ capabilitySet: 'debug', method: 'claude.status', params: { state, surface: this.surface } });
  }
}
