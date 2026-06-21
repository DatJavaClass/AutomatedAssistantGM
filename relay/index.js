// Entry point for the Foundry-Claude bridge relay.
// Starts the WebSocket server (for the in-Foundry bridge module) and the MCP
// server (for Claude clients) in a single process so they share the dispatcher,
// audit log, and live connection state.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Dispatcher } from './src/dispatcher.js';
import { startWsServer } from './src/ws-server.js';
import { startMcpServer } from './src/mcp-server.js';
import { PromptQueue } from './src/prompt-queue.js';
import { Audit } from './src/audit.js';

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
  // Hard-fail if anything other than localhost is configured (defense-in-depth
  // against accidentally exposing the bridge over the network).
  for (const section of ['ws', 'mcp']) {
    const host = cfg?.[section]?.host;
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      console.error(`[relay] config.${section}.host must be 127.0.0.1, localhost, or ::1 — got "${host}"`);
      process.exit(1);
    }
  }
  return cfg;
}

const config = loadConfig();
const audit = new Audit({ stdout: true });
const dispatcher = new Dispatcher({ audit });

// `.loop-stop` in the relay dir is a local kill switch for the Claude Code
// /loop — drop the file (or type /exit in the box) to end the loop cleanly.
const promptQueue = new PromptQueue({
  dispatcher,
  audit,
  stopFilePath: join(__dirname, '.loop-stop'),
});
promptQueue.start();

const ws = startWsServer({ config, dispatcher, audit });
const mcp = await startMcpServer({ config, dispatcher, audit, promptQueue });

console.log(`[relay] ready — WS on ws://${config.ws.host}:${config.ws.port}, MCP on http://${config.mcp.host}:${config.mcp.port}/mcp`);

function shutdown(reason) {
  console.log(`[relay] shutting down (${reason})`);
  try { promptQueue.stop(); } catch {}
  try { ws.close?.(); } catch {}
  try { mcp.close?.(); } catch {}
  setTimeout(() => process.exit(0), 250);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
