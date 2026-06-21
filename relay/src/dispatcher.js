// Routes JSON-RPC requests and notifications between MCP clients and bridge
// connections. Each bridge connection registers itself here on hello; the
// dispatcher then exposes "send a method to a bridge with this capability set"
// and "subscribe to a notification stream" primitives.

import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 30_000;

export class Dispatcher {
  constructor({ audit }) {
    this.audit = audit;
    this.bridges = new Map();      // sessionId -> bridge record
    this.pending = new Map();      // requestId -> { resolve, reject, timer, sessionId, method }
    this.subscribers = new Map();  // notification method -> Set<fn>
    this.confirmations = new Map(); // opId -> { resolve, timer }
    // The chat box answers a confirmation request with this notification.
    this.subscribe('claude.confirm.result', (p) => this.resolveConfirmation(p || {}));
  }

  // DESIGN §9 confirmation gate. Pushes the proposed write to the bridge (chat
  // box) and resolves with the human's decision, or auto-denies on timeout /
  // no bridge. The write is NOT executed here — the caller dispatches it only
  // after { approved:true }.
  requestConfirmation({ capabilitySet, opId, kind, level, summary, code, preview, timeoutMs = 120_000 }) {
    const sent = this.notifyBridge({
      capabilitySet,
      method: 'claude.confirm',
      params: { opId, kind, level, summary, code, preview },
    });
    if (!sent) return Promise.resolve({ approved: false, reason: 'no-bridge' });
    this.audit.log('confirm.requested', { opId, kind, level });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.confirmations.delete(opId);
        this.audit.log('confirm.timeout', { opId });
        resolve({ approved: false, reason: 'timeout' });
      }, timeoutMs);
      this.confirmations.set(opId, { resolve, timer });
    });
  }

  resolveConfirmation({ opId, approved, reason }) {
    const c = this.confirmations.get(opId);
    if (!c) return;
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
    const rec = this.bridges.get(sessionId);
    if (!rec) return;
    this.bridges.delete(sessionId);
    this.audit.log('bridge.disconnected', { sessionId, userId: rec.userId, reason });
    // Reject any pending requests bound to this bridge.
    for (const [reqId, p] of this.pending) {
      if (p.sessionId === sessionId) {
        clearTimeout(p.timer);
        p.reject(new Error(`bridge disconnected: ${reason || 'unknown'}`));
        this.pending.delete(reqId);
      }
    }
  }

  findBridge({ capabilitySet }) {
    // Phase 1 expects a single bridge per capability set. Pick the first match.
    for (const rec of this.bridges.values()) {
      if (rec.capabilitySet === capabilitySet) return rec;
    }
    return null;
  }

  async sendToBridge({ capabilitySet, method, params, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const bridge = this.findBridge({ capabilitySet });
    if (!bridge) {
      const err = new Error(`no bridge connected with capability set "${capabilitySet}"`);
      err.code = -33003;
      throw err;
    }
    if (!bridge.capabilities.has(method)) {
      const err = new Error(`method "${method}" not in capability set "${capabilitySet}"`);
      err.code = -33001;
      throw err;
    }
    const id = `req-${randomUUID()}`;
    const message = { jsonrpc: '2.0', method, params, id };
    this.audit.log('cmd.out', { sessionId: bridge.sessionId, method, id });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request "${method}" (${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, sessionId: bridge.sessionId, method });
      bridge.send(message);
    });
  }

  // Fire-and-forget notification to the bridge (no id, no response awaited).
  // Unlike sendToBridge this is relay-initiated, so it is NOT capability-gated:
  // claude.reply / claude.status are things the relay pushes down, not methods
  // the bridge requested. Returns false if no matching bridge is connected.
  notifyBridge({ capabilitySet, method, params }) {
    const bridge = this.findBridge({ capabilitySet });
    if (!bridge) return false;
    bridge.send({ jsonrpc: '2.0', method, params });
    this.audit.log('notify.out', { sessionId: bridge.sessionId, method });
    return true;
  }

  // Called by ws-server when a bridge sends back a JSON-RPC response.
  resolveResponse(message) {
    const id = message.id;
    if (id == null) return false;
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (message.error) {
      const err = new Error(message.error.message || 'bridge error');
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

  // Called by ws-server when a bridge sends a notification (no id).
  routeNotification(message) {
    const subs = this.subscribers.get(message.method);
    if (!subs || subs.size === 0) return;
    this.audit.log('notify', { method: message.method, subscribers: subs.size });
    for (const fn of subs) {
      try { fn(message.params); } catch (err) {
        console.error(`[dispatcher] subscriber for ${message.method} threw:`, err);
      }
    }
  }

  subscribe(method, fn) {
    if (!this.subscribers.has(method)) this.subscribers.set(method, new Set());
    this.subscribers.get(method).add(fn);
    return () => this.subscribers.get(method)?.delete(fn);
  }
}
