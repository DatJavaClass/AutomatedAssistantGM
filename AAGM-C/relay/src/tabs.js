// Tab table, relay owned, box renders.

const MAX_LINES = 40; /* transcript kept per tab */
const TITLE_LEN = 24;
const CAPABILITY_SET = 'debug';
const DEFAULT_ID = 't-main'; /* tabs off = single unnamed tab */

export class TabTable {
  constructor({ dispatcher, audit }) {
    this.dispatcher = dispatcher;
    this.audit = audit;
    this.tabs = new Map(); /* id -> { id, title, state, transcript } */
    this.closedTitles = new Map(); /* id -> title; prefixes late replies */
    this.closed = []; /* drained by foundry_get_prompts */
    this.onClose = null; /* prompt-queue enqueues the /close prompt */
    dispatcher.subscribe('claude.hello', () => this.broadcast());
    dispatcher.subscribe('claude.tab.close', (p) => this.close(p?.tabId));
  }

  // Unknown id registers; title = first prompt.
  ensure(tabId, firstText = '') {
    const id = tabId || DEFAULT_ID;
    let t = this.tabs.get(id);
    if (!t) {
      const title = firstText.trim().slice(0, TITLE_LEN) || id;
      t = { id, title, state: 'idle', transcript: [] };
      this.tabs.set(id, t);
      this.audit.log('tab.open', { tabId: id, title });
    }
    return t;
  }

  // Live id, else first tab, created if none
  resolve(tabId) {
    if (tabId && this.tabs.has(tabId)) return tabId;
    return this.first().id;
  }

  first() {
    for (const t of this.tabs.values()) return t;
    return this.ensure(DEFAULT_ID);
  }

  // Prompt in: tab works; reply done unless more
  prompt(tabId, text, { quiet = false } = {}) {
    const t = this.ensure(tabId, text);
    if (!quiet) this._push(t, 'user', text); /* parked line already shown */
    t.state = 'working';
    this.broadcast();
    return t.id;
  }

  // Parked prompt: shown, not worked.
  note(tabId, text) {
    const t = this.ensure(tabId, text);
    this._push(t, 'user', text);
    this.broadcast();
    return t.id;
  }

  // keepState: relay authored sys line, state untouched
  reply(tabId, text, { final = true, keepState = false } = {}) {
    let id = tabId, line = text;
    if (!this.tabs.has(id)) {
      const title = this.closedTitles.get(id);
      id = this.first().id;
      if (title) line = `[${title}] ${text}`; /* late reply from a closed tab */
    }
    const t = this.tabs.get(id);
    this._push(t, keepState ? 'sys' : 'claude', line);
    if (!keepState && t.state !== 'gated') t.state = final ? 'done' : 'working';
    this.broadcast();
    return { tabId: id, text: line };
  }

  // Gate card up = flash; cleared on decision.
  gated(tabId, on) {
    const t = this.tabs.get(tabId);
    if (!t) return;
    t.state = on ? 'gated' : 'working';
    this.broadcast();
  }

  close(tabId) {
    const t = this.tabs.get(tabId);
    if (!t) return;
    this.tabs.delete(tabId);
    this.closedTitles.set(tabId, t.title);
    this.closed.push(tabId);
    this.audit.log('tab.close', { tabId });
    this.broadcast();
    this.onClose?.(tabId);
  }

  drainClosed() { return this.closed.splice(0, this.closed.length); }

  // Loop terminate: every tab dies (§14.1).
  reset(reason) {
    if (!this.tabs.size && !this.closed.length) return;
    this.audit.log('tab.reset', { reason, count: this.tabs.size });
    this.tabs.clear();
    this.closed.length = 0;
    this.broadcast();
  }

  // Loop gets light list; box gets full table
  list() { return [...this.tabs.values()].map(({ id, title, state }) => ({ id, title, state })); }
  snapshot() { return { tabs: [...this.tabs.values()] }; }

  broadcast() {
    this.dispatcher.notifyBridge({ capabilitySet: CAPABILITY_SET, method: 'claude.tabs', params: this.snapshot() });
  }

  _push(t, role, text) {
    t.transcript.push({ role, text, ts: new Date().toISOString() });
    if (t.transcript.length > MAX_LINES) t.transcript.splice(0, t.transcript.length - MAX_LINES);
  }
}
