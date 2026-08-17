/* Settings, WebSocket, and handler entry. */
import { WsClient } from './ws-client.js';
import { LogTap } from './log-tap.js';
import { CHAT_MACRO_COMMAND } from './chat-macro.js';
import { LOOT_MACRO_COMMAND } from './loot-macro.js';
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
import { handleMirrorList, handleMirrorRestore } from './handlers/mirror.js';

const MODULE_ID = 'aagm-o';
const CHAT_MACRO_NAME = 'Open AAGM-O Chat';
const LOOT_MACRO_NAME = 'AAGM-O Loot Watchdog';

let client = null, logTap = null, wasConnected = false;

/* Subscribers survive rebuilt WebSocket clients. */
const replySubs = new Set(), statusSubs = new Set(), confirmSubs = new Set(), chainSubs = new Set();

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
  'loot.pending': handleLootPending,
  'loot.restore': handleLootRestore,
  'mirror.list': handleMirrorList,
  'mirror.restore': handleMirrorRestore,
};

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'enabled', {
    name: 'AAGM_O.SETTINGS.Enabled.Name',
    hint: 'AAGM_O.SETTINGS.Enabled.Hint',
    scope: 'client',
    config: true,
    type: Boolean,
    default: false,
    onChange: (value) => onEnabledChange(value),
  });

  game.settings.register(MODULE_ID, 'relayUrl', {
    name: 'AAGM_O.SETTINGS.RelayUrl.Name',
    hint: 'AAGM_O.SETTINGS.RelayUrl.Hint',
    scope: 'client',
    config: true,
    type: String,
    default: 'ws://127.0.0.1:7888',
  });

  registerModeSettings();
  game.settings.registerMenu(MODULE_ID, 'aagmSettings', {
    name: 'AAGM_O.SETTINGS.MenuName',
    label: 'AAGM_O.SETTINGS.MenuLabel',
    hint: 'AAGM_O.SETTINGS.MenuHint',
    icon: 'fas fa-robot',
    type: AagmSettingsMenu,
    restricted: true,
  });
});

Hooks.once('ready', () => {
  if (!game.user.isGM) return;
  /* Module API supports macros and diagnostics. */
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = {
      status: () => ({
        enabled: game.settings.get(MODULE_ID, 'enabled'),
        connected: !!client && client.isOpen(),
        relayUrl: game.settings.get(MODULE_ID, 'relayUrl'),
        moduleVersion: mod.version,
      }),
      restart: () => {
        stopClient();
        if (game.settings.get(MODULE_ID, 'enabled')) startClient();
      },
      isConnected: () => !!client && client.isOpen(),
      sendPrompt: (text) => {
        if (!client || !client.isOpen()) return null;
        const promptId = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const ok = client.send({ jsonrpc: '2.0', method: 'aagm.prompt', params: { promptId, text } });
        return ok ? promptId : null;
      },
      requestStatus: () => {
        if (client && client.isOpen()) client.send({ jsonrpc: '2.0', method: 'aagm.status.request', params: {} });
      },
      onReply: (cb) => { replySubs.add(cb); return () => replySubs.delete(cb); },
      onStatus: (cb) => { statusSubs.add(cb); return () => statusSubs.delete(cb); },
      onConfirm: (cb) => { confirmSubs.add(cb); return () => confirmSubs.delete(cb); },
      onChain: (cb) => { chainSubs.add(cb); return () => chainSubs.delete(cb); },
      sendConfirmResult: (opId, approved, reason) => {
        if (client && client.isOpen()) {
          client.send({ jsonrpc: '2.0', method: 'aagm.confirm.result', params: { opId, approved: !!approved, reason } });
        }
      },
      syncSettings: () => {
        if (client && client.isOpen()) {
          client.send({ jsonrpc: '2.0', method: 'settings.sync', params: settingsSnapshot() });
        }
      },
      cancelChain: (chainId) => {
        if (client && client.isOpen()) {
          client.send({ jsonrpc: '2.0', method: 'aagm.chain.cancel', params: { chainId } });
        }
      },
    };
  }

  ensureMacro(CHAT_MACRO_NAME, CHAT_MACRO_COMMAND, 'icons/svg/chat.svg');
  ensureMacro(LOOT_MACRO_NAME, LOOT_MACRO_COMMAND, 'icons/svg/chest.svg');

  if (game.settings.get(MODULE_ID, 'enabled')) {
    startClient();
  } else {
    console.log('[aagm-o] disabled in settings; not connecting.');
  }
});

/* Refresh only owned automatic macros. */
async function ensureMacro(name, command, img) {
  try {
    if (!game.user?.isGM) return;
    const existing = game.macros.getName(name);
    if (existing) {
      if (existing.getFlag(MODULE_ID, 'autoMacro') && existing.command !== command) {
        await existing.update({ command });
        console.log(`[aagm-o] refreshed macro "${name}"`);
      }
      return;
    }
    await Macro.create({
      name, type: 'script', scope: 'global', img, command,
      flags: { [MODULE_ID]: { autoMacro: true } },
    });
    console.log(`[aagm-o] created macro "${name}"`);
  } catch (err) {
    console.error(`[aagm-o] failed to ensure macro "${name}":`, err);
  }
}

function startClient() {
  if (client) return;
  if (!game.user?.isGM) return;

  /* Install logging before connection. */
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
      moduleVersion: game.modules.get(MODULE_ID)?.version ?? '0.2.0',
      settings: settingsSnapshot(),
    },
    id: helloId,
  });
  ui.notifications?.info(game.i18n.localize('AAGM_O.NOTIFY.Connected'));
}

function onDisconnected(info) {
  if (wasConnected) ui.notifications?.warn(game.i18n.localize('AAGM_O.NOTIFY.Disconnected'));
  wasConnected = false;
  console.log(`[aagm-o] disconnected: ${info?.reason || ''} (code ${info?.code || ''})`);
}

/* Notify subscribers and isolate failures. */
function fanout(subs, payload, label) {
  for (const fn of subs) {
    try { fn(payload); } catch (err) { if (label) console.error(`[aagm-o] ${label} subscriber threw:`, err); }
  }
}

async function onMessage(msg) {
  /* Handle the relay handshake. */
  if (typeof msg.id === 'string' && msg.id.startsWith('hello-')) {
    if (msg.error) {
      console.error('[aagm-o] relay refused hello:', msg.error);
      ui.notifications?.error(game.i18n.localize('AAGM_O.NOTIFY.Refused'));
    } else if (msg.result) {
      console.log(`[aagm-o] relay assigned sessionId=${msg.result.sessionId}, capabilitySet=${msg.result.capabilitySet}`);
    }
    return;
  }

  /* Handle relay notifications. */
  if (msg.method && msg.id == null) {
    if (msg.method === 'aagm.reply') {
      if (replySubs.size === 0) {
        ui.notifications?.info(game.i18n.localize('AAGM_O.CHAT.ReplyWhileClosed'));
      } else {
        fanout(replySubs, msg.params || {}, 'reply');
      }
      return;
    }
    if (msg.method === 'aagm.status') {
      fanout(statusSubs, msg.params || {}, null); // status is best-effort
      return;
    }
    if (msg.method === 'aagm.listener.refused') {
      ui.notifications?.warn(game.i18n.localize('AAGM_O.NOTIFY.SecondListener'));
      return;
    }
    if (msg.method === 'aagm.chain') {
      fanout(chainSubs, msg.params || {}, null);
      return;
    }
    if (msg.method === 'aagm.confirm') {
      const p = msg.params || {};
      /* Missing chat boxes deny writes. */
      if (confirmSubs.size === 0) {
        client.send({ jsonrpc: '2.0', method: 'aagm.confirm.result',
          params: { opId: p.opId, approved: false, reason: 'chat-box-closed' } });
      } else {
        fanout(confirmSubs, p, 'confirm');
      }
      return;
    }
    return; // unknown notification - ignore
  }

  /* Handle relay command requests. */
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
  /* Local request responses need no action. */
}
