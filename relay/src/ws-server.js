// WS server for the in-Foundry bridge. Hello first, then work.

import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

// Set name -> allowed methods. DESIGN.md §5.1 is truth - keep in sync.
const CAPABILITY_SETS = {
  debug: new Set([
    'ping',
    'query.actor',
    'query.scene',
    'query.macro',
    'query.journal',
    'query.user',
    'logs.subscribe',
    'logs.unsubscribe',
    'eval', // reads free; writes gated; HP/DB-journal refused (eval-guard.js)
    'damage', // constrained HP primitive, absolute >=1 HP floor
    'refactor.get', // Workshop's live editor content
  ]),
  // 'aagm' set arrives in Phase 3.
};

export function startWsServer({ config, dispatcher, audit }) {
  const { host, port } = config.ws;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`refusing to bind WS server to non-localhost address "${host}"`);
  }
  const wss = new WebSocketServer({ host, port });
  wss.on('listening', () => {
    console.log(`[ws] listening on ws://${host}:${port}`);
  });
  wss.on('connection', (socket, req) => handleConnection(socket, req, { config, dispatcher, audit }));

  return {
    close: () => wss.close(),
    server: wss,
  };
}

function handleConnection(socket, req, { config, dispatcher, audit }) {
  const remote = req.socket.remoteAddress;
  if (remote && !isLoopback(remote)) { // belt to the bind's suspenders
    audit.log('ws.reject_nonlocal', { remote });
    socket.close(4003, 'non-localhost');
    return;
  }

  let sessionId = null, userId = null, helloSeen = false;

  const send = (msg) => {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(msg));
    } catch (err) {
      console.error('[ws] send failed:', err);
    }
  };

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null });
      return;
    }

    if (!helloSeen) {
      if (msg.method !== 'hello') {
        send({ jsonrpc: '2.0', error: { code: -33003, message: 'expected hello first' }, id: msg.id ?? null });
        socket.close(4000, 'expected hello');
        return;
      }
      const result = validateHello(msg, { config, dispatcher, audit });
      if (!result.ok) {
        send({ jsonrpc: '2.0', error: { code: -33003, message: result.reason }, id: msg.id ?? null });
        socket.close(result.closeCode, result.reason);
        return;
      }
      helloSeen = true;
      sessionId = result.sessionId;
      userId = result.userId;
      // Metadata validated + send closure bound: register.
      dispatcher.registerBridge({
        sessionId,
        userId,
        userName: result.userName,
        capabilitySet: result.capabilitySet,
        capabilities: result.capabilities,
        auditLogging: result.auditLogging,
        foundryVersion: result.foundryVersion,
        moduleVersion: result.moduleVersion,
        worldId: result.worldId,
        isGM: result.isGM,
        send,
      });
      send({
        jsonrpc: '2.0',
        result: { sessionId, capabilitySet: result.capabilitySet, auditLogging: result.auditLogging },
        id: msg.id ?? null,
      });
      return;
    }

    // Post-hello: a response to us, or a notification.
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      dispatcher.resolveResponse(msg);
    } else if (msg.method) {
      dispatcher.routeNotification(msg);
    }
  });

  socket.on('close', (code, reasonBuf) => {
    const reason = reasonBuf?.toString?.() || '';
    if (sessionId) dispatcher.unregisterBridge(sessionId, `socket close ${code} ${reason}`);
    audit.log('ws.close', { sessionId, userId, code, reason });
  });

  socket.on('error', (err) => {
    audit.log('ws.error', { sessionId, userId, message: err.message });
  });
}

function validateHello(msg, { config, dispatcher, audit }) {
  const params = msg.params || {};
  const userId = params.userId;
  const userName = params.userName;
  if (!userId) {
    audit.log('hello.reject', { reason: 'missing userId' });
    return { ok: false, reason: 'missing userId', closeCode: 4001 };
  }
  const userCfg = config.users?.[userId];
  if (!userCfg) {
    audit.log('hello.reject', { reason: 'unknown userId', userId, userName });
    return { ok: false, reason: 'no capability set for userId', closeCode: 4001 };
  }
  const capabilitySet = userCfg.capabilitySet;
  const caps = CAPABILITY_SETS[capabilitySet];
  if (!caps) {
    audit.log('hello.reject', { reason: 'unknown capability set', userId, capabilitySet });
    return { ok: false, reason: `capability set "${capabilitySet}" is not defined`, closeCode: 4001 };
  }

  // One connection per userId (alignment-phase rule).
  for (const rec of dispatcher.bridges.values()) {
    if (rec.userId === userId) {
      audit.log('hello.reject', { reason: 'duplicate userId', userId, existingSessionId: rec.sessionId });
      return { ok: false, reason: 'duplicate-session', closeCode: 4002 };
    }
  }

  return {
    ok: true,
    sessionId: `sess-${randomUUID()}`,
    userId,
    userName: userName || userCfg.userName || userId,
    capabilitySet,
    capabilities: caps,
    auditLogging: capabilitySet === 'aagm',
    foundryVersion: params.foundryVersion,
    moduleVersion: params.moduleVersion,
    worldId: params.worldId,
    isGM: !!params.isGM,
  };
}

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}
