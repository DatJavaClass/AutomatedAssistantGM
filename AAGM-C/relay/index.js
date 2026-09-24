// Relay entry: WS server plus MCP server.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { Dispatcher } from './src/dispatcher.js';
import { startWsServer } from './src/ws-server.js';
import { startMcpServer } from './src/mcp-server.js';
import { PromptQueue } from './src/prompt-queue.js';
import { Audit } from './src/audit.js';
import { WorldSettings } from './src/world-settings.js';
import { ChainRegistry } from './src/chain.js';
import { TabTable } from './src/tabs.js';
import { DayLog } from './src/daylog.js';
import { RollbackStore } from './src/rollback.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  // Hard fail on non-localhost; avoids exposing the bridge
  for (const section of ['ws', 'mcp']) {
    const host = cfg?.[section]?.host;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      console.error(`[relay] config.${section}.host must be 127.0.0.1, localhost, or ::1 - got "${host}"`);
      process.exit(1);
    }
  }
  return cfg;
}

const config = loadConfig();
const audit = new Audit({ stdout: true });
const dispatcher = new Dispatcher({ audit });

// .loop-stop is a local kill switch for /loop
// §14: relay owns tab table; box renders it
const tabs = new TabTable({ dispatcher, audit });
// 2.0 §15: day log and rollback store paths
const daylog = new DayLog({ dir: resolve(__dirname, config.logDir || '../Logs'), audit });
const rollbacks = new RollbackStore({ dir: resolve(__dirname, config.rollbackDir || 'rollbacks'), dispatcher, audit, daylog });
const promptQueue = new PromptQueue({
  dispatcher,
  audit,
  stopFilePath: join(__dirname, '.loop-stop'),
  tabs,
  daylog,
  rollbacks,
});
promptQueue.start();
daylog.write('relay', `started (log ${daylog.dir}, ${rollbacks.points.length} rollback points loaded)`);

// §13: world settings mirror, Chain Mode grant registry
const worldSettings = new WorldSettings({ dispatcher, audit });
const chains = new ChainRegistry({ dispatcher, audit, settings: worldSettings });

const ws = startWsServer({ config, dispatcher, audit, worldSettings });
const mcp = await startMcpServer({ config, dispatcher, audit, promptQueue, worldSettings, chains, tabs, daylog, rollbacks });

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
