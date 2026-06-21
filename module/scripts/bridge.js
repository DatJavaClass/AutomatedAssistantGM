// Foundry-Claude Bridge — main module entry. Registers settings, opens (when
// enabled) a WebSocket connection to the local relay, dispatches inbound
// JSON-RPC requests through the handler set, and emits outbound notifications
// (e.g. logs.entry) when the relay subscribes.

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

let client = null;
let logTap = null;

// Phase 2 chat channel: the auto-created macro's Dialog registers here so it
// receives relay -> bridge `claude.reply` / `claude.status` notifications.
// Module-scoped so they survive WS reconnects (client is rebuilt; these aren't).
const replySubs = new Set();
const statusSubs = new Set();
// DESIGN §9 confirmation gate: the chat box registers here to render
// claude.confirm cards and send the human's decision back.
const confirmSubs = new Set();
// Macro Workshop refactor channel: Claude pushes code via `claude.refactor.set`
// (fanned to the Workshop), and reads the box's live ground truth via the
// `refactor.get` handler → the Workshop's registered provider.
const refactorSubs = new Set();
let refactorProvider = null;
let lastRefactor = null;

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
  // Read the Workshop's live box content (ground truth, not a cache).
  'refactor.get': () => (refactorProvider ? refactorProvider() : { open: false }),
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
  // Expose a tiny in-world API for debug from a macro:
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

// The module provisions its GUI macros itself. GM-only (players don't drive
// Claude Code), idempotent by name so a reload doesn't pile up copies. The
// command body is kept in sync on reload, but only for macros WE created
// (autoMacro flag) — never a hand-rolled macro that merely shares the name.
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

  // Install the log tap before connecting so reconnect-time output is captured.
  // The tap is cheap when no subscribers are registered.
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
        for (const fn of replySubs) {
          try { fn(msg.params || {}); } catch (err) { console.error('[foundry-bridge] reply subscriber threw:', err); }
        }
      }
      return;
    }
    if (msg.method === 'claude.status') {
      for (const fn of statusSubs) {
        try { fn(msg.params || {}); } catch (err) { /* status is best-effort */ }
      }
      return;
    }
    if (msg.method === 'claude.confirm') {
      const p = msg.params || {};
      // No open chat box = no human to approve. Auto-deny so Claude isn't left
      // waiting on the relay timeout. (A pending write must never default open.)
      if (confirmSubs.size === 0) {
        client.send({ jsonrpc: '2.0', method: 'claude.confirm.result',
          params: { opId: p.opId, approved: false, reason: 'chat-box-closed' } });
      } else {
        for (const fn of confirmSubs) {
          try { fn(p); } catch (err) { console.error('[foundry-bridge] confirm subscriber threw:', err); }
        }
      }
      return;
    }
    if (msg.method === 'claude.refactor.set') {
      const p = msg.params || {};
      lastRefactor = { content: p.content ?? '', macroId: p.macroId ?? null, macroName: p.macroName ?? null };
      if (refactorSubs.size === 0) {
        ui.notifications?.info(game.i18n.localize('FOUNDRY_BRIDGE.WORKSHOP.PushedClosed'));
      } else {
        for (const fn of refactorSubs) {
          try { fn(lastRefactor); } catch (err) { console.error('[foundry-bridge] refactor subscriber threw:', err); }
        }
      }
      return;
    }
    return; // unknown notification — ignore
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
  // Anything else (responses to requests we sent — Phase 1 doesn't initiate any) is ignored.
}
