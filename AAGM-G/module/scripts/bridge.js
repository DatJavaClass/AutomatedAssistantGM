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
import { handleRollbackApply } from './handlers/rollback.js';
import { installRecorder, runRecorded } from './rollback-recorder.js';

const MODULE_ID = 'aagm-g';
const CHAT_MACRO_NAME = 'Open AAGM-G Chat';
const LOOT_MACRO_NAME = 'AAGM-G Loot Watchdog';

let client = null, logTap = null, wasConnected = false;

/* Subscribers survive rebuilt WebSocket clients. */
const replySubs = new Set(), statusSubs = new Set(), modeSubs = new Set(), rollbackSubs = new Set(), tabsSubs = new Set();

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
  'rollback.apply': handleRollbackApply,
};

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'enabled', {
    name: 'AAGM_G.SETTINGS.Enabled.Name',
    hint: 'AAGM_G.SETTINGS.Enabled.Hint',
    scope: 'client',
    config: true,
    type: Boolean,
    default: false,
    onChange: (value) => onEnabledChange(value),
  });

  game.settings.register(MODULE_ID, 'relayUrl', {
    name: 'AAGM_G.SETTINGS.RelayUrl.Name',
    hint: 'AAGM_G.SETTINGS.RelayUrl.Hint',
    scope: 'client',
    config: true,
    type: String,
    default: 'ws://127.0.0.1:7890',
  });

  registerModeSettings();
  game.settings.registerMenu(MODULE_ID, 'aagmSettings', {
    name: 'AAGM_G.SETTINGS.MenuName',
    label: 'AAGM_G.SETTINGS.MenuLabel',
    hint: 'AAGM_G.SETTINGS.MenuHint',
    icon: 'fas fa-robot',
    type: AagmSettingsMenu,
    restricted: true,
  });
});

Hooks.once('ready', () => {
  if (!game.user.isGM) return; // non GM exits, GM continues
  installRecorder();
  /* Module API supports macros and diagnostics. */
  const mod = game.modules.get(MODULE_ID);
  if (mod) { // module found builds api, else skips
    mod.api = {
      status: () => ({
        enabled: game.settings.get(MODULE_ID, 'enabled'),
        connected: !!client && client.isOpen(),
        relayUrl: game.settings.get(MODULE_ID, 'relayUrl'),
        moduleVersion: mod.version,
      }),
      restart: () => {
        stopClient();
        if (game.settings.get(MODULE_ID, 'enabled')) startClient(); // enabled restarts client, else stays stopped
      },
      isConnected: () => !!client && client.isOpen(),
      sendPrompt: (text, tabId) => {
        if (!client || !client.isOpen()) return null; // no live socket returns null, else sends
        const promptId = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const ok = client.send({ jsonrpc: '2.0', method: 'aagm.prompt', params: { promptId, text, tabId } });
        return ok ? promptId : null;
      },
      closeTab: (tabId) => {
        if (!client || !client.isOpen()) return false; // no live socket returns false, else sends
        return client.send({ jsonrpc: '2.0', method: 'aagm.prompt', params: {
          promptId: `close-${tabId}-${Date.now()}`, text: '/close', tabId,
        } });
      },
      requestStatus: () => {
        if (client && client.isOpen()) client.send({ jsonrpc: '2.0', method: 'aagm.status.request', params: {} }); // open socket requests status, else no-op
      },
      onReply: (cb) => { replySubs.add(cb); return () => replySubs.delete(cb); },
      onStatus: (cb) => { statusSubs.add(cb); return () => statusSubs.delete(cb); },
      onMode: (cb) => { modeSubs.add(cb); return () => modeSubs.delete(cb); },
      onRollback: (cb) => { rollbackSubs.add(cb); return () => rollbackSubs.delete(cb); },
      onTabs: (cb) => { tabsSubs.add(cb); return () => tabsSubs.delete(cb); },
      syncSettings: () => {
        if (client && client.isOpen()) { // open socket syncs settings, else no-op
          client.send({ jsonrpc: '2.0', method: 'settings.sync', params: settingsSnapshot() });
        }
      },
    };
  }

  ensureMacro(CHAT_MACRO_NAME, CHAT_MACRO_COMMAND, 'icons/svg/chat.svg');
  ensureMacro(LOOT_MACRO_NAME, LOOT_MACRO_COMMAND, 'icons/svg/chest.svg');

  if (game.settings.get(MODULE_ID, 'enabled')) { // enabled connects, else falls to log
    startClient();
  } else { // disabled logs and skips connect
    console.log('[aagm-g] disabled in settings; not connecting.');
  }
});

/* Refresh only owned automatic macros. */
async function ensureMacro(name, command, img) {
  try {
    if (!game.user?.isGM) return; // non GM returns, GM continues
    const existing = game.macros.getName(name);
    if (existing) { // macro exists refreshes, else creates
      if (existing.getFlag(MODULE_ID, 'autoMacro') && existing.command !== command) { // owned and stale updates, else leaves
        await existing.update({ command });
        console.log(`[aagm-g] refreshed macro "${name}"`);
      }
      return;
    }
    await Macro.create({
      name, type: 'script', scope: 'global', img, command,
      flags: { [MODULE_ID]: { autoMacro: true } },
    });
    console.log(`[aagm-g] created macro "${name}"`);
  } catch (err) {
    console.error(`[aagm-g] failed to ensure macro "${name}":`, err);
  }
}

function startClient() {
  if (client) return; // client exists returns, else continues
  if (!game.user?.isGM) return; // non GM returns, GM continues

  /* Install logging before connection. */
  if (!logTap) { // no tap installs one, else reuses
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
  if (!client) return; // no client returns, else stops it
  client.stop();
  client = null;
  if (logTap) { // tap exists uninstalls, else skips
    logTap.uninstall();
    logTap = null;
  }
}

function onEnabledChange(enabled) {
  if (enabled) startClient(); // enabled starts client
  else stopClient(); // disabled stops client
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
      moduleVersion: game.modules.get(MODULE_ID)?.version ?? '2.0.0',
      settings: settingsSnapshot(),
    },
    id: helloId,
  });
  ui.notifications?.info(game.i18n.localize('AAGM_G.NOTIFY.Connected'));
}

function onDisconnected(info) {
  if (wasConnected) ui.notifications?.warn(game.i18n.localize('AAGM_G.NOTIFY.Disconnected')); // was connected warns, else silent
  wasConnected = false;
  console.log(`[aagm-g] disconnected: ${info?.reason || ''} (code ${info?.code || ''})`);
}

/* Notify subscribers and isolate failures. */
function fanout(subs, payload, label) {
  for (const fn of subs) { // each subscriber called, ends after last
    try { fn(payload); } catch (err) { if (label) console.error(`[aagm-g] ${label} subscriber threw:`, err); }
  }
}

async function onMessage(msg) {
  /* Handle the relay handshake. */
  if (typeof msg.id === 'string' && msg.id.startsWith('hello-')) { // hello reply handled, others fall through
    if (msg.error) { // error logs refusal, else checks result
      console.error('[aagm-g] relay refused hello:', msg.error);
      ui.notifications?.error(game.i18n.localize('AAGM_G.NOTIFY.Refused'));
    } else if (msg.result) { // result logs session, else nothing
      console.log(`[aagm-g] relay assigned sessionId=${msg.result.sessionId}, capabilitySet=${msg.result.capabilitySet}`);
    }
    return;
  }

  /* Handle relay notifications. */
  if (msg.method && msg.id == null) { // notification routed, requests fall through
    switch (msg.method) { // method picks subscriber group, default ignored
      case 'aagm.reply':
        if (replySubs.size === 0) { // no subscribers notifies, else fans out
          ui.notifications?.info(game.i18n.localize('AAGM_G.CHAT.ReplyWhileClosed'));
        } else { // subscribers present fan out reply
          fanout(replySubs, msg.params || {}, 'reply');
        }
        return;
      case 'aagm.status':
        fanout(statusSubs, msg.params || {}, null); // status is best-effort
        return;
      case 'aagm.listener.refused':
        ui.notifications?.warn(game.i18n.localize('AAGM_G.NOTIFY.SecondListener'));
        return;
      case 'aagm.mode':
        fanout(modeSubs, msg.params || {}, null);
        return;
      case 'aagm.rollback':
        if (rollbackSubs.size === 0) { // no subscribers warns, else fans out
          ui.notifications?.warn(game.i18n.localize('AAGM_G.CHAT.RollbackWhileClosed'));
        } else { // subscribers present fan out rollback
          fanout(rollbackSubs, msg.params || {}, null);
        }
        return;
      case 'aagm.tabs':
        fanout(tabsSubs, msg.params || {}, null);
        return;
      default:
        return; // unknown notification - ignore
    }
  }

  /* Handle relay command requests. */
  if (msg.method && msg.id != null) { // request dispatched, others end
    const handler = HANDLERS[msg.method];
    if (!handler) { // no handler replies error, else runs
      client.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method "${msg.method}"` } });
      return;
    }
    const ctx = {
      client,
      send: (n) => client.send(n),
      logTap,
    };
    const params = msg.params || {};
    const rp = params.rp?.id ? params.rp : null; // recorded write
    try {
      let result;
      if (rp) { // recorded runs wrapped, else plain call
        const { result: r, entries } = await runRecorded(rp, () => handler(params, ctx));
        result = isPlain(r) ? { ...r, rollback: { entries } } : { value: r, rollback: { entries } };
      } else result = await handler(params, ctx); // unrecorded runs plain handler
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
  /* Local request responses need no action. */
}

function isPlain(v) { return Object.prototype.toString.call(v) === '[object Object]'; }
