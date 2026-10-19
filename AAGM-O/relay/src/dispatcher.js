/* Route JSON-RPC between clients and bridges. */

import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 30_000; // default bridge call timeout

export class Dispatcher {
  constructor({ audit }) {
    this.audit = audit;
    this.bridges = new Map(); // sessionId -> bridge record
    this.pending = new Map(); // requestId to pending call
    this.subscribers = new Map(); // notification method -> Set<fn>
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
    const rec = this.bridges.get(sessionId);
    if (!rec) return; // unknown session returns, known continues
    this.bridges.delete(sessionId);
    this.audit.log('bridge.disconnected', { sessionId, userId: rec.userId, reason });
    /* Reject disconnected bridge requests. */
    for (const [reqId, p] of this.pending) { // each pending call checked for session
      if (p.sessionId === sessionId) { // session match rejects and clears
        clearTimeout(p.timer);
        p.reject(new Error(`bridge disconnected: ${reason || 'unknown'}`));
        this.pending.delete(reqId);
      }
    }
  }

  findBridge({ capabilitySet }) {
    /* Return the first matching bridge. */
    for (const rec of this.bridges.values()) { // first bridge with matching set wins
      if (rec.capabilitySet === capabilitySet) return rec; // match returns record, else next
    }
    return null;
  }

  async sendToBridge({ capabilitySet, method, params, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const bridge = this.findBridge({ capabilitySet });
    if (!bridge) { // no bridge throws -33003
      const err = new Error(`no bridge connected with capability set "${capabilitySet}"`);
      err.code = -33003;
      throw err;
    }
    if (!bridge.capabilities.has(method)) { // unsupported method throws -33001
      const err = new Error(`method "${method}" not in capability set "${capabilitySet}"`);
      err.code = -33001;
      throw err;
    }
    const id = `req-${randomUUID()}`;
    const message = { jsonrpc: '2.0', method, params, id };
    this.audit.log('cmd.out', { sessionId: bridge.sessionId, method, id, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request "${method}" (${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, sessionId: bridge.sessionId, method });
      bridge.send(message);
    });
  }

  /* Relay notification. False means disconnected. */
  notifyBridge({ capabilitySet, method, params }) {
    const bridge = this.findBridge({ capabilitySet });
    if (!bridge) return false; // no bridge returns false
    bridge.send({ jsonrpc: '2.0', method, params });
    this.audit.log('notify.out', { sessionId: bridge.sessionId, method });
    return true;
  }

  /* Resolve bridge responses. */
  resolveResponse(message) {
    const id = message.id;
    if (id == null) return false; // no id returns false
    const p = this.pending.get(id);
    if (!p) return false; // unknown id returns false
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (message.error) { // bridge error rejects with code
      const err = new Error(message.error.message || 'bridge error');
      err.code = message.error.code;
      err.data = message.error.data;
      this.audit.log('cmd.err', { id, method: p.method, code: err.code });
      p.reject(err);
    } else { // success resolves with result
      this.audit.log('cmd.ok', { id, method: p.method, result: message.result });
      p.resolve(message.result);
    }
    return true;
  }

  /* Route bridge notifications. */
  routeNotification(message) {
    const subs = this.subscribers.get(message.method);
    if (!subs || subs.size === 0) return; // no subscribers returns early
    this.audit.log('notify', { method: message.method, subscribers: subs.size });
    for (const fn of subs) { // each subscriber called, throws logged
      try { fn(message.params); } catch (err) {
        console.error(`[dispatcher] subscriber for ${message.method} threw:`, err);
      }
    }
  }

  subscribe(method, fn) {
    if (!this.subscribers.has(method)) this.subscribers.set(method, new Set()); // first subscriber creates the set
    this.subscribers.get(method).add(fn);
    return () => this.subscribers.get(method)?.delete(fn);
  }
}
