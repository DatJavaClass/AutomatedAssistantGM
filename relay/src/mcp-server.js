// MCP server (Streamable HTTP transport) exposing the foundry_* tools that
// Claude clients use to drive the bridge. Each tool round-trips through the
// dispatcher to the WS-connected bridge module.
//
// Transport choice: Streamable HTTP rather than stdio, because the relay is a
// long-running shared process — both Claude Code (debug) and Claude Chat
// (AAGM, eventually) point at the same MCP endpoint. stdio would require
// Claude Code to own the relay's lifecycle.

import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { classifyEval, SEVERITY } from './eval-guard.js';

const PHASE1_CAPABILITY_SET = 'debug';

export async function startMcpServer({ config, dispatcher, audit, promptQueue }) {
  const { host, port } = config.mcp;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`refusing to bind MCP server to non-localhost address "${host}"`);
  }

  // A fresh McpServer per request. The McpServer wraps one Protocol instance
  // that can only be connected to a single transport at a time; with the
  // long-poll foundry_get_prompts holding a request open ~25s, a second
  // overlapping tool call against a shared server throws "Already connected to
  // a transport". Per-request server + transport is the stateless pattern and
  // costs nothing here (registerTools is just closures + zod schemas).
  const makeServer = () => {
    const s = new McpServer({ name: 'foundry-bridge-relay', version: '0.3.0' });
    registerTools(s, dispatcher, audit, promptQueue);
    return s;
  };

  const httpServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/mcp') {
      handlePost(req, res, makeServer, audit);
      return;
    }
    if ((req.method === 'GET' || req.method === 'DELETE') && req.url === '/mcp') {
      res.writeHead(405, { 'content-type': 'application/json', 'allow': 'POST' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed; use POST.' }, id: null }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      console.log(`[mcp] listening on http://${host}:${port}/mcp`);
      resolve();
    });
  });

  return {
    close: () => httpServer.close(),
    server: httpServer,
  };
}

async function handlePost(req, res, makeServer, audit) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    let parsed;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null }));
      return;
    }
    // sessionIdGenerator: undefined → true stateless per the SDK. With a
    // generator function set, the transport runs in stateful mode and rejects
    // any non-initialize request that lacks a session ID matching this
    // transport's — but we tear the transport down after every response, so
    // the next request never has a matching session and gets "Server not
    // initialized". Stateless mode skips that check entirely.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = makeServer();
    res.on('close', () => {
      try { transport.close(); } catch {}
      try { server.close?.(); } catch {}
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (err) {
      console.error('[mcp] request handling failed:', err);
      audit.log('mcp.error', { message: err.message });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: err.message }, id: parsed?.id ?? null }));
      }
    }
  });
}

function registerTools(server, dispatcher, audit, promptQueue) {
  const callBridge = (method, params) =>
    dispatcher.sendToBridge({ capabilitySet: PHASE1_CAPABILITY_SET, method, params });
  const asText = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

  server.tool(
    'foundry_ping',
    'Liveness check across the Foundry-Claude bridge. Returns pong + Foundry server time. Use this first to verify the relay and the in-Foundry module are connected.',
    {},
    async () => asText(await callBridge('ping', {}))
  );

  server.tool(
    'foundry_query_actor',
    'Read an actor document from the active Foundry world. Pass `actorId` (the actor _id). Optionally pass `fields` to limit the returned data to specific dot-paths (e.g. ["name","system.attributes.hp"]).',
    {
      actorId: z.string().describe('Foundry actor _id'),
      fields: z.array(z.string()).optional().describe('Optional list of dot-paths to limit the response'),
    },
    async ({ actorId, fields }) => asText(await callBridge('query.actor', { actorId, fields }))
  );

  server.tool(
    'foundry_query_scene',
    'Read scene metadata and a lightweight token list (id/name/position/disposition) from Foundry. Defaults to the active scene if `sceneId` is omitted.',
    {
      sceneId: z.string().optional().describe('Foundry scene _id; omit for the active scene'),
    },
    async ({ sceneId }) => asText(await callBridge('query.scene', { sceneId }))
  );

  server.tool(
    'foundry_query_macro',
    'Read a macro\'s source, author, scope, and type. Pass either `macroId` or `name`.',
    {
      macroId: z.string().optional(),
      name: z.string().optional(),
    },
    async ({ macroId, name }) => asText(await callBridge('query.macro', { macroId, name }))
  );

  server.tool(
    'foundry_query_journal',
    'Read journal entry / page content. Provide `journalId` or `name` to identify the entry, and optionally `pageId` or `pageName` to target a specific page.',
    {
      journalId: z.string().optional(),
      name: z.string().optional(),
      pageId: z.string().optional(),
      pageName: z.string().optional(),
    },
    async (params) => asText(await callBridge('query.journal', params))
  );

  server.tool(
    'foundry_query_user',
    'List Foundry users with online status and character ownership. Pass `userId` to fetch one user; omit for all.',
    {
      userId: z.string().optional(),
    },
    async ({ userId }) => asText(await callBridge('query.user', { userId }))
  );

  server.tool(
    'foundry_tail_logs',
    'Subscribe to the Foundry client console (log/info/warn/error/debug + window error events) for `durationSeconds` (1-300, default 30). Entries are streamed as MCP log-message notifications during the window and also returned as a collected array when the call completes.',
    {
      durationSeconds: z.number().int().min(1).max(300).default(30),
      levels: z.array(z.enum(['log', 'info', 'warn', 'error', 'debug'])).optional(),
      filter: z.string().optional().describe('Optional regex; entries whose message does not match are dropped'),
    },
    async ({ durationSeconds, levels, filter }, extra) => {
      const collected = [];
      const unsub = dispatcher.subscribe('logs.entry', (entry) => {
        collected.push(entry);
        try {
          const mcpLevel = entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warning' : 'info';
          extra?.sendNotification?.({
            method: 'notifications/message',
            params: { level: mcpLevel, logger: 'foundry', data: entry },
          });
        } catch { /* best-effort streaming */ }
      });
      try {
        await callBridge('logs.subscribe', { levels, filter });
      } catch (err) {
        unsub();
        throw err;
      }
      try {
        await new Promise((r) => setTimeout(r, durationSeconds * 1000));
      } finally {
        unsub();
        try { await callBridge('logs.unsubscribe', {}); } catch { /* bridge may already be gone */ }
      }
      return asText({ durationSeconds, count: collected.length, entries: collected });
    }
  );

  server.tool(
    'foundry_eval',
    'Run JavaScript in the GM\'s Foundry client. READS run immediately. WRITES (create/update/' +
    'setFlag/settings.set/move tokens/etc.) are held at a human confirmation gate — DatJavaClass sees ' +
    'your `summary` + the exact code in the chat box and Approve/Denies; DELETES need a double ' +
    'confirm. Always set `intent` ("read"|"write"|"destructive") and, for write/destructive, a ' +
    'short plain-English `summary` (shown to DatJavaClass). The relay takes the stricter of your ' +
    'declared intent and its own classifier, so be honest — under-declaring just forces a ' +
    'stronger confirm, never skips it. ABSOLUTE RULES the relay enforces: (1) HP changes / ' +
    '"kill" are refused here — use foundry_apply_damage, which floors at 1 HP; reducing anyone ' +
    'below 1 HP is human-only. (2) Database Journals (e.g. "NPC Register" ' +
    'JournalEntry.yB5klzKycb6bTbcy / Mail-Mailbox Index, runManaged pages) are never touched, ' +
    'even read-only — get data the human/UI way instead, or say it needs the owning macro. ' +
    'Idioms: partial-name game.actors.filter(...includes); gold actor.system.currency.{pp,gp,' +
    'sp,cp}; classes actor.items.filter(i=>i.type==="class").c.system.level; "what scene is X ' +
    'on" walk game.scenes→scene.tokens→tokenDoc.actor; compendia fromUuid/pack.getIndex()→' +
    'getDocument; sidebar game.actors/items/journal/tables/macros(.command)/playlists/scenes/' +
    'folders. Result is depth/size-capped & circular-safe. If a call returns {refused:true} or ' +
    '{blocked:true}, relay that to DatJavaClass verbatim — do not retry or work around the guard.',
    {
      code: z.string().describe('Async function body. Use return + await.'),
      intent: z.enum(['read', 'write', 'destructive']).optional().describe('Declare the effect. Default read.'),
      summary: z.string().optional().describe('Plain-English description shown to DatJavaClass at the gate. Required for write/destructive.'),
      awaitResult: z.boolean().optional().describe('Await a returned thenable before serializing (default true)'),
      captureConsole: z.boolean().optional().describe('Debug mode: also return everything the snippet logged (console.*) and any thrown error+stack as {console:[...],thrown}, and DO NOT fail the call on error — for debugging/variable-hunting. Stateless per call.'),
    },
    async ({ code, intent, summary, awaitResult, captureConsole }) => {
      const verdict = classifyEval(code);
      const declared = intent === 'destructive' ? 'destructive' : intent === 'write' ? 'mutating' : 'read';
      const effective = SEVERITY[verdict.category] >= SEVERITY[declared] ? verdict.category : declared;
      audit.log('eval.in', { len: code.length, category: verdict.category, declared, effective });

      if (verdict.category === 'db-journal') {
        audit.log('eval.blocked', { category: 'db-journal', match: verdict.match });
        return asText({ blocked: true, reason:
          `Refused — this touches a Database Journal (${verdict.match}), a macro backing store, ` +
          `strictly off-limits even read-only. Get the data the human/UI way (sheet, compendium, ` +
          `sidebar); if it can only come from that journal, tell DatJavaClass it needs the owning macro.` });
      }
      if (verdict.category === 'hp') {
        audit.log('eval.blocked', { category: 'hp', match: verdict.match });
        return asText({ blocked: true, reason:
          `Refused — HP / "kill" changes are not allowed through eval. Use foundry_apply_damage; ` +
          `it enforces the absolute ≥1 HP floor. Reducing anyone below 1 HP is human-only — tell ` +
          `DatJavaClass he must deliver any lethal blow himself.` });
      }
      if (effective === 'read') {
        return asText(await callBridge('eval', { code, awaitResult, captureConsole }));
      }
      if (!summary || !summary.trim()) {
        return asText({ refused: true, reason:
          `A plain-English \`summary\` is required for any write/destructive eval — it is shown ` +
          `to DatJavaClass at the confirmation gate. Re-issue with intent + summary.` });
      }
      const opId = randomUUID();
      const level = effective === 'destructive' ? 'double' : 'single';
      const decision = await dispatcher.requestConfirmation({
        capabilitySet: PHASE1_CAPABILITY_SET, opId, kind: 'eval', level, summary: summary.trim(), code,
      });
      if (!decision.approved) {
        audit.log('eval.denied', { opId, reason: decision.reason });
        return asText({ refused: true, reason:
          `Not executed — ${decision.reason}. DatJavaClass did not approve. Tell him plainly; do not retry ` +
          `unless he asks.` });
      }
      // Approved: extended window — choreography/animation can run long.
      const r = await dispatcher.sendToBridge({
        capabilitySet: PHASE1_CAPABILITY_SET, method: 'eval', params: { code, awaitResult, captureConsole }, timeoutMs: 300_000,
      });
      audit.log('eval.executed', { opId });
      return asText(r);
    }
  );

  server.tool(
    'foundry_apply_damage',
    'Apply damage to one or more actors, with an ABSOLUTE ≥1 HP floor. Pass `targets` (names ' +
    'or UUIDs), positive integer `amount`, and a plain-English `summary` (shown to DatJavaClass). ' +
    'This is the ONLY way to change HP — never do HP via foundry_eval. The relay first computes ' +
    'the result on live HP: if ANY target would land below 1 HP the WHOLE operation is REFUSED ' +
    '(atomic, no partial application) — reducing anyone below 1 HP is human-only, so tell DatJavaClass ' +
    'he must apply that killing blow himself. If all targets stay ≥1, it goes through a single ' +
    'confirmation (DatJavaClass sees the before→after preview and Approve/Denies). Damage hits temp ' +
    'HP first, then value. This manipulates state; it does not adjudicate DR/resistances — pass ' +
    'the final amount you intend.',
    {
      targets: z.array(z.string()).min(1).describe('Actor names or UUIDs (token UUIDs resolve to their actor)'),
      amount: z.number().int().positive().describe('Damage to deal (positive integer)'),
      summary: z.string().describe('Plain-English description shown to DatJavaClass at the gate'),
      note: z.string().optional().describe('Optional context (e.g. damage source)'),
    },
    async ({ targets, amount, summary, note }) => {
      const plan = await callBridge('damage', { targets, amount, commit: false });
      if (plan && plan.error) return asText({ error: plan.error });
      audit.log('damage.plan', { n: targets.length, amount, lethal: !!plan.lethal });
      if (plan.lethal) {
        return asText({ refused: true, reason:
          `LETHAL — refused. One or more targets would drop below 1 HP, and reducing anyone below ` +
          `1 HP is human-only. Tell DatJavaClass he must apply the killing blow himself.`,
          preview: plan.preview });
      }
      const opId = randomUUID();
      const decision = await dispatcher.requestConfirmation({
        capabilitySet: PHASE1_CAPABILITY_SET, opId, kind: 'damage', level: 'single',
        summary: summary.trim(), preview: plan.preview,
      });
      if (!decision.approved) {
        audit.log('damage.denied', { opId, reason: decision.reason });
        return asText({ refused: true, reason: `Not applied — ${decision.reason}.`, preview: plan.preview });
      }
      const result = await callBridge('damage', { targets, amount, commit: true });
      audit.log('damage.commit', { opId, committed: !!result.committed });
      if (!result.committed) {
        // Plan→approve→commit race: a target dropped to lethal in between.
        return asText({ refused: true, reason:
          `Not applied — between approval and execution a target reached the 1 HP floor. ` +
          `Reducing anyone below 1 HP is human-only; tell DatJavaClass.`, preview: result.preview });
      }
      return asText(result);
    }
  );

  // --- Phase 2: Foundry → Claude Code chat channel ---------------------------
  // These two run the opposite direction from everything above: DatJavaClass types in
  // the in-Foundry "Open Claude Code Chat" box, and *this* Claude Code session
  // (driven by a /loop) drains and answers.

  server.tool(
    'foundry_get_prompts',
    'Long-polling drain of chat messages DatJavaClass typed in the in-Foundry "Open Claude Code Chat" ' +
    'box. This BLOCKS server-side until a message arrives or ~25s elapses, then returns ' +
    '{ prompts: [{promptId,text,ts}], terminate } (prompts may be empty on timeout). Because it ' +
    'blocks, call it back-to-back with NO added delay/sleep — do not pace it yourself; the ' +
    'server provides the pacing and pickup is near-instant. Calling this marks the box "Ready to ' +
    'chat". If `terminate` is true, STOP the loop immediately — do not reschedule, do not poll ' +
    'again — DatJavaClass requested shutdown via /exit or the local .loop-stop file. Answer each ' +
    'prompt with foundry_send_reply.',
    {},
    async () => {
      await promptQueue.waitForWork();
      const r = promptQueue.drain();
      if (r.prompts.length || r.terminate) {
        audit.log('chat.poll', { count: r.prompts.length, terminate: r.terminate });
      }
      return asText(r);
    }
  );

  server.tool(
    'foundry_send_reply',
    'Send a reply back into the in-Foundry chat box so DatJavaClass sees it. Call this after ' +
    'foundry_get_prompts returns prompts. Pass the reply `text`; optionally echo the `promptId` ' +
    'you are answering. Returns { delivered } — false means the bridge box/WS is not currently ' +
    'connected (the message is not buffered; tell DatJavaClass on the next poll if it keeps failing).',
    {
      text: z.string().describe('The reply to render in the Foundry chat box'),
      promptId: z.string().optional().describe('The promptId being answered, if known'),
    },
    async ({ text, promptId }) => {
      const delivered = dispatcher.notifyBridge({
        capabilitySet: PHASE1_CAPABILITY_SET,
        method: 'claude.reply',
        params: { promptId, text },
      });
      audit.log('chat.reply', { promptId, delivered, len: text.length });
      return asText({ delivered });
    }
  );

  // --- Claude Macro Workshop (separate "Claude Macro Workshop" window) --------

  server.tool(
    'foundry_workshop_set',
    'Push code into the Claude Macro Workshop\'s Refactor Box (the IDE-style editor in the ' +
    '"Claude Macro Workshop" window). Use this to LOAD a macro for editing or to hand DatJavaClass a ' +
    'refactor/fix: first read the macro (foundry_eval: game.macros.getName(x) → {id,name,command}), ' +
    'then call this with the full `content`, plus `macroId`+`macroName` so the Workshop\'s Save ' +
    'targets the right macro (Save makes a rolling "<name>.old" backup then overwrites the ' +
    'original to keep its id/links). For a brand-new macro, pass `macroName` only (no macroId). ' +
    'Saving is DatJavaClass\'s button — never try to save/overwrite a macro via foundry_eval. Returns ' +
    '{delivered}; false = the Workshop window isn\'t open (tell DatJavaClass to open "Claude Macro ' +
    'Workshop" — the push is held and shown when he opens it).',
    {
      content: z.string().describe('Full macro/script source to place in the editor'),
      macroId: z.string().optional().describe('Existing macro id this content came from (Save target)'),
      macroName: z.string().optional().describe('Macro name (existing, or the proposed name for a new macro)'),
    },
    async ({ content, macroId, macroName }) => {
      const delivered = dispatcher.notifyBridge({
        capabilitySet: PHASE1_CAPABILITY_SET,
        method: 'claude.refactor.set',
        params: { content, macroId, macroName },
      });
      audit.log('workshop.set', { len: content.length, macroId: macroId || null, delivered });
      return asText({ delivered });
    }
  );

  server.tool(
    'foundry_workshop_get',
    'Read the Claude Macro Workshop editor\'s CURRENT live content — DatJavaClass\'s edits included — ' +
    'so you can refine/debug what is actually in the box (never assume; read ground truth). ' +
    'Returns { open, content, macroId, macroName }. open:false means the Workshop window is not ' +
    'open. Do not use this to confirm a foundry_workshop_set landed; use it to see DatJavaClass\'s edits.',
    {},
    async () => asText(await callBridge('refactor.get', {})),
  );
}
