import { truncateForLog } from './audit.js';

const MAX_LINES = 40;
const TITLE_LEN = 24;
const DEFAULT_ID = 't-main';

export class TabTable {
  constructor({ dispatcher, audit, capabilitySet }) {
    this.dispatcher = dispatcher;
    this.audit = audit;
    this.capabilitySet = capabilitySet;
    this.tabs = new Map();
    this.closed = [];
    this.onClose = null;
    dispatcher.subscribe('aagm.status.request', () => this.broadcast());
  }

  ensure(tabId, firstText = '') {
    const id = tabId || DEFAULT_ID;
    let tab = this.tabs.get(id);
    if (!tab) {
      const title = firstText.trim().slice(0, TITLE_LEN) || id;
      tab = { id, title, state: 'idle', transcript: [] };
      this.tabs.set(id, tab);
      this.audit.log('tab.open', { tabId: id, title });
    }
    return tab;
  }

  first() {
    for (const tab of this.tabs.values()) return tab;
    return this.ensure(DEFAULT_ID);
  }

  resolve(tabId) {
    return tabId && this.tabs.has(tabId) ? tabId : this.first().id;
  }

  prompt(tabId, text) {
    const tab = this.ensure(tabId, text);
    this.push(tab, 'user', text);
    tab.state = 'working';
    this.broadcast();
    return tab.id;
  }

  isWorking(tabId) {
    return this.tabs.get(tabId || DEFAULT_ID)?.state === 'working';
  }

  reply(tabId, text, { final = true } = {}) {
    const id = tabId;
    if (!this.tabs.has(id)) {
      this.audit.log('tab.reply.dropped', { tabId: id, text: truncateForLog(text) });
      return { tabId: id, text, dropped: true };
    }
    const tab = this.tabs.get(id);
    this.push(tab, 'assistant', text);
    tab.state = final ? 'done' : 'working';
    this.broadcast();
    return { tabId: id, text };
  }

  close(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.tabs.delete(tabId);
    this.closed.push(tabId);
    this.audit.log('tab.close', { tabId });
    this.broadcast();
    this.onClose?.(tabId);
  }

  reset(reason) {
    if (!this.tabs.size && !this.closed.length) return;
    this.audit.log('tab.reset', { reason, count: this.tabs.size });
    this.tabs.clear();
    this.closed.length = 0;
    this.broadcast();
  }

  settle(reason) {
    let changed = 0;
    for (const tab of this.tabs.values()) {
      if (tab.state !== 'working') continue;
      tab.state = 'done';
      changed++;
    }
    if (!changed) return;
    this.audit.log('tab.settle', { reason, count: changed });
    this.broadcast();
  }

  drainClosed() { return this.closed.splice(0); }
  list() { return [...this.tabs.values()].map(({ id, title, state }) => ({ id, title, state })); }
  snapshot() { return { tabs: [...this.tabs.values()] }; }

  broadcast() {
    this.dispatcher.notifyBridge({ capabilitySet: this.capabilitySet, method: 'aagm.tabs', params: this.snapshot() });
  }

  push(tab, role, text) {
    tab.transcript.push({ role, text, ts: new Date().toISOString() });
    if (tab.transcript.length > MAX_LINES) tab.transcript.splice(0, tab.transcript.length - MAX_LINES);
  }
}
