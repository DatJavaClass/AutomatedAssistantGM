// MCP server (Streamable HTTP transport) exposing the foundry_* tools that
// Claude clients use to drive the bridge. Each tool round-trips through the
// dispatcher to the WS-connected bridge module.
//
// Transport choice: Streamable HTTP rather than stdio, because the relay is a
// long-running shared process - both Claude Code (debug) and Claude Chat
// (AAGM, eventually) point at the same MCP endpoint. stdio would require
// Claude Code to own the relay's lifecycle.

import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { classifyEval, SEVERITY } from './eval-guard.js';

const PHASE1_CAPABILITY_SET = 'debug';

export async function startMcpServer({ config, dispatcher, audit, promptQueue, worldSettings, chains }) {
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
    const s = new McpServer({ name: 'foundry-bridge-relay', version: '0.8.0' });
    registerTools(s, dispatcher, audit, promptQueue, worldSettings, chains);
    return s;
  };

  const httpServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/mcp') {
      handlePost(req, res, makeServer, audit);
      return;
    }
    // Cheap liveness probe for launcher scripts: is the relay up, and is a
    // Foundry bridge currently connected?
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bridges: dispatcher.bridges.size }));
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
    // transport's - but we tear the transport down after every response, so
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

function registerTools(server, dispatcher, audit, promptQueue, worldSettings, chains) {
  const callBridge = (method, params) =>
    dispatcher.sendToBridge({ capabilitySet: PHASE1_CAPABILITY_SET, method, params });
  const asText = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

  server.tool(
    'foundry_ping',
    'Liveness check across the Foundry-Claude bridge. Returns pong + Foundry server time + the ' +
    'world\'s AAGM settings (`settings`: mode assistant/cogm/custom, chainOffers, multitasking, ' +
    'macro-mirror config). Use this first to verify the relay and the in-Foundry module are ' +
    'connected, and read `settings` to adapt: assistant mode = confirm everything individually, ' +
    'never offer chains, prefer one bulk gated write listing all changes; cogm = chain offers ' +
    'allowed via foundry_chain_offer.',
    {},
    async () => asText({ ...(await callBridge('ping', {})), settings: worldSettings.snapshot() })
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
    'setFlag/settings.set/move tokens/HP changes/etc.) are held at a human confirmation gate - ' +
    'DatJavaClass sees your `summary` + the exact code in the chat box and Approve/Denies; DELETES need ' +
    'a double confirm. Always set `intent` ("read"|"write"|"destructive") and, for write/destructive, a ' +
    'short plain-English `summary` (shown to DatJavaClass). The relay takes the stricter of your ' +
    'declared intent and its own classifier, so be honest - under-declaring just forces a ' +
    'stronger confirm, never skips it. HP is an ordinary gated write here (healing, setting HP, ' +
    'reviving) - but for DAMAGE prefer foundry_apply_damage: it previews before→after on live ' +
    'data and auto-escalates a below-1-HP outcome to a double confirm, which eval cannot. ' +
    'ABSOLUTE RULE the relay enforces: Database Journals (e.g. "NPC Register" ' +
    'JournalEntry.yB5klzKycb6bTbcy / Mail-Mailbox Index, runManaged pages) are never touched, ' +
    'even read-only - get data the human/UI way instead, or say it needs the owning macro. ' +
    'Idioms: partial-name game.actors.filter(...includes); gold actor.system.currency.{pp,gp,' +
    'sp,cp}; classes actor.items.filter(i=>i.type==="class").c.system.level; "what scene is X ' +
    'on" walk game.scenes→scene.tokens→tokenDoc.actor; compendia fromUuid/pack.getIndex()→' +
    'getDocument; sidebar game.actors/items/journal/tables/macros(.command)/playlists/scenes/' +
    'folders. Result is depth/size-capped & circular-safe. If a call returns {refused:true} or ' +
    '{blocked:true}, relay that to DatJavaClass verbatim - do not retry or work around the guard.',
    {
      code: z.string().describe('Async function body. Use return + await.'),
      intent: z.enum(['read', 'write', 'destructive']).optional().describe('Declare the effect. Default read.'),
      summary: z.string().optional().describe('Plain-English description shown to DatJavaClass at the gate. Required for write/destructive.'),
      awaitResult: z.boolean().optional().describe('Await a returned thenable before serializing (default true)'),
      captureConsole: z.boolean().optional().describe('Debug mode: also return everything the snippet logged (console.*) and any thrown error+stack as {console:[...],thrown}, and DO NOT fail the call on error - for debugging/variable-hunting. Stateless per call.'),
      chainId: z.string().optional().describe('Active Chain Mode grant id (from foundry_chain_offer). Single-auth writes belonging to the granted batch auto-approve; anything destructive kills the chain and confirms normally.'),
    },
    async ({ code, intent, summary, awaitResult, captureConsole, chainId }) => {
      const verdict = classifyEval(code);
      const declared = intent === 'destructive' ? 'destructive' : intent === 'write' ? 'mutating' : 'read';
      const effective = SEVERITY[verdict.category] >= SEVERITY[declared] ? verdict.category : declared;
      audit.log('eval.in', { len: code.length, category: verdict.category, declared, effective });

      if (verdict.category === 'db-journal') {
        audit.log('eval.blocked', { category: 'db-journal', match: verdict.match });
        return asText({ blocked: true, reason:
          `Refused - this touches a Database Journal (${verdict.match}), a macro backing store, ` +
          `strictly off-limits even read-only. Get the data the human/UI way (sheet, compendium, ` +
          `sidebar); if it can only come from that journal, tell DatJavaClass it needs the owning macro.` });
      }
      if (effective === 'read') {
        return asText(await callBridge('eval', { code, awaitResult, captureConsole }));
      }
      if (!summary || !summary.trim()) {
        return asText({ refused: true, reason:
          `A plain-English \`summary\` is required for any write/destructive eval - it is shown ` +
          `to DatJavaClass at the confirmation gate. Re-issue with intent + summary.` });
      }
      const opId = randomUUID();
      const level = effective === 'destructive' ? 'double' : 'single';
      // Chain death on escalation (§13.3): a destructive gate mid-chain ends
      // the batch; only the user authorizes destructive changes.
      if (chainId && level === 'double') chains.kill('escalated-destructive');
      const riding = !!chainId && level === 'single' && chains.consume(chainId, summary.trim());
      if (riding) {
        audit.log('eval.chain', { opId, chainId });
      } else {
        const decision = await dispatcher.requestConfirmation({
          capabilitySet: PHASE1_CAPABILITY_SET, opId, kind: 'eval', level, summary: summary.trim(), code,
        });
        if (!decision.approved) {
          audit.log('eval.denied', { opId, reason: decision.reason });
          if (chainId) chains.kill('gate-denied');
          return asText({ refused: true, reason:
            `Not executed - ${decision.reason}. DatJavaClass did not approve. Tell him plainly; do not retry ` +
            `unless he asks.` });
        }
      }
      // Approved: extended window - choreography/animation can run long.
      let r;
      try {
        r = await dispatcher.sendToBridge({
          capabilitySet: PHASE1_CAPABILITY_SET, method: 'eval', params: { code, awaitResult, captureConsole }, timeoutMs: 300_000,
        });
      } catch (err) {
        if (chainId) chains.kill('gate-error'); /* surprise error ends the batch */
        throw err;
      }
      audit.log('eval.executed', { opId, chained: riding });
      return asText(r);
    }
  );

  server.tool(
    'foundry_apply_damage',
    'Apply damage to one or more actors, routed through the confirmation gate. Pass `targets` ' +
    '(names or UUIDs), positive integer `amount`, and a plain-English `summary` (shown to ' +
    'DatJavaClass). Prefer this over foundry_eval for damage: the relay first computes before→after ' +
    'on live HP and picks the gate tier from the outcome - all targets staying ≥1 HP is a ' +
    'SINGLE confirm; ANY target landing below 1 HP (lethal) escalates to a DOUBLE confirm, ' +
    'with the preview shown either way. Application is atomic (all targets or none). Damage ' +
    'hits temp HP first, then value. This manipulates state; it does not adjudicate ' +
    'DR/resistances - pass the final amount you intend. For healing or setting HP directly, ' +
    'use foundry_eval (gated write).',
    {
      targets: z.array(z.string()).min(1).describe('Actor names or UUIDs (token UUIDs resolve to their actor)'),
      amount: z.number().int().positive().describe('Damage to deal (positive integer)'),
      summary: z.string().describe('Plain-English description shown to DatJavaClass at the gate'),
      note: z.string().optional().describe('Optional context (e.g. damage source)'),
      chainId: z.string().optional().describe('Active Chain Mode grant id. Non-lethal applications auto-approve on the chain; a lethal outcome kills the chain and double-confirms normally.'),
    },
    async ({ targets, amount, summary, note, chainId }) => {
      const plan = await callBridge('damage', { targets, amount, commit: false });
      if (plan && plan.error) return asText({ error: plan.error });
      audit.log('damage.plan', { n: targets.length, amount, lethal: !!plan.lethal });
      const level = plan.lethal ? 'double' : 'single';
      const opId = randomUUID();
      // Lethal mid-chain = escalation: chain dies, manual double confirm runs.
      if (chainId && plan.lethal) chains.kill('escalated-lethal');
      const riding = !!chainId && !plan.lethal && chains.consume(chainId, summary.trim());
      if (riding) {
        audit.log('damage.chain', { opId, chainId });
      } else {
        const decision = await dispatcher.requestConfirmation({
          capabilitySet: PHASE1_CAPABILITY_SET, opId, kind: 'damage', level,
          summary: (plan.lethal ? 'LETHAL - at least one target drops below 1 HP. ' : '') + summary.trim(),
          preview: plan.preview,
        });
        if (!decision.approved) {
          audit.log('damage.denied', { opId, reason: decision.reason });
          if (chainId) chains.kill('gate-denied');
          return asText({ refused: true, reason: `Not applied - ${decision.reason}.`, preview: plan.preview });
        }
      }
      const result = await callBridge('damage', { targets, amount, commit: true, allowLethal: !!plan.lethal });
      audit.log('damage.commit', { opId, committed: !!result.committed, lethal: !!plan.lethal, chained: riding });
      if (!result.committed) {
        if (chainId) chains.kill('commit-race'); /* surprise outcome ends the batch */
        // Plan→approve→commit race: HP moved and a single-confirmed op turned
        // lethal - more than was approved. Never silently apply it.
        return asText({ refused: true, reason:
          `Not applied - between approval and execution a target's HP changed enough to make ` +
          `this lethal, which is more than was approved. Re-issue the call to re-plan; it will ` +
          `come back to DatJavaClass as a double confirm.`, preview: result.preview });
      }
      return asText(result);
    }
  );

  server.tool(
    'foundry_chain_offer',
    'Offer DatJavaClass a Chain Mode batch (DESIGN §13.3): ONE GM approval covering `count` ' +
    'upcoming SINGLE-auth gates for one homogeneous task (e.g. "forge 10 items into compendium ' +
    'X"). Offer only when foundry_ping settings show chainOffers=true AND you have at least ' +
    'chainOfferThreshold same-shaped, non-destructive gated writes for one declared task. Never ' +
    'for deletes or anything lethal - those are chain-ineligible by rule. He answers at a ' +
    'normal confirm card; on approval you get {chainId} - pass it as `chainId` on each ' +
    'foundry_eval / foundry_apply_damage in the batch (each still needs its honest summary; it ' +
    'is shown live in the box). The chain dies on: any destructive/lethal escalation, any ' +
    'error or denial, count exhausted, 10-minute TTL, or GM cancel - after which remaining ' +
    'gates confirm manually; just continue without chainId and mention it. {refused} means no ' +
    'chain: proceed with normal per-gate confirms, do not re-offer the same batch.',
    {
      count: z.number().int().min(2).describe('Exact number of gates in the batch'),
      summary: z.string().describe('The manifest DatJavaClass approves: what the batch does, where, e.g. "Create 10 wondrous items in Bridge World Wondrous Items"'),
    },
    async ({ count, summary }) => asText(await chains.offer({ count, summary: summary.trim() }))
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
    'blocks, call it back-to-back with NO added delay/sleep - do not pace it yourself; the ' +
    'server provides the pacing and pickup is near-instant. Calling this marks the box "Ready to ' +
    'chat". If `terminate` is true, STOP the loop immediately - do not reschedule, do not poll ' +
    'again - DatJavaClass requested shutdown via /exit or the local .loop-stop file. Answer each ' +
    'prompt with foundry_send_reply. `listenerId` is REQUIRED: generate one random id at loop ' +
    'start and reuse it for every poll this session. Only ONE listener may drain the box - a ' +
    'poll with a different listenerId while another is active errors with listener-occupied ' +
    '(-33005): report that briefly and EXIT; never retry with a new id.',
    {
      listenerId: z.string().min(4).describe('Stable per-loop id, generated once at loop start'),
    },
    async ({ listenerId }) => {
      if (!promptQueue.claimListener(listenerId)) {
        audit.log('chat.refused', { listenerId });
        dispatcher.notifyBridge({ capabilitySet: PHASE1_CAPABILITY_SET, method: 'claude.listener.refused', params: {} });
        const err = new Error('listener-occupied: another AAGM loop is already draining this box (DESIGN §13.2 single-listener lock). Report this briefly and exit - do not retry, do not pick a new listenerId.');
        err.code = -33005;
        throw err;
      }
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
    'you are answering. Returns { delivered } - false means the bridge box/WS is not currently ' +
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

  // --- Claude Loot Watchdog rescue queue --------------------------------------

  server.tool(
    'foundry_loot_pending',
    'Read the Claude Loot Watchdog rescue queue. Returns { pending, phantoms, legacyCount }. ' +
    '`pending` = real items that left an Item Pile but never landed on the looting character ' +
    '(each has eventId, item, shortfall, recipient, looter, pile, ts) - restore these with ' +
    'foundry_restore_loot, no need to ask first. `phantoms` = pf1 "trait as loot" records ' +
    '(statblock gear with an invalid equipment subType that the sheet cannot render) - NEVER ' +
    'restorable; report each one to DatJavaClass in the chat box (item, pile, looter, outcome ' +
    'landed/lost), then acknowledge via foundry_restore_loot ackPhantoms so it is not ' +
    're-reported. Call this once per loop pass; requires the watchdog macro to be armed for ' +
    'new events to appear.',
    {},
    async () => asText(await callBridge('loot.pending', {}))
  );

  server.tool(
    'foundry_restore_loot',
    'Restore vanished loot recorded by the Claude Loot Watchdog. This is a constrained, ' +
    'PRE-AUTHORIZED primitive (DatJavaClass 2026-07-14): no confirmation gate, because it can ' +
    'only recreate exactly what the watchdog recorded, in the recorded shortfall quantity, on ' +
    'the recorded recipient - nothing else. Omit `eventIds` to restore everything pending. ' +
    'Each restored entry is removed from the queue only after the item verifiably exists, so ' +
    'repeat calls can never double-grant. Phantom records cannot be restored through this or ' +
    'any other path; pass their eventIds in `ackPhantoms` (after reporting them to ' +
    'DatJavaClass) to clear them from the queue. Returns { restored, failed, ackedPhantoms } - ' +
    'summarize the result in the chat box.',
    {
      eventIds: z.array(z.string()).optional().describe('Pending eventIds to restore; omit for all pending'),
      ackPhantoms: z.array(z.string()).optional().describe('Phantom eventIds to acknowledge and clear (report them first)'),
    },
    async ({ eventIds, ackPhantoms }) => {
      const r = await callBridge('loot.restore', { eventIds, ackPhantoms });
      audit.log('loot.restore', {
        requested: eventIds?.length ?? 'all',
        restored: r?.restored?.length ?? 0,
        failed: r?.failed?.length ?? 0,
        ackedPhantoms: r?.ackedPhantoms ?? 0,
      });
      return asText(r);
    }
  );
}
