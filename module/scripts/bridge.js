// Bridge module entry: settings, WS client, handler dispatch.
import { WsClient } from './ws-client.js';
import { LogTap } from './log-tap.js';
import { CHAT_MACRO_COMMAND } from './chat-macro.js';

import { handlePing } from './handlers/ping.js';
import { handleQueryActor } from './handlers/query-actor.js';
import { handleQueryScene } from './handlers/query-scene.js';
import { handleQueryMacro } from './handlers/query-macro.js';
import { handleQueryJournal } from './handlers/query-journal.js';
import { handleQueryUser } from './handlers/query-user.js';
import { handleLogsSubscribe, handleLogsUnsubscribe } from './handlers/logs.js';
import { handleEval } from './handlers/eval.js';
import { handleDamage } from './handlers/damage.js';
import { WORKSHOP_MACRO_COMMAND } from './ide-macro.js';

const MODULE_ID = 'foundry-bridge';
const MODULE_VERSION = '0.5.0';
const CHAT_MACRO_NAME = 'Open Claude Code Chat';
const WORKSHOP_MACRO_NAME = 'Claude Macro Workshop';

let client = null, logTap = null;

// Subscriber sets survive WS reconnects (client is rebuilt).
const replySubs = new Set(), statusSubs = new Set(), confirmSubs = new Set(), refactorSubs = new Set();
let refactorProvider = null, lastRefactor = null;

const HANDLERS = {
  'ping': handlePing,
  'query.actor': handleQueryActor,
  'query.scene': handleQueryScene,
  'query.macro': handleQueryMacro,
  'query.journal': handleQueryJournal,
  'query.user': handleQueryUser,
  'logs.subscribe': handleLogsSubscribe,
  'logs.unsubscribe': handleLogsUnsubscribe,
  'eval': handleEval,
  'damage': handleDamage,
  'refactor.get': () => (refactorProvider ? refactorProvider() : { open: false }), // live box, not a cache
};

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'enabled', {
    name: 'FOUNDRY_BRIDGE.SETTINGS.Enabled.Name',
    hint: 'FOUNDRY_BRIDGE.SETTINGS.Enabled.Hint',
    scope: 'client',
    config: true,
    type: Boolean,
    default: false,
    onChange: (value) => onEnabledChange(value),
  });

  game.settings.register(MODULE_ID, 'relayUrl', {
    name: 'FOUNDRY_BRIDGE.SETTINGS.RelayUrl.Name',
    hint: 'FOUNDRY_BRIDGE.SETTINGS.RelayUrl.Hint',
    scope: 'client',
    config: true,
    type: String,
    default: 'ws://127.0.0.1:7878',
  });
});

Hooks.once('ready', () => {
  // Tiny in-world debug API for a macro:
  //   game.modules.get('foundry-bridge').api.status()
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      status: () => ({
        enabled: game.settings.get(MODULE_ID, 'enabled'),
        connected: !!client && client.isOpen(),
        relayUrl: game.settings.get(MODULE_ID, 'relayUrl'),
        moduleVersion: MODULE_VERSION,
      }),
      restart: () => {
        stopClient();
        if (game.settings.get(MODULE_ID, 'enabled')) startClient();
      },
      isConnected: () => !!client && client.isOpen(),
      sendPrompt: (text) => {
        if (!client || !client.isOpen()) return null;
        const promptId = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const ok = client.send({ jsonrpc: '2.0', method: 'claude.prompt', params: { promptId, text } });
        return ok ? promptId : null;
      },
      requestStatus: () => {
        if (client && client.isOpen()) client.send({ jsonrpc: '2.0', method: 'claude.hello', params: {} });
      },
      onReply: (cb) => { replySubs.add(cb); return () => replySubs.delete(cb); },
      onStatus: (cb) => { statusSubs.add(cb); return () => statusSubs.delete(cb); },
      onConfirm: (cb) => { confirmSubs.add(cb); return () => confirmSubs.delete(cb); },
      sendConfirmResult: (opId, approved, reason) => {
        if (client && client.isOpen()) {
          client.send({ jsonrpc: '2.0', method: 'claude.confirm.result', params: { opId, approved: !!approved, reason } });
        }
      },
      onRefactorSet: (cb) => { refactorSubs.add(cb); return () => refactorSubs.delete(cb); },
      setRefactorProvider: (fn) => { refactorProvider = (typeof fn === 'function') ? fn : null; },
      getLastRefactor: () => lastRefactor,
    };
  }

  ensureMacro(CHAT_MACRO_NAME, CHAT_MACRO_COMMAND, 'icons/svg/chat.svg');
  ensureMacro(WORKSHOP_MACRO_NAME, WORKSHOP_MACRO_COMMAND, 'icons/svg/book.svg');

  if (game.settings.get(MODULE_ID, 'enabled')) {
    startClient();
  } else {
    console.log('[foundry-bridge] disabled in settings; not connecting.');
  }
});

// GM-only, idempotent; refresh only our autoMacro copies.
async function ensureMacro(name, command, img) {
  try {
    if (!game.user?.isGM) return;
    const existing = game.macros.getName(name);
    if (existing) {
      if (existing.getFlag(MODULE_ID, 'autoMacro') && existing.command !== command) {
        await existing.update({ command });
        console.log(`[foundry-bridge] refreshed macro "${name}"`);
      }
      return;
    }
    await Macro.create({
      name, type: 'script', scope: 'global', img, command,
      flags: { [MODULE_ID]: { autoMacro: true } },
    });
    console.log(`[foundry-bridge] created macro "${name}"`);
  } catch (err) {
    console.error(`[foundry-bridge] failed to ensure macro "${name}":`, err);
  }
}

function startClient() {
  if (client) return;

  // Install log tap before connect; cheap without subscribers.
  if (!logTap) {
    logTap = new LogTap();
    logTap.install();
  }

  const url = game.settings.get(MODULE_ID, 'relayUrl');
  client = new WsClient({
    url,
    onOpen: onConnected,
    onClose: onDisconnected,
    onMessage: onMessage,
  });
  client.start();
}

function stopClient() {
  if (!client) return;
  client.stop();
  client = null;
  if (logTap) {
    logTap.uninstall();
    logTap = null;
  }
}

function onEnabledChange(enabled) {
  if (enabled) startClient();
  else stopClient();
}

function onConnected() {
  const helloId = `hello-${Date.now()}`;
  client.send({
    jsonrpc: '2.0',
    method: 'hello',
    params: {
      userId: game.user.id,
      userName: game.user.name,
      isGM: !!game.user.isGM,
      worldId: game.world.id,
      foundryVersion: game.version,
      moduleVersion: MODULE_VERSION,
    },
    id: helloId,
  });
  ui.notifications?.info(game.i18n.localize('FOUNDRY_BRIDGE.NOTIFY.Connected'));
}

function onDisconnected(info) {
  ui.notifications?.warn(game.i18n.localize('FOUNDRY_BRIDGE.NOTIFY.Disconnected'));
  console.log(`[foundry-bridge] disconnected: ${info?.reason || ''} (code ${info?.code || ''})`);
}

// Fan out to subscribers; label logs a thrower.
function fanout(subs, payload, label) {
  for (const fn of subs) {
    try { fn(payload); } catch (err) { if (label) console.error(`[foundry-bridge] ${label} subscriber threw:`, err); }
  }
}

async function onMessage(msg) {
  // Hello response from relay.
  if (typeof msg.id === 'string' && msg.id.startsWith('hello-')) {
    if (msg.error) {
      console.error('[foundry-bridge] relay refused hello:', msg.error);
      ui.notifications?.error(game.i18n.localize('FOUNDRY_BRIDGE.NOTIFY.Refused'));
    } else if (msg.result) {
      console.log(`[foundry-bridge] relay assigned sessionId=${msg.result.sessionId}, capabilitySet=${msg.result.capabilitySet}`);
    }
    return;
  }

  // Relay -> bridge notification (no id): Phase 2 chat channel.
  if (msg.method && msg.id == null) {
    if (msg.method === 'claude.reply') {
      if (replySubs.size === 0) {
        ui.notifications?.info(game.i18n.localize('FOUNDRY_BRIDGE.CHAT.ReplyWhileClosed'));
      } else {
        fanout(replySubs, msg.params || {}, 'reply');
      }
      return;
    }
    if (msg.method === 'claude.status') {
      fanout(statusSubs, msg.params || {}, null); // status is best-effort
      return;
    }
    if (msg.method === 'claude.confirm') {
      const p = msg.params || {};
      // No chat box: auto-deny so Claude isn't stuck on timeout.
      if (confirmSubs.size === 0) {
        client.send({ jsonrpc: '2.0', method: 'claude.confirm.result',
          params: { opId: p.opId, approved: false, reason: 'chat-box-closed' } });
      } else {
        fanout(confirmSubs, p, 'confirm');
      }
      return;
    }
    if (msg.method === 'claude.refactor.set') {
      const p = msg.params || {};
      lastRefactor = { content: p.content ?? '', macroId: p.macroId ?? null, macroName: p.macroName ?? null };
      if (refactorSubs.size === 0) {
        ui.notifications?.info(game.i18n.localize('FOUNDRY_BRIDGE.WORKSHOP.PushedClosed'));
      } else {
        fanout(refactorSubs, lastRefactor, 'refactor');
      }
      return;
    }
    return; // unknown notification - ignore
  }

  // Inbound command request (relay -> bridge).
  if (msg.method && msg.id != null) {
    const handler = HANDLERS[msg.method];
    if (!handler) {
      client.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method "${msg.method}"` } });
      return;
    }
    const ctx = {
      client,
      send: (n) => client.send(n),
      logTap,
    };
    try {
      const result = await handler(msg.params || {}, ctx);
      client.send({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      client.send({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: err?.code ?? -33002,
          message: err?.message || String(err),
          data: err?.stack ? { stack: err.stack } : undefined,
        },
      });
    }
  }
  // Responses to our own requests are ignored (Phase 1 sends none).
}
