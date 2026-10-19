// Module entry: settings, relay socket, handlers.

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
import { handleRollbackApply } from './handlers/rollback.js';
import { installRecorder, runRecorded } from './rollback-recorder.js';

const MODULE_ID = 'foundry-bridge';
const MODULE_VERSION = '2.0.0';
const CHAT_MACRO_NAME = 'Open Claude Code Chat';

let client = null, logTap = null, wasConnected = false;

const isUp = () => !!client && client.isOpen();
const sendOpen = (method, params) => { if (isUp()) client.send({ jsonrpc: '2.0', method, params }); }; // sends if open

// Phase 2: reply/status subs registered here, survive reconnects
const replySubs = new Set(), statusSubs = new Set();
// §9 gate: box renders cards, sends decision here
const confirmSubs = new Set();
// §13.3 chain grant/gate/end events for the box.
const chainSubs = new Set();
// §14 tab table pushes (claude.tabs) for the box.
const tabsSubs = new Set();
// 2.0 Rollback Point pushes (claude.rollback) for the box.
const rollbackSubs = new Set();

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
  // Loot Watchdog: only allowed path to that journal
  'loot.pending': handleLootPending,
  'loot.restore': handleLootRestore,
  'rollback.apply': handleRollbackApply,
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
  // GM-only surface; players must never see or connect
  if (!game.user.isGM) return; // player returns, GM continues
  installRecorder();

  // Tiny in-world debug API, e.g. from a macro:
  // game.modules.get('foundry-bridge').api.status()
  const mod = game.modules.get(MODULE_ID);
  if (mod) { // module found gets api
    mod.api = {
      status: () => ({
        enabled: game.settings.get(MODULE_ID, 'enabled'),
        connected: isUp(),
        relayUrl: game.settings.get(MODULE_ID, 'relayUrl'),
        moduleVersion: MODULE_VERSION,
      }),
      restart: () => {
        stopClient();
        if (game.settings.get(MODULE_ID, 'enabled')) startClient(); // enabled restarts client, else stays stopped
      },
      isConnected: isUp,
      sendPrompt: (text, tabId) => {
        if (!isUp()) return null; // closed socket returns null
        const promptId = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const ok = client.send({ jsonrpc: '2.0', method: 'claude.prompt', params: { promptId, text, tabId } });
        return ok ? promptId : null;
      },
      // §14: close rides prompt path, loop can't miss
      closeTab: (tabId) => {
        if (!isUp()) return; // closed socket returns, open continues
        const promptId = `close-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        client.send({ jsonrpc: '2.0', method: 'claude.prompt', params: { promptId, text: '/close', tabId } });
      },
      requestStatus: () => sendOpen('claude.hello', {}),
      onReply: (cb) => { replySubs.add(cb); return () => replySubs.delete(cb); },
      onStatus: (cb) => { statusSubs.add(cb); return () => statusSubs.delete(cb); },
      onConfirm: (cb) => { confirmSubs.add(cb); return () => confirmSubs.delete(cb); },
      onChain: (cb) => { chainSubs.add(cb); return () => chainSubs.delete(cb); },
      onTabs: (cb) => { tabsSubs.add(cb); return () => tabsSubs.delete(cb); },
      onRollback: (cb) => { rollbackSubs.add(cb); return () => rollbackSubs.delete(cb); },
      rollbackTo: (pointId) => sendOpen('claude.rollback.request', { pointId }),
      sendConfirmResult: (opId, approved, reason) => sendOpen('claude.confirm.result', { opId, approved: !!approved, reason }),
      cancelChain: (chainId) => sendOpen('claude.chain.cancel', { chainId }),
      syncSettings: () => { if (isUp()) sendOpen('settings.sync', settingsSnapshot()); }, // open socket syncs settings
    };
  }

  ensureMacro(CHAT_MACRO_NAME, CHAT_MACRO_COMMAND, 'icons/svg/chat.svg');

  if (game.settings.get(MODULE_ID, 'enabled')) { // enabled connects, else logs
    startClient();
  } else { // disabled logs and skips connect
    console.log('[foundry-bridge] disabled in settings; not connecting.');
  }
});

// Idempotent by name; only resyncs macros flagged autoMacro
async function ensureMacro(name, command, img) {
  try {
    if (!game.user?.isGM) return; // non GM returns, GM continues
    const existing = game.macros.getName(name);
    if (existing) { // found macro checked, missing gets created
      if (existing.getFlag(MODULE_ID, 'autoMacro') && existing.command !== command) { // stale autoMacro updated, else left alone
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
  if (client) return; // running client returns, else starts
  // enabled is per-browser; guards stale GM setting
  if (!game.user?.isGM) return; // non GM returns, GM continues

  // Install log tap before connecting, catches reconnect output
  if (!logTap) { // first start installs tap
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
  if (!client) return; // no client returns, else stops
  client.stop();
  client = null;
  if (logTap) { // tap present is uninstalled
    logTap.uninstall();
    logTap = null;
  }
}

function onEnabledChange(enabled) {
  if (enabled) startClient(); // on starts client
  else stopClient(); // off stops client
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
  // Only a real drop notifies; retries stay silent
  if (wasConnected) { // real drop warns, retry stays silent
    ui.notifications?.warn(game.i18n.localize('FOUNDRY_BRIDGE.NOTIFY.Disconnected'));
  }
  wasConnected = false;
  console.log(`[foundry-bridge] disconnected: ${info?.reason || ''} (code ${info?.code || ''})`);
}

async function onMessage(msg) {
  // Hello response from relay.
  if (typeof msg.id === 'string' && msg.id.startsWith('hello-')) { // hello reply handled, others fall through
    if (msg.error) { // refusal logs and toasts error
      console.error('[foundry-bridge] relay refused hello:', msg.error);
      ui.notifications?.error(game.i18n.localize('FOUNDRY_BRIDGE.NOTIFY.Refused'));
    } else if (msg.result) { // result logs session, empty ignored
      console.log(`[foundry-bridge] relay assigned sessionId=${msg.result.sessionId}, capabilitySet=${msg.result.capabilitySet}`);
    }
    return;
  }

  // Relay to bridge notification: Phase 2 chat channel
  if (msg.method && msg.id == null) { // notification dispatched, requests fall through
    switch (msg.method) { // notification routed, unknown ignored
      case 'claude.reply':
        if (replySubs.size === 0) { // no box toasts, else fans out
          ui.notifications?.info(game.i18n.localize('FOUNDRY_BRIDGE.CHAT.ReplyWhileClosed'));
        } else { // box open gets reply
          fanout(replySubs, msg.params || {}, 'reply');
        }
        return;
      case 'claude.status':
        fanout(statusSubs, msg.params || {}); // status is best-effort
        return;
      case 'claude.chain':
        fanout(chainSubs, msg.params || {}); // progress is best-effort
        return;
      case 'claude.tabs':
        fanout(tabsSubs, msg.params || {}); // table resync is best-effort
        return;
      case 'claude.rollback':
        fanout(rollbackSubs, msg.params || {}); // point list is best-effort
        return;
      case 'claude.listener.refused':
        // §13.2 lock tripped: toast regardless of box state
        ui.notifications?.warn(game.i18n.localize('FOUNDRY_BRIDGE.NOTIFY.SecondListener'));
        return;
      case 'claude.confirm': {
        const p = msg.params || {};
        // No box open: auto-deny; never default writes open
        if (confirmSubs.size === 0) { // no box denies, else fans out
          client.send({ jsonrpc: '2.0', method: 'claude.confirm.result',
            params: { opId: p.opId, approved: false, reason: 'chat-box-closed' } });
        } else { // box open gets card
          fanout(confirmSubs, p, 'confirm');
        }
        return;
      }
      default:
        return; // unknown notification - ignore
    }
  }

  // Inbound command request (relay -> bridge).
  if (msg.method && msg.id != null) { // request runs handler, else ignored
    const handler = HANDLERS[msg.method];
    if (!handler) { // unknown method errors -32601
      client.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method "${msg.method}"` } });
      return;
    }
    const ctx = {
      client,
      send: (n) => client.send(n),
      logTap,
    };
    const params = msg.params || {};
    const rp = params.rp?.id ? params.rp : null;
    try {
      let result;
      if (rp) { // rollback point records, else plain
        const { result: r, entries } = await runRecorded(rp, () => handler(params, ctx));
        const rollback = { entries };
        result = isPlain(r) ? { ...r, rollback } : { value: r, rollback };
      } else { // no point runs handler bare
        result = await handler(params, ctx);
      }
      client.send({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      const data = err?.stack ? { stack: err.stack } : undefined;
      client.send({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: err?.code ?? -33002,
          message: err?.message || String(err),
          data: rp ? { ...data, rollback: { entries: err?.rollbackEntries || [] } } : data,
        },
      });
    }
  }
  // Anything else is ignored; Phase 1 never initiates
}

function isPlain(v) { return Object.prototype.toString.call(v) === '[object Object]'; }

// Runs subscribers; logs failures only when labeled.
function fanout(subs, params, label) {
  for (const fn of subs) { // each subscriber called once
    try { fn(params); } catch (err) { if (label) console.error(`[foundry-bridge] ${label} subscriber threw:`, err); } // labeled failures log, others silent
  }
}
