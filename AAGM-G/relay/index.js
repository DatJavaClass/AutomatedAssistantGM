/* WebSocket and MCP relay entry. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';

import { Dispatcher } from './src/dispatcher.js';
import { startWsServer } from './src/ws-server.js';
import { startMcpServer } from './src/mcp-server.js';
import { PromptQueue } from './src/prompt-queue.js';
import { Audit } from './src/audit.js';
import { WorldSettings } from './src/world-settings.js';
import { MacroMirror } from './src/mirror.js';
import { WriteQueue } from './src/write-queue.js';
import { RollbackStore } from './src/rollback-store.js';
import { TabTable } from './src/tabs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAPABILITY_SET = 'gm';

function loadConfig() {
  const path = join(__dirname, 'config.json');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.error(`[relay] config.json not found at ${path}`);
    console.error(`[relay] copy/edit config.json with your Foundry userId before starting.`);
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    console.error(`[relay] config.json is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  for (const section of ['ws', 'mcp']) { // localhost only, defense-in-depth
    const host = cfg?.[section]?.host;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      console.error(`[relay] config.${section}.host must be 127.0.0.1, localhost, or ::1. Got "${host}".`);
      process.exit(1);
    }
  }
  return cfg;
}

const config = loadConfig();
const audit = new Audit({ stdout: true, logDir: join(__dirname, '..', 'Logs') });
const dispatcher = new Dispatcher({ audit });
const tabs = new TabTable({ dispatcher, audit, capabilitySet: CAPABILITY_SET });

const promptQueue = new PromptQueue({
  dispatcher,
  audit,
  capabilitySet: CAPABILITY_SET,
  tabs,
  stopFilePath: join(__dirname, '.loop-stop'), // local listener kill switch
});
promptQueue.start();

const worldSettings = new WorldSettings({ dispatcher, audit });
const mirror = new MacroMirror({ settings: worldSettings, audit });
const writeQueue = new WriteQueue({ audit });
const rollbacks = new RollbackStore({
  root: join(__dirname, '..', 'Rollback Points'), dispatcher, audit, capabilitySet: CAPABILITY_SET,
});

function say(text, tabId) {
  const id = tabId || tabs.first().id;
  dispatcher.notifyBridge({ capabilitySet: CAPABILITY_SET, method: 'aagm.reply', params: { text, tabId: id } });
}

promptQueue.onLocal = async (name, arg) => {
  try {
    if (name === 'mode') {
      const parked = promptQueue.parked.length;
      say(arg === 'external'
        ? `External. Grok outside Foundry has the table. /int to come back.${parked ? ` ${parked} queued prompt(s) parked until then.` : ''}`
        : 'Internal. This chat is driving.');
      return;
    }
    if (name === 'held') {
      say('Held for the outside Grok. It picks this up on its next action.');
      return;
    }
    if (name === 'log') {
      const file = arg || (audit.logPath ? basename(audit.logPath) : '');
      const body = audit.readLog(file);
      say(`Log ${file}\n${body.split(/\r?\n/).slice(-30).join('\n')}`);
      return;
    }
    if (name === 'rollback') {
      await writeQueue.run('rollback', async () => {
        const r = await rollbacks.rollbackTo(arg || null, { via: 'chat' });
        if (r.refused) { say(`Rollback refused: ${r.reason}`); return; }
        const lines = r.rolledBack.map((p) => `${p.id} ${p.state}${p.failed ? ` (${p.failed} failed)` : ''}${p.error ? ` ${p.error}` : ''}`);
        const redo = r.redoPoint ? ` Redo point ${r.redoPoint.id}.` : '';
        const head = r.rolledBack.some((p) => p.state === 'partial') ? 'Rollback partial' : 'Rolled back';
        say(`${head} to before ${r.target}.${redo}\n${lines.join('\n')}`, rollbacks.get(r.target)?.tabId);
      });
    }
  } catch (err) {
    audit.log('chat.command.error', { name, message: err.message });
    say(`Command failed: ${err.message}`);
  }
};

const ws = startWsServer({ config, dispatcher, audit, worldSettings });
const mcp = await startMcpServer({
  config, dispatcher, audit, promptQueue, capabilitySet: CAPABILITY_SET,
  worldSettings, mirror, writeQueue, rollbacks, tabs,
});
audit.log('relay.ready', { ws: config.ws, mcp: config.mcp });
console.log(`[relay] ready - WS on ws://${config.ws.host}:${config.ws.port}, MCP on http://${config.mcp.host}:${config.mcp.port}/mcp`);

function shutdown(reason) {
  console.log(`[relay] shutting down (${reason})`);
  try { promptQueue.stop(); } catch {}
  try { ws.close?.(); } catch {}
  try { mcp.close?.(); } catch {}
  setTimeout(() => process.exit(0), 250);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
