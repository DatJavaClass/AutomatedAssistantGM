// MCP server exposing the foundry_* tools.

import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { classifyEval, SEVERITY } from './eval-guard.js';

const PHASE1_CAPABILITY_SET = 'debug';

export async function startMcpServer({ config, dispatcher, audit, promptQueue, worldSettings, chains, tabs, daylog, rollbacks }) {
  const { host, port } = config.mcp;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`refusing to bind MCP server to non-localhost address "${host}"`);
  }

  // Fresh McpServer per request, long polls overlap
  const makeServer = () => {
    const s = new McpServer({ name: 'foundry-bridge-relay', version: '2.0.0' });
    registerTools(s, { dispatcher, audit, promptQueue, worldSettings, chains, tabs, daylog, rollbacks });
    return s;
  };

  const httpServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/mcp') {
      handlePost(req, res, makeServer, audit);
      return;
    }
    // Liveness probe: relay up, bridge connected?
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
    // Stateless mode: no session ID to reject requests
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

function registerTools(server, { dispatcher, audit, promptQueue, worldSettings, chains, tabs, daylog, rollbacks }) {
  const callBridge = (method, params) =>
    dispatcher.sendToBridge({ capabilitySet: PHASE1_CAPABILITY_SET, method, params });
  const raw = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
  const rollbackPolicy = () => worldSettings.get('writePolicy') !== 'confirm';
  const singleTab = () => !worldSettings.get('multitasking');
  // §15.1: interrupt rides next tool result for tab
  const interruptsFor = (tabId) => tabId ? promptQueue.takeInterrupts(tabs.resolve(tabId)) : singleTab() ? promptQueue.takeInterrupts() : [];
  const asText = (data, tabId) => {
    const ints = interruptsFor(tabId);
    if (!ints.length) return raw(data);
    const interrupts = ints.map(({ promptId, text, tabId: t, system, rollback, ts }) => ({ promptId, text, tabId: t, system, rollback, ts }));
    const note = 'INTERRUPT: DatJavaClass typed this while you were working. Read it now, fold it into the current task (or stop if it says so), acknowledge in the box with foundry_send_reply final:false, then continue.';
    const body = data && typeof data === 'object' && !Array.isArray(data) ? { ...data } : { result: data };
    return raw({ ...body, interrupts, interruptNote: note });
  };
  const logRead = (code) => daylog?.write('read', `eval ${code.length}ch: ${code.slice(0, 160)}`);
  // §14: card in tab flashes until decided
  const gate = async (tabId, opts) => {
    const id = tabs.resolve(tabId);
    tabs.gated(id, true);
    try { return await dispatcher.requestConfirmation({ capabilitySet: PHASE1_CAPABILITY_SET, tabId: id, ...opts }); }
    finally { tabs.gated(id, false); }
  };
  const TAB_PARAM = z.string().optional().describe('Tab this work belongs to (from foundry_get_prompts). The gate card renders in that tab. Omit = first tab.');

  server.tool(
    'foundry_ping',
    'Liveness check across the Foundry-Claude bridge. Returns pong + Foundry server time + the ' +
    'world AAGM settings (`settings`: mode assistant/cogm/custom, writePolicy rollback|confirm, ' +
    'chainOffers, multitasking, macro-mirror config), the current `surface` (int = box seat, ' +
    'ext = terminal seat), the rollback point count for today and the day log path. Use this first to ' +
    'verify the relay and the in-Foundry module are connected, then adapt: writePolicy rollback ' +
    '(2.0 default) = writes run at once behind rollback points, no cards; confirm = every write ' +
    'is gated (assistant mode confirms individually, cogm may offer chains).',
    {},
    async () => asText({ ...(await callBridge('ping', {})), settings: worldSettings.snapshot(), surface: promptQueue.surface,
      rollbackPoints: rollbacks.points.length, logFile: daylog.file() })
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
          })?.catch?.(() => {}); // unhandled rejection here would crash relay
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
    'setFlag/settings.set/move tokens/HP changes/etc.) take a ROLLBACK POINT first (2.0 default, ' +
    'settings.writePolicy "rollback"): the module snapshots every document the code touches, the ' +
    'write runs at once with no approval card, and the result carries `rollbackPoint` {id, ' +
    'captured}. DatJavaClass sees a card in the box with a Roll back button; you can undo your ' +
    'own point with foundry_rollback when a read-back shows the change went wrong. Under ' +
    'writePolicy "confirm" (legacy) the old gate applies instead: the code is held until he ' +
    'Approves in the box, deletes need a double confirm. Either way set `intent` ' +
    '("read"|"write"|"destructive") honestly and give a short plain-English `summary` for ' +
    'write/destructive: it is the rollback point\'s label and the day log line. The relay takes ' +
    'the stricter of your intent and its classifier. HP is an ordinary write here (healing, ' +
    'setting, reviving); for DAMAGE prefer foundry_apply_damage (live before/after preview, ' +
    'lethal flagged). ABSOLUTE RULE the relay enforces: Database Journals (e.g. "NPC Register" ' +
    'JournalEntry.yB5klzKycb6bTbcy / Mail-Mailbox Index, runManaged pages) are never touched, ' +
    'even read-only - get data the human/UI way instead, or say it needs the owning macro. ' +
    'Idioms: partial-name game.actors.filter(...includes); gold actor.system.currency.{pp,gp,' +
    'sp,cp}; classes actor.items.filter(i=>i.type==="class").c.system.level; "what scene is X ' +
    'on" walk game.scenes→scene.tokens→tokenDoc.actor; compendia fromUuid/pack.getIndex()→' +
    'getDocument; sidebar game.actors/items/journal/tables/macros(.command)/playlists/scenes/' +
    'folders. Result is depth/size-capped & circular-safe. A write\'s own return is a pre-write ' +
    'value: verify with a separate read. If a call returns {refused:true} or {blocked:true}, ' +
    'relay that to DatJavaClass verbatim - do not retry or work around the guard. Any result ' +
    'may carry `interrupts`: read them before continuing.',
    {
      code: z.string().describe('Async function body. Use return + await.'),
      intent: z.enum(['read', 'write', 'destructive']).optional().describe('Declare the effect. Default read.'),
      summary: z.string().optional().describe('Plain-English label for the rollback point / gate, shown to DatJavaClass. Required for write/destructive.'),
      awaitResult: z.boolean().optional().describe('Await a returned thenable before serializing (default true)'),
      captureConsole: z.boolean().optional().describe('Debug mode: also return everything the snippet logged (console.*) and any thrown error+stack as {console:[...],thrown}, and DO NOT fail the call on error - for debugging/variable-hunting. Stateless per call.'),
      chainId: z.string().optional().describe('Confirm policy only: active Chain Mode grant id (from foundry_chain_offer). Ignored under the rollback policy.'),
      tabId: TAB_PARAM,
    },
    async ({ code, intent, summary, awaitResult, captureConsole, chainId, tabId }) => {
      const verdict = classifyEval(code);
      const declared = intent === 'destructive' ? 'destructive' : intent === 'write' ? 'mutating' : 'read';
      const effective = SEVERITY[verdict.category] >= SEVERITY[declared] ? verdict.category : declared;
      audit.log('eval.in', { len: code.length, category: verdict.category, declared, effective });

      if (verdict.category === 'db-journal') {
        audit.log('eval.blocked', { category: 'db-journal', match: verdict.match });
        daylog?.write('blocked', `db-journal eval (${verdict.match})`, { tabId });
        return asText({ blocked: true, reason:
          `Refused - this touches a Database Journal (${verdict.match}), a macro backing store, ` +
          `strictly off-limits even read-only. Get the data the human/UI way (sheet, compendium, ` +
          `sidebar); if it can only come from that journal, tell DatJavaClass it needs the owning macro.` }, tabId);
      }
      if (effective === 'read') {
        logRead(code);
        return asText(await callBridge('eval', { code, awaitResult, captureConsole }), tabId);
      }
      if (!summary || !summary.trim()) {
        return asText({ refused: true, reason:
          `A plain-English \`summary\` is required for any write/destructive eval - it labels the ` +
          `rollback point (or the gate) DatJavaClass sees. Re-issue with intent + summary.` }, tabId);
      }
      const label = summary.trim();
      const level = effective === 'destructive' ? 'double' : 'single';
      const runParams = { code, awaitResult, captureConsole };

      // 2.0 default: snapshot, run, return rollback point
      if (rollbackPolicy()) {
        const rp = rollbacks.open({ summary: label, tabId: tabs.resolve(tabId), kind: level === 'double' ? 'destructive eval' : 'eval' });
        let r;
        try {
          r = await dispatcher.sendToBridge({
            capabilitySet: PHASE1_CAPABILITY_SET, method: 'eval', params: { ...runParams, rp: { id: rp.id } }, timeoutMs: 300_000,
          });
        } catch (err) {
          // Partial writes before the throw are still captured.
          const entries = err?.data?.rollback?.entries;
          if (Array.isArray(entries) && entries.length) {
            const point = rollbacks.record(rp, entries, { failed: err.message });
            err.message += ` (rollback point ${point.id} holds ${point.captured}; foundry_rollback can undo it)`;
          } else daylog?.write('write-failed', `${label}: ${err.message}`, { tabId });
          throw err;
        }
        const { rollback, ...rest } = r || {};
        const point = rollbacks.record(rp, rollback?.entries || [], { thrown: !!rest?.thrown });
        audit.log('eval.executed', { rp: point.id, entries: rollback?.entries?.length || 0 });
        return asText({ ...rest, rollbackPoint: { id: point.id, captured: point.captured, docs: point.docs } }, tabId);
      }

      // Legacy confirm policy: §9 gate, Chain Mode
      const opId = randomUUID();
      if (chainId && level === 'double') chains.kill('escalated-destructive');
      const riding = !!chainId && level === 'single' && chains.consume(chainId, label);
      if (riding) {
        audit.log('eval.chain', { opId, chainId });
      } else {
        const decision = await gate(tabId, { opId, kind: 'eval', level, summary: label, code });
        if (!decision.approved) {
          audit.log('eval.denied', { opId, reason: decision.reason });
          daylog?.write('denied', `${label} (${decision.reason})`, { tabId });
          if (chainId) chains.kill('gate-denied');
          return asText({ refused: true, reason:
            `Not executed - ${decision.reason}. DatJavaClass did not approve. Tell him plainly; do not retry ` +
            `unless he asks.` }, tabId);
        }
      }
      let r;
      try {
        r = await dispatcher.sendToBridge({ capabilitySet: PHASE1_CAPABILITY_SET, method: 'eval', params: runParams, timeoutMs: 300_000 });
      } catch (err) {
        if (chainId) chains.kill('gate-error'); /* surprise error ends the batch */
        throw err;
      }
      audit.log('eval.executed', { opId, chained: riding });
      daylog?.write('write', `${label} (gate approved${riding ? ', chain' : ''})`, { tabId });
      return asText(r, tabId);
    }
  );

  server.tool(
    'foundry_apply_damage',
    'Apply damage to one or more actors. Pass `targets` (names or UUIDs), positive integer ' +
    '`amount`, and a plain-English `summary`. Prefer this over foundry_eval for damage: the ' +
    'relay first computes before→after on live HP and flags LETHAL when any target lands below ' +
    '1 HP. Under the rollback policy (2.0 default) the damage applies at once with a rollback ' +
    'point (HP restorable from the box card or foundry_rollback), lethal or not, and the ' +
    'preview comes back with the result; say so in the box when it was lethal. Under the ' +
    'confirm policy the old tiers apply (non-lethal single confirm, lethal double confirm). ' +
    'Application is atomic (all targets or none). Damage hits temp HP first, then value. This ' +
    'manipulates state; it does not adjudicate DR/resistances - pass the final amount you ' +
    'intend. For healing or setting HP directly, use foundry_eval.',
    {
      targets: z.array(z.string()).min(1).describe('Actor names or UUIDs (token UUIDs resolve to their actor)'),
      amount: z.number().int().positive().describe('Damage to deal (positive integer)'),
      summary: z.string().describe('Plain-English label shown to DatJavaClass (rollback point / gate)'),
      note: z.string().optional().describe('Optional context (e.g. damage source)'),
      chainId: z.string().optional().describe('Confirm policy only: active Chain Mode grant id. Ignored under the rollback policy.'),
      tabId: TAB_PARAM,
    },
    async ({ targets, amount, summary, note, chainId, tabId }) => {
      const plan = await callBridge('damage', { targets, amount, commit: false });
      if (plan && plan.error) return asText({ error: plan.error }, tabId);
      audit.log('damage.plan', { n: targets.length, amount, lethal: !!plan.lethal });
      const label = (plan.lethal ? 'LETHAL - at least one target drops below 1 HP. ' : '') + summary.trim();

      if (rollbackPolicy()) {
        const rp = rollbacks.open({ summary: label, tabId: tabs.resolve(tabId), kind: 'damage' });
        const result = await dispatcher.sendToBridge({
          capabilitySet: PHASE1_CAPABILITY_SET, method: 'damage',
          params: { targets, amount, commit: true, rp: { id: rp.id } }, timeoutMs: 120_000,
        });
        const { rollback, ...rest } = result || {};
        const point = rollbacks.record(rp, rollback?.entries || [], { note });
        audit.log('damage.commit', { rp: point.id, committed: !!rest.committed, lethal: !!plan.lethal });
        return asText({ ...rest, lethal: !!plan.lethal, rollbackPoint: { id: point.id, captured: point.captured } }, tabId);
      }

      const level = plan.lethal ? 'double' : 'single';
      const opId = randomUUID();
      // Lethal mid-chain kills it; double-confirm runs.
      if (chainId && plan.lethal) chains.kill('escalated-lethal');
      const riding = !!chainId && !plan.lethal && chains.consume(chainId, summary.trim());
      if (riding) {
        audit.log('damage.chain', { opId, chainId });
      } else {
        const decision = await gate(tabId, { opId, kind: 'damage', level, summary: label, preview: plan.preview });
        if (!decision.approved) {
          audit.log('damage.denied', { opId, reason: decision.reason });
          daylog?.write('denied', `${label} (${decision.reason})`, { tabId });
          if (chainId) chains.kill('gate-denied');
          return asText({ refused: true, reason: `Not applied - ${decision.reason}.`, preview: plan.preview }, tabId);
        }
      }
      const result = await callBridge('damage', { targets, amount, commit: true });
      audit.log('damage.commit', { opId, committed: !!result.committed, lethal: !!plan.lethal, chained: riding });
      daylog?.write('damage', `${label} (gate approved)`, { tabId });
      return asText(result, tabId);
    }
  );

  server.tool(
    'foundry_chain_offer',
    'CONFIRM POLICY ONLY (settings.writePolicy "confirm"); under the 2.0 rollback policy there ' +
    'are no gates to chain and this returns {refused}. Offer DatJavaClass a Chain Mode batch ' +
    '(DESIGN §13.3): ONE GM approval covering `count` upcoming SINGLE-auth gates for one ' +
    'homogeneous task (e.g. "forge 10 items into compendium X"). Offer only when settings show ' +
    'chainOffers=true AND you have at least chainOfferThreshold same-shaped, non-destructive ' +
    'gated writes for one declared task. Never for deletes or anything lethal. On approval you ' +
    'get {chainId} - pass it on each foundry_eval / foundry_apply_damage in the batch. The ' +
    'chain dies on any destructive/lethal escalation, error, denial, count exhausted, 10-minute ' +
    'TTL, or GM cancel; remaining gates then confirm manually. {refused} = normal per-gate ' +
    'confirms, do not re-offer.',
    {
      count: z.number().int().min(2).describe('Exact number of gates in the batch'),
      summary: z.string().describe('The manifest DatJavaClass approves: what the batch does, where'),
      tabId: TAB_PARAM,
    },
    async ({ count, summary, tabId }) => {
      if (rollbackPolicy()) return asText({ refused: true, reason: 'rollback policy: writes are not gated, nothing to chain' }, tabId);
      const id = tabs.resolve(tabId);
      tabs.gated(id, true);
      try { return asText(await chains.offer({ count, summary: summary.trim(), tabId: id }), tabId); }
      finally { tabs.gated(id, false); }
    }
  );

  // --- 2.0 Rollback Points, day log, seat --------------------------------

  server.tool(
    'foundry_rollback_points',
    'List today\'s rollback points (2.0, DESIGN §15.2): every write since the relay started ' +
    'today, oldest first, with {id, ts, summary, tabId, kind, state live|rolled-back|partial, ' +
    'captured, docs}. Use it to find the point to undo, or to report what was changed.',
    {},
    async () => asText({ writePolicy: worldSettings.get('writePolicy'), points: rollbacks.list() })
  );

  server.tool(
    'foundry_rollback',
    'Roll the world back to BEFORE a rollback point: that point and every live point after it ' +
    'are restored newest first (updates re-written from their snapshot, created documents ' +
    'deleted, deleted documents recreated with their ids). Omit `pointId` to undo the latest ' +
    'live point. Use it when your own read-back shows a write went wrong, or when DatJavaClass ' +
    'asks; he also has a Roll back button on every card in the box, and a rollback he triggers ' +
    'reaches you as a system prompt (rollback:true) - re-read the world before continuing. ' +
    'Returns {rolledBack:[{id,summary,state,failed}]}; `partial` means some documents could ' +
    'not be restored (check the box card and the day log, tell him). Not a redo: rolling back ' +
    'a rollback is not possible.',
    {
      pointId: z.string().optional().describe('rp-xxxxxx from a result or foundry_rollback_points; omit = latest live point'),
      tabId: TAB_PARAM,
    },
    async ({ pointId, tabId }) => asText(await rollbacks.rollbackTo(pointId, { via: 'tool' }), tabId)
  );

  server.tool(
    'foundry_log',
    'Read the AAGM-C day log (2.0, DESIGN §15.4): one markdown file per day (YYYY-MM-DD.md ' +
    'under the project Logs folder), one line per thing done with a time stamp: prompts, ' +
    'replies, writes with their rollback point ids, rollbacks, damage, seat changes, session ' +
    'starts and stops. Pass `date` for another day (omit = today) and `tail` for the last N ' +
    'lines (0 = whole file). `list:true` returns the available dates instead.',
    {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD; omit = today'),
      tail: z.number().int().min(0).max(2000).optional().describe('Last N lines; 0 or omit = all'),
      list: z.boolean().optional().describe('true = list available log dates'),
    },
    async ({ date, tail, list }) => list ? raw({ dir: daylog.dir, dates: daylog.list() }) : raw(daylog.read(date, tail || 0))
  );

  server.tool(
    'foundry_surface',
    'Read or set the seat (2.0, DESIGN §15.3): "int" (default) = DatJavaClass drives from the ' +
    'in-Foundry chat box and the /aagm loop answers there; "ext" = he drives a Claude Code ' +
    'session in the terminal (AAGM Advanced) and the box is parked: prompts typed there wait ' +
    'until /int, and the loop idles. He normally switches by typing /ext or /int in the box; ' +
    'an AAGM Advanced session should call this with mode "ext" when it starts driving and ' +
    '"int" when it hands the seat back. Omit `mode` to just read it.',
    {
      mode: z.enum(['int', 'ext']).optional().describe('Seat to set; omit to read'),
    },
    async ({ mode }) => raw({ surface: mode ? promptQueue.setSurface(mode, 'tool') : promptQueue.surface, parked: promptQueue.parked.length })
  );

  // Phase 2: reverse channel, box prompts, loop answers

  server.tool(
    'foundry_get_prompts',
    'Long-polling drain of chat messages DatJavaClass typed in the in-Foundry "Open Claude Code Chat" ' +
    'box. This BLOCKS server-side until a message arrives or ~25s elapses, then returns ' +
    '{ prompts: [{promptId,text,tabId,ts,interrupt?,system?,rollback?}], tabs, closedTabs, terminate, ' +
    'surface } (prompts may be empty on timeout). `interrupt:true` = typed while that tab was ' +
    'working (an addendum or redirect); `system:true` = relay authored (a rollback he triggered: ' +
    're-read the world before continuing). `surface` "ext" = he is driving from a terminal ' +
    'Claude (AAGM Advanced): the box is parked, do no work, keep polling and sweeping loot until ' +
    'it reads "int" again. Each prompt belongs to a tab (DESIGN §14: one tab = one task, all on this one ' +
    'listener). With settings.multitasking on, serve each tab with its own background subagent ' +
    'and keep polling; a prompt on an existing tab is a follow-up for that tab\'s agent. ' +
    'A prompt with text "/close" and close:true means DatJavaClass closed that tab (x or typed ' +
    '/close): TaskStop its agent, drop it, send nothing more to that tab. `closedTabs` repeats ' +
    'those ids as a list. `tabs` is the live table {id,title,state}. Because it ' +
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
      r.closedTabs = tabs.drainClosed();
      r.tabs = tabs.list();
      if (r.prompts.length || r.terminate || r.closedTabs.length) {
        audit.log('chat.poll', { count: r.prompts.length, terminate: r.terminate, closed: r.closedTabs.length });
      }
      return raw(r);
    }
  );

  server.tool(
    'foundry_send_reply',
    'Send a reply back into the in-Foundry chat box so DatJavaClass sees it. Call this after ' +
    'foundry_get_prompts returns prompts. Pass the reply `text` and the `tabId` of the prompt ' +
    'you are answering (required whenever more than one tab is open; a reply to a closed tab is ' +
    'shown in the first tab, prefixed with the old tab\'s title). Optionally echo the `promptId`. ' +
    'Set `final:false` for a progress line when more is coming, so the tab keeps its working ' +
    'indicator; the default marks the tab done. Returns { delivered, tabId } - delivered:false ' +
    'means the bridge box/WS is not currently connected (the message is not buffered; tell ' +
    'DatJavaClass on the next poll if it keeps failing).',
    {
      text: z.string().describe('The reply to render in the Foundry chat box'),
      promptId: z.string().optional().describe('The promptId being answered, if known'),
      tabId: z.string().optional().describe('Tab the reply belongs to (from the prompt). Omit = first tab.'),
      final: z.boolean().optional().describe('false = progress line, tab stays working (default true)'),
    },
    async ({ text, promptId, tabId, final }) => {
      const routed = tabs.reply(tabId || tabs.first().id, text, { final: final !== false });
      const delivered = dispatcher.notifyBridge({
        capabilitySet: PHASE1_CAPABILITY_SET,
        method: 'claude.reply',
        params: { promptId, text: routed.text, tabId: routed.tabId },
      });
      audit.log('chat.reply', { promptId, tabId: routed.tabId, delivered, len: text.length });
      daylog?.write('reply', text, { tabId: routed.tabId });
      return asText({ delivered, tabId: routed.tabId }, routed.tabId);
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
      daylog?.write('loot', `restored ${r?.restored?.length ?? 0}, failed ${r?.failed?.length ?? 0}, phantoms acked ${r?.ackedPhantoms ?? 0}`);
      return asText(r);
    }
  );
}
