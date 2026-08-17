/* WebSocket and MCP relay entry. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Dispatcher } from './src/dispatcher.js';
import { startWsServer } from './src/ws-server.js';
import { startMcpServer } from './src/mcp-server.js';
import { PromptQueue } from './src/prompt-queue.js';
import { Audit } from './src/audit.js';
import { WorldSettings } from './src/world-settings.js';
import { ChainRegistry } from './src/chain.js';
import { MacroMirror } from './src/mirror.js';
import { GateQueue } from './src/gate-queue.js';

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
const audit = new Audit({ stdout: true });
const dispatcher = new Dispatcher({ audit });

const promptQueue = new PromptQueue({
  dispatcher,
  audit,
  capabilitySet: CAPABILITY_SET,
  stopFilePath: join(__dirname, '.loop-stop'), // local listener kill switch
});
promptQueue.start();

const worldSettings = new WorldSettings({ dispatcher, audit });
const chains = new ChainRegistry({ dispatcher, audit, settings: worldSettings, capabilitySet: CAPABILITY_SET });
const mirror = new MacroMirror({ settings: worldSettings, audit });
const gateQueue = new GateQueue({ audit });
const ws = startWsServer({ config, dispatcher, audit, worldSettings });
const mcp = await startMcpServer({ config, dispatcher, audit, promptQueue, capabilitySet: CAPABILITY_SET, worldSettings, chains, mirror, gateQueue });
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
