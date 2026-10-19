// Routes JSON-RPC between MCP and bridges.

import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 30_000; /* bridge call timeout */

export class Dispatcher {
  constructor({ audit }) {
    this.audit = audit;
    this.bridges = new Map(); // sessionId -> bridge record
    this.pending = new Map(); // requestId -> resolve, reject, timer, sessionId, method
    this.subscribers = new Map(); // notification method -> Set<fn>
    this.confirmations = new Map(); // opId -> { resolve, timer, params, capabilitySet }
    // Chat box answers confirmation requests here
    this.subscribe('claude.confirm.result', (p) => this.resolveConfirmation(p || {}));
    // Box reopen mid-gate: resend live cards (§14)
    this.subscribe('claude.hello', () => {
      for (const c of this.confirmations.values()) this.notifyBridge({ capabilitySet: c.capabilitySet, method: 'claude.confirm', params: c.params }); // each live card, resends all
    });
  }

  // §9 gate: caller must check approved before writing
  requestConfirmation({ capabilitySet, opId, kind, level, summary, code, preview, tabId, timeoutMs = 120_000 }) {
    const params = { opId, kind, level, summary, code, preview, tabId }; /* card payload */
    const sent = this.notifyBridge({ capabilitySet, method: 'claude.confirm', params }); /* bridge got card */
    if (!sent) return Promise.resolve({ approved: false, reason: 'no-bridge' }); // no bridge denies, else waits
    this.audit.log('confirm.requested', { opId, kind, level, tabId });
    return new Promise((resolve) => {
      const timer = setTimeout(() => { /* auto deny timer */
        this.confirmations.delete(opId);
        this.audit.log('confirm.timeout', { opId });
        resolve({ approved: false, reason: 'timeout' });
      }, timeoutMs);
      this.confirmations.set(opId, { resolve, timer, params, capabilitySet });
    });
  }

  resolveConfirmation({ opId, approved, reason }) {
    const c = this.confirmations.get(opId); /* pending confirmation */
    if (!c) return; // unknown opId ignored, else resolves
    clearTimeout(c.timer);
    this.confirmations.delete(opId);
    this.audit.log('confirm.result', { opId, approved: !!approved, reason: reason || null });
    c.resolve({ approved: !!approved, reason: reason || (approved ? 'approved' : 'denied') });
  }

  registerBridge(record) {
    this.bridges.set(record.sessionId, record);
    this.audit.log('bridge.connected', {
      sessionId: record.sessionId,
      userId: record.userId,
      userName: record.userName,
      capabilitySet: record.capabilitySet,
    });
  }

  unregisterBridge(sessionId, reason) {
    const rec = this.bridges.get(sessionId); /* record being dropped */
    if (!rec) return; // unknown session ignored, else drops
    this.bridges.delete(sessionId);
    this.audit.log('bridge.disconnected', { sessionId, userId: rec.userId, reason });
    // Reject any pending requests bound to this bridge.
    for (const [reqId, p] of this.pending) { // each pending, rejects this bridge's
      if (p.sessionId === sessionId) { // bridge match rejects, else keeps
        clearTimeout(p.timer);
        p.reject(new Error(`bridge disconnected: ${reason || 'unknown'}`));
        this.pending.delete(reqId);
      }
    }
  }

  findBridge({ capabilitySet }) {
    // Phase 1: one bridge per capability set
    for (const rec of this.bridges.values()) { // each bridge, ends at set match
      if (rec.capabilitySet === capabilitySet) return rec; // set match returns, else next
    }
    return null;
  }

  async sendToBridge({ capabilitySet, method, params, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const bridge = this.findBridge({ capabilitySet }); /* bridge for set */
    if (!bridge) { // none connected throws, else sends
      const err = new Error(`no bridge connected with capability set "${capabilitySet}"`); /* no bridge error */
      err.code = -33003;
      throw err;
    }
    if (!bridge.capabilities.has(method)) { // method barred throws, else sends
      const err = new Error(`method "${method}" not in capability set "${capabilitySet}"`); /* barred method error */
      err.code = -33001;
      throw err;
    }
    const id = `req-${randomUUID()}`; /* request id */
    const message = { jsonrpc: '2.0', method, params, id }; /* JSON-RPC envelope */
    this.audit.log('cmd.out', { sessionId: bridge.sessionId, method, id });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { /* request timeout */
        this.pending.delete(id);
        reject(new Error(`request "${method}" (${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, sessionId: bridge.sessionId, method });
      bridge.send(message);
    });
  }

  // Relay-initiated push, not capability gated like sendToBridge
  notifyBridge({ capabilitySet, method, params }) {
    const bridge = this.findBridge({ capabilitySet }); /* bridge for set */
    if (!bridge) return false; // no bridge false, else sends
    bridge.send({ jsonrpc: '2.0', method, params });
    this.audit.log('notify.out', { sessionId: bridge.sessionId, method });
    return true;
  }

  // ws-server calls this on bridge responses
  resolveResponse(message) {
    const id = message.id; /* response id */
    if (id == null) return false; // no id false, else matches
    const p = this.pending.get(id); /* pending request */
    if (!p) return false; // unmatched false, else resolves
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (message.error) { // error rejects, else resolves
      const err = new Error(message.error.message || 'bridge error'); /* bridge error */
      err.code = message.error.code;
      err.data = message.error.data;
      this.audit.log('cmd.err', { id, method: p.method, code: err.code });
      p.reject(err);
    } else {
      this.audit.log('cmd.ok', { id, method: p.method });
      p.resolve(message.result);
    }
    return true;
  }

  // ws-server calls this on bridge notifications
  routeNotification(message) {
    const subs = this.subscribers.get(message.method); /* method subscribers */
    if (!subs || subs.size === 0) return; // none returns, else notifies
    this.audit.log('notify', { method: message.method, subscribers: subs.size });
    for (const fn of subs) { // each subscriber, isolated failures
      try { fn(message.params); } catch (err) {
        console.error(`[dispatcher] subscriber for ${message.method} threw:`, err);
      }
    }
  }

  subscribe(method, fn) {
    if (!this.subscribers.has(method)) this.subscribers.set(method, new Set()); // first listener makes set, else skips
    this.subscribers.get(method).add(fn);
    return () => this.subscribers.get(method)?.delete(fn);
  }
}
