// Foundry-Claude Bridge - main module entry. Registers settings, opens (when
// enabled) a WebSocket connection to the local relay, dispatches inbound
// JSON-RPC requests through the handler set, and emits outbound notifications
// (e.g. logs.entry) when the relay subscribes.

import { WsClient } from './ws-client.js';
import { LogTap } from './log-tap.js';
import { CHAT_MACRO_COMMAND } from './chat-macro.js';
import { registerModeSettings, settingsSnapshot } from './settings-def.js';
import { AagmSettingsMenu } from './settings-menu.js';

import { handlePing } from './handlers/ping.js';
import { handleQueryActor } from './handlers/query-actor.js';
import { handleQueryScene } from './handlers/query-scene.js';
import { handleQueryMacro } from './handlers/query-macro.js';
import { handleQueryJournal } from './handlers/query-journal.js';
import { handleQueryUser } from './handlers/query-user.js';
import { handleLogsSubscribe, handleLogsUnsubscribe } from './handlers/logs.js';
import { handleEval } from './handlers/eval.js';
import { handleDamage } from './handlers/damage.js';
import { handleLootPending, handleLootRestore } from './handlers/loot.js';

const MODULE_ID = 'foundry-bridge';
const MODULE_VERSION = '0.8.2';
const CHAT_MACRO_NAME = 'Open Claude Code Chat';

let client = null;
let logTap = null;
let wasConnected = false;

// Phase 2 chat channel: the auto-created macro's Dialog registers here so it
// receives relay -> bridge `claude.reply` / `claude.status` notifications.
// Module-scoped so they survive WS reconnects (client is rebuilt; these aren't).
const replySubs = new Set();
const statusSubs = new Set();
// DESIGN §9 confirmation gate: the chat box registers here to render
// claude.confirm cards and send the human's decision back.
const confirmSubs = new Set();
// §13.3 chain grant/gate/end events for the box.
const chainSubs = new Set();

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
  // Claude Loot Watchdog rescue queue (the only allowed path to that journal).
  'loot.pending': handleLootPending,
  'loot.restore': handleLootRestore,
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

  // §13.1 hidden world settings + sanctioned submenu.
  registerModeSettings();
  game.settings.registerMenu(MODULE_ID, 'aagmSettings', {
    name: 'FOUNDRY_BRIDGE.SETTINGS.MenuName',
    label: 'FOUNDRY_BRIDGE.SETTINGS.MenuLabel',
    hint: 'FOUNDRY_BRIDGE.SETTINGS.MenuHint',
    icon: 'fas fa-robot',
    type: AagmSettingsMenu,
    restricted: true,
  });
});

Hooks.once('ready', () => {
  // The bridge is a GM-only surface. Players must never connect to (or even
  // notice) the relay - no api, no macros, no WS client, no notifications.
  if (!game.user.isGM) return;

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
      onChain: (cb) => { chainSubs.add(cb); return () => chainSubs.delete(cb); },
      sendConfirmResult: (opId, approved, reason) => {
        if (client && client.isOpen()) {
          client.send({ jsonrpc: '2.0', method: 'claude.confirm.result', params: { opId, approved: !!approved, reason } });
        }
      },
      cancelChain: (chainId) => {
        if (client && client.isOpen()) {
          client.send({ jsonrpc: '2.0', method: 'claude.chain.cancel', params: { chainId } });
        }
      },
      syncSettings: () => {
        if (client && client.isOpen()) {
          client.send({ jsonrpc: '2.0', method: 'settings.sync', params: settingsSnapshot() });
        }
      },
    };
  }

  ensureMacro(CHAT_MACRO_NAME, CHAT_MACRO_COMMAND, 'icons/svg/chat.svg');

  if (game.settings.get(MODULE_ID, 'enabled')) {
    startClient();
  } else {
    console.log('[foundry-bridge] disabled in settings; not connecting.');
  }
});

// The module provisions its GUI macros itself. GM-only (players don't drive
// Claude Code), idempotent by name so a reload doesn't pile up copies. The
// command body is kept in sync on reload, but only for macros WE created
// (autoMacro flag) - never a hand-rolled macro that merely shares the name.
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
  // 'enabled' is client-scoped (localStorage), so a player logging in on a
  // browser where a GM once enabled the bridge would otherwise start it.
  if (!game.user?.isGM) return;

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
  wasConnected = true;
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
      settings: settingsSnapshot(),
    },
    id: helloId,
  });
  ui.notifications?.info(game.i18n.localize('FOUNDRY_BRIDGE.NOTIFY.Connected'));
}

function onDisconnected(info) {
  // Every failed reconnect attempt also lands here; toasting each backoff
  // tick is spam. Only a real drop of an established connection notifies.
  if (wasConnected) {
    ui.notifications?.warn(game.i18n.localize('FOUNDRY_BRIDGE.NOTIFY.Disconnected'));
  }
  wasConnected = false;
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
    if (msg.method === 'claude.chain') {
      for (const fn of chainSubs) {
        try { fn(msg.params || {}); } catch (err) { /* progress is best-effort */ }
      }
      return;
    }
    if (msg.method === 'claude.listener.refused') {
      // §13.2 lock tripped: a second loop tried to drain the box. Toast so
      // it is visible whether or not the box is open.
      ui.notifications?.warn(game.i18n.localize('FOUNDRY_BRIDGE.NOTIFY.SecondListener'));
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
  // Anything else (responses to requests we sent - Phase 1 doesn't initiate any) is ignored.
}
