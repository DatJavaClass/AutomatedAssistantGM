/* Streamable HTTP MCP server. */

import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { classifyEval, SEVERITY } from './eval-guard.js';
import { truncateForLog } from './audit.js';

export async function startMcpServer({
  config, dispatcher, audit, promptQueue, capabilitySet, worldSettings,
  mirror, writeQueue, rollbacks, tabs,
}) {
  const { host, port } = config.mcp;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`refusing to bind MCP server to non-localhost address "${host}"`);
  }

  /* One server per transport. */
  const makeServer = () => {
    const s = new McpServer({ name: 'aagm-o-relay', version: '2.0.0' });
    registerTools(s, dispatcher, audit, promptQueue, capabilitySet, worldSettings, mirror, writeQueue, rollbacks, tabs);
    return s;
  };

  const claimPromptListener = (request) => {
    if (request?.method !== 'tools/call'
      || !['foundry_get_prompts', 'foundry_get_interrupts'].includes(request.params?.name)) return true;
    const listenerId = request.params?.arguments?.listenerId;
    if (typeof listenerId !== 'string' || listenerId.length < 4) return true;
    if (promptQueue.claimListener(listenerId)) return true;
    audit.log('chat.refused', { listenerId });
    dispatcher.notifyBridge({ capabilitySet, method: 'aagm.listener.refused', params: {} });
    return false;
  };

  const httpServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/mcp') {
      handlePost(req, res, makeServer, audit, claimPromptListener);
      return;
    }
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bridges: dispatcher.bridges.size }));
      return;
    }
    if ((req.method === 'GET' || req.method === 'DELETE') && req.url === '/mcp') {
      res.writeHead(405, { 'content-type': 'application/json', 'allow': 'POST' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Use POST.' }, id: null }));
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

async function handlePost(req, res, makeServer, audit, claimPromptListener) {
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
    if (parsed?.method === 'tools/call') {
      audit.log('mcp.call', { name: parsed.params?.name, arguments: parsed.params?.arguments || {} });
    }
    if (!claimPromptListener(parsed)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -33005, message: 'listener-occupied: another AAGM-O listener is already active' },
        id: parsed?.id ?? null,
      }));
      return;
    }
    /* Stateless transport. */
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

function registerTools(server, dispatcher, audit, promptQueue, capabilitySet, worldSettings, mirror, writeQueue, rollbacks, tabs) {
  const callBridge = (method, params, timeoutMs) =>
    dispatcher.sendToBridge({ capabilitySet, method, params, ...(timeoutMs ? { timeoutMs } : {}) });
  const asText = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
  const tabParam = z.string().optional().describe('Prompt tab id used for routing and rollback notices.');
  /* Recorded write: bridge returns the touched documents. */
  const rollbackWrite = async ({ label, kind, tabId }, method, params) => writeQueue.run(label, async () => {
    if (promptQueue.interactionMode === 'external' && tabId) {
      return { refused: true, reason: 'external-mode: internal worker writes are suspended' };
    }
    const rp = rollbacks.open({ summary: label, tabId: tabs.resolve(tabId), kind });
    let r;
    try { r = await callBridge(method, { ...params, rp: { id: rp.id } }, 300_000); }
    catch (err) {
      const entries = err?.data?.rollback?.entries; // writes before the throw
      if (Array.isArray(entries) && entries.length) {
        const point = rollbacks.record(rp, entries, { failed: err.message });
        err.message += ` (rollback point ${point.id} holds ${point.captured}; foundry_rollback can undo it)`;
      }
      audit.log('write.result', { label, error: err.message });
      throw err;
    }
    const { rollback, ...rest } = r && typeof r === 'object' && !Array.isArray(r) ? r : { value: r };
    const point = rollbacks.record(rp, rollback?.entries || []);
    audit.log('write.result', { label, rollbackId: point.id, result: rest });
    return { ...rest, rollbackPoint: point };
  });
  const notifyMode = () => dispatcher.notifyBridge({
    capabilitySet, method: 'aagm.mode', params: { mode: promptQueue.interactionMode },
  });

  server.tool(
    'foundry_ping',
    'Liveness check across the AAGM-O bridge. Returns pong, Foundry server time, the current ' +
    'mode, and the relay-enforced world settings. Use this first to verify the bridge and read posture.',
    {},
    async () => {
      const settings = worldSettings.snapshot();
      return asText({
        ...(await callBridge('ping', {})), mode: settings.mode, settings,
        interactionMode: promptQueue.interactionMode,
        parked: promptQueue.parked.length,
        logFile: audit.logPath || null,
      });
    }
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
      sceneId: z.string().optional().describe('Foundry scene _id. Omit for the active scene.'),
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
    'List Foundry users with online status and character ownership. Pass `userId` to fetch one user. Omit it for all users.',
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
      filter: z.string().optional().describe('Optional regex. Entries whose message does not match are dropped.'),
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
    'Run JavaScript in the GM\'s Foundry client. Reads run immediately. A document or ' +
    'world-setting write runs at once while the bridge records every document it touches; the ' +
    'relay persists that as a rollback point and returns its ID and captured docs. Always set `intent` ("read"|"write"|"destructive") and give writes a short ' +
    '`summary` used to label the rollback point. The relay takes the stricter of your declared ' +
    'intent and its own classifier. Chat messages, socket emissions, hook calls, and UI activation ' +
    'are refused because a rollback point cannot reverse them. For damage, prefer ' +
    'foundry_apply_damage because it previews live HP first. Protected ' +
    'Database Journals, including "NPC Register", Mail-Mailbox Index, and runManaged pages, ' +
    'are never touched, even for reads. Use a sheet, compendium, or sidebar. If the journal is ' +
    'the only source, tell the GM it needs the owning macro. ' +
    'Idioms: partial-name game.actors.filter(...includes); gold actor.system.currency.{pp,gp,' +
    'sp,cp}; classes actor.items.filter(i=>i.type==="class").c.system.level; "what scene is X ' +
    'on" walk game.scenes→scene.tokens→tokenDoc.actor; compendia fromUuid/pack.getIndex()→' +
    'getDocument; sidebar game.actors/items/journal/tables/macros(.command)/playlists/scenes/' +
    'folders. Result is depth/size-capped & circular-safe. If a call returns {refused:true} or ' +
    '{blocked:true}, relay that to the GM verbatim. Do not retry or work around the guard.',
    {
      code: z.string().describe('Async function body. Use return + await.'),
      intent: z.enum(['read', 'write', 'destructive']).optional().describe('Declare the effect. Default read.'),
      summary: z.string().optional().describe('Plain-English description shown to the GM. Required for writes and destructive actions.'),
      awaitResult: z.boolean().optional().describe('Await a returned thenable before serializing (default true)'),
      captureConsole: z.boolean().optional().describe('Debug mode returns console output and thrown errors without failing the call. Stateless per call.'),
      tabId: tabParam,
    },
    async ({ code, intent, summary, awaitResult, captureConsole, tabId }) => {
      const verdict = classifyEval(code);
      const declared = intent === 'destructive' ? 'destructive' : intent === 'write' ? 'mutating' : 'read';
      const effective = SEVERITY[verdict.category] >= SEVERITY[declared] ? verdict.category : declared;
      audit.log('eval.in', { code: truncateForLog(code), category: verdict.category, declared, effective, summary: summary || null });

      if (verdict.category === 'db-journal') {
        audit.log('eval.blocked', { category: 'db-journal', match: verdict.match });
        return asText({ blocked: true, reason:
          `Refused: this touches a Database Journal (${verdict.match}), a macro backing store, ` +
          `strictly off-limits even for reads. Use a sheet, compendium, or sidebar. If only that ` +
          `journal contains it, tell the GM it needs the owning macro.` });
      }
      if (verdict.category === 'side-effect') {
        audit.log('eval.blocked', { category: 'side-effect', match: verdict.match });
        return asText({ blocked: true, reason:
          `Refused: this action (${verdict.match}) cannot be reversed by a rollback point. ` +
          `Use a document or world-setting operation with rollback coverage.` });
      }
      if (effective === 'read') {
        return asText(await callBridge('eval', { code, awaitResult, captureConsole }));
      }
      if (!summary || !summary.trim()) return asText({ refused: true, reason:
        'A plain-English `summary` is required to label the rollback point for a write.' });
      const kind = effective === 'destructive' ? 'destructive eval' : 'eval';
      return asText(await rollbackWrite({ label: summary.trim(), kind, tabId }, 'eval', { code, awaitResult, captureConsole }));
    }
  );

  server.tool(
    'foundry_apply_damage',
    'Apply damage to one or more actors behind a rollback point. Pass `targets` ' +
    '(names or UUIDs), positive integer `amount`, and a plain-English `summary` used to label ' +
    'the point. The point records each actor the commit touches. Damage hits temp ' +
    'HP first, then value. This manipulates state. It does not adjudicate DR or resistances. Pass ' +
    'the final amount you intend. Targets are written in sequence; a failed commit still keeps ' +
    'a point for the actors already written. Lethal outcomes apply at once behind the ' +
    'rollback point; the result flags `lethal`.',
    {
      targets: z.array(z.string()).min(1).describe('Actor names or UUIDs (token UUIDs resolve to their actor)'),
      amount: z.number().int().positive().describe('Damage to deal (positive integer)'),
      summary: z.string().trim().min(1).describe('Plain-English rollback point label'),
      note: z.string().optional().describe('Optional context (e.g. damage source)'),
      tabId: tabParam,
    },
    async ({ targets, amount, summary, note, tabId }) => {
      const plan = await callBridge('damage', { targets, amount, commit: false }, 120_000);
      if (plan?.error) return asText({ error: plan.error });
      audit.log('damage.plan', { targets, amount, lethal: !!plan.lethal, preview: plan.preview, note: note || null });
      const label = `${summary.trim()}${plan.lethal ? ' (lethal)' : ''}`;
      const result = await rollbackWrite({ label, kind: 'damage', tabId }, 'damage', { targets, amount, commit: true });
      return asText({ ...result, lethal: !!plan.lethal });
    }
  );

  server.tool(
    'foundry_mirror_backup',
    'Back up world macro source beneath the configured Macro Mirror path. Omit name for all ' +
    'macros. Existing files rotate to .bkp and no file is deleted. This tool is read-only.',
    {
      name: z.string().optional().describe('Exact world macro name. Omit for all macros.'),
    },
    async ({ name }) => {
      try {
        const result = await callBridge('mirror.list', { name });
        if (name && !result.macros?.length) return asText({ refused: true, reason: `world macro not found: ${name}` });
        return asText(await mirror.backup(result.macros || []));
      } catch (error) {
        return asText({ refused: true, reason: error.message });
      }
    }
  );

  server.tool(
    'foundry_mirror_backups',
    'List available Macro Mirror .js backups beneath the configured mirror path before restoring.',
    {},
    async () => {
      try { return asText(await mirror.list()); }
      catch (error) { return asText({ refused: true, reason: error.message }); }
    }
  );

  server.tool(
    'foundry_mirror_restore',
    'Restore one world macro from its mirrored .js file behind a rollback point. ' +
    'Existing macros update by UUID. Vanished macros are recreated using the three-line header.',
    {
      name: z.string().min(1).describe('Macro name matching the mirrored filename'),
      tabId: tabParam,
    },
    async ({ name, tabId }) => {
      let record;
      try { record = await mirror.read(name); }
      catch (error) { return asText({ refused: true, reason: error.message }); }
      const summary = `Restore macro "${record.name}" from ${record.file}`;
      const result = await rollbackWrite({ label: summary, kind: 'mirror.restore', tabId }, 'mirror.restore', { record });
      audit.log('mirror.restore', {
        name: record.name,
        created: !!result?.created,
        rollbackId: result?.rollbackPoint?.id || null,
        refused: !!result?.refused,
      });
      return asText(result);
    }
  );

  server.tool(
    'foundry_rollback_points',
    'List rollback points newest first (today\'s survive a relay restart). Each point lists the ' +
    'documents one write touched: `captured` counts per op, `docs` names the first twelve, ' +
    '`state` is live, rolled-back, or partial.',
    {},
    async () => asText({ points: rollbacks.list() })
  );

  server.tool(
    'foundry_session_logs',
    'List local AAGM-O Markdown session logs newest first.',
    {},
    async () => asText({ logs: audit.listLogs() })
  );

  server.tool(
    'foundry_read_session_log',
    'Read one local AAGM-O Markdown session log. Omit `name` for the current log.',
    { name: z.string().optional().describe('Exact .md filename returned by foundry_session_logs') },
    async ({ name }) => asText(audit.readLog(name))
  );

  server.tool(
    'foundry_rollback',
    'Roll back to before a point: that point and every later live point are undone newest ' +
    'first (updated documents rewritten from their record, created ones deleted, deleted ones ' +
    'recreated with their ids). Documents the points did not touch are left alone. Omit ' +
    '`rollbackId` for the newest live point. Returns {rolledBack:[{id,summary,state,failed}], ' +
    'redoPoint}; `partial` means some documents could not be restored, so tell the GM. ' +
    '`redoPoint` records what the rollback changed; roll it back to redo.',
    {
      rollbackId: z.string().optional().describe('Rollback point id. Omit for the newest live point.'),
      tabId: tabParam,
    },
    async ({ rollbackId, tabId }) => writeQueue.run('rollback', async () => {
      if (promptQueue.interactionMode === 'external' && tabId) {
        return asText({ refused: true, reason: 'external-mode: internal worker writes are suspended' });
      }
      return asText(await rollbacks.rollbackTo(rollbackId, { via: 'tool' }));
    })
  );

  /* Foundry chat channel. */

  server.tool(
    'foundry_get_prompts',
    'Long-polling drain of chat messages the GM typed in the in-Foundry "Open AAGM-O Chat" ' +
    'box. This BLOCKS server-side until a message arrives or ~25s elapses, then returns ' +
    '{ prompts: [{promptId,text,tabId,ts,interrupt?,close?}], tabs, closedTabs, terminate, mode }. ' +
    'An interrupt is a follow-up sent while that tab is working. Forward it immediately to ' +
    'the active worker instead of waiting for the prior task to finish. ' +
    'A /close prompt with close:true means the GM closed that tab. Stop its agent and send ' +
    'nothing more to it. closedTabs repeats closed ids and drains once. Because it ' +
    'blocks, call it back-to-back with NO added delay or sleep. Do not pace it yourself. The ' +
    'server provides the pacing and pickup is near-instant. Calling this marks the box "Ready to ' +
    'chat". If `terminate` is true, STOP the loop immediately. Do not reschedule or poll ' +
    'again. The GM requested shutdown through /exit or the local .loop-stop file. Answer each ' +
    'prompt with foundry_send_reply. listenerId is required: generate it once at startup and ' +
    'reuse it for every poll. If another id owns the slot, report the -33005 error and stop.',
    {
      listenerId: z.string().min(4).describe('Stable listener id generated once at startup'),
    },
    async ({ listenerId }) => {
      if (!promptQueue.claimListener(listenerId)) {
        audit.log('chat.refused', { listenerId });
        dispatcher.notifyBridge({ capabilitySet, method: 'aagm.listener.refused', params: {} });
        const error = new Error('listener-occupied: another AAGM-O listener is already draining this chat box');
        error.code = -33005;
        throw error;
      }
      await promptQueue.waitForWork();
      const r = promptQueue.drain();
      r.mode = promptQueue.interactionMode;
      r.tabs = tabs.list();
      r.closedTabs = tabs.drainClosed();
      if (r.prompts.length || r.terminate || r.closedTabs.length) {
        audit.log('chat.poll', { count: r.prompts.length, terminate: r.terminate, closed: r.closedTabs.length });
      }
      return asText(r);
    }
  );

  server.tool(
    'foundry_get_interrupts',
    'Nonblocking check for follow-up messages sent to one working tab. Use this at safe ' +
    'checkpoints when serving the box synchronously. Returned prompts are removed from the ' +
    'normal queue so they are never handled twice.',
    {
      listenerId: z.string().min(4).describe('The active listener id'),
      tabId: z.string().min(1).describe('The working tab id'),
    },
    async ({ listenerId, tabId }) => {
      if (!promptQueue.claimListener(listenerId)) {
        const error = new Error('listener-occupied: another AAGM-O listener owns this chat box');
        error.code = -33005;
        throw error;
      }
      return asText({ prompts: promptQueue.drainInterrupts(tabId), mode: promptQueue.interactionMode });
    }
  );

  server.tool(
    'foundry_set_interaction_mode',
    'Set whether the GM is working inside the Foundry chat or with an external Codex instance. ' +
    'This is the MCP equivalent of /int and /ext.',
    { mode: z.enum(['internal', 'external']) },
    async ({ mode }) => {
      promptQueue.setInteractionMode(mode, 'mcp');
      notifyMode();
      return asText({ mode: promptQueue.interactionMode });
    }
  );

  server.tool(
    'foundry_send_reply',
    'Send a reply back into the in-Foundry chat box so the GM sees it. Call this after ' +
    'foundry_get_prompts returns prompts. Pass `text` and its `tabId`; tabId is required ' +
    'when multiple tabs are open. Set final:false for a progress line. Optionally echo the ' +
    '`promptId` you are answering. Returns { delivered, tabId }. False means the bridge box or WebSocket is not currently ' +
    'connected. The message is not buffered, so report repeated delivery failures on the next poll.',
    {
      text: z.string().describe('The reply to render in the Foundry chat box'),
      promptId: z.string().optional().describe('The promptId being answered, if known'),
      tabId: z.string().optional().describe('Prompt tab id. Omit to route to the first tab.'),
      final: z.boolean().optional().describe('false keeps the tab working. Default true marks it done.'),
    },
    async ({ text, promptId, tabId, final }) => {
      if (promptQueue.interactionMode === 'external') {
        audit.log('chat.reply.dropped', { promptId, tabId, reason: 'external-mode', text: truncateForLog(text) });
        return asText({ delivered: false, tabId: tabId || null, refused: true, reason: 'external-mode' });
      }
      const routed = tabs.reply(tabId || tabs.first().id, text, { final: final !== false });
      if (routed.dropped) return asText({ delivered: false, tabId: routed.tabId, dropped: true });
      const delivered = dispatcher.notifyBridge({
        capabilitySet,
        method: 'aagm.reply',
        params: { promptId, text: routed.text, tabId: routed.tabId },
      });
      audit.log('chat.reply', { promptId, tabId: routed.tabId, delivered, text: truncateForLog(text) });
      return asText({ delivered, tabId: routed.tabId });
    }
  );

  server.tool(
    'foundry_set_status',
    'Update the chat status line for background work without speaking in the conversation. ' +
    'Available only when relay-enforced multitasking is enabled. Set clear=true when work ends.',
    {
      text: z.string().optional().describe('Short background-work status'),
      count: z.number().int().min(0).optional().describe('Active background task count'),
      clear: z.boolean().optional().describe('Restore normal listener status'),
    },
    async ({ text, count, clear }) => {
      if (!worldSettings.get('multitasking')) return asText({ refused: true, reason: 'multitasking-disabled' });
      const params = clear ? promptQueue.status() : {
        state: 'working',
        text: String(text || '').trim() || 'Background work running',
        count: count ?? 1,
      };
      const delivered = dispatcher.notifyBridge({ capabilitySet, method: 'aagm.status', params });
      audit.log('chat.work-status', { delivered, ...params });
      return asText({ delivered, ...params });
    }
  );

  server.tool(
    'foundry_loot_pending',
    'Read the AAGM-O Loot Watchdog rescue queue. Returns pending real items, report-only ' +
    'phantoms, and a legacy record count. Restore pending items with foundry_restore_loot. ' +
    'Report phantoms to the GM and acknowledge them only after reporting.',
    {},
    async () => asText(await callBridge('loot.pending', {}))
  );

  server.tool(
    'foundry_restore_loot',
    'Restore vanished loot recorded by the AAGM-O Loot Watchdog. This constrained primitive ' +
    'can only recreate the recorded item, recorded shortfall quantity, and recorded recipient. ' +
    'Its rollback point covers the recreated items, never the protected rescue journal. Omit ' +
    'eventIds to restore all pending entries. Phantom records are ' +
    'never restorable. Acknowledge reported phantoms with ackPhantoms.',
    {
      eventIds: z.array(z.string()).optional().describe('Pending eventIds to restore. Omit for all pending.'),
      ackPhantoms: z.array(z.string()).optional().describe('Reported phantom eventIds to clear'),
      tabId: tabParam,
    },
    async ({ eventIds, ackPhantoms, tabId }) => {
      const result = await rollbackWrite({ label: 'Restore Loot Watchdog records', kind: 'loot.restore', tabId },
        'loot.restore', { eventIds, ackPhantoms });
      audit.log('loot.restore', {
        requested: eventIds?.length ?? 'all',
        restored: result?.restored?.length ?? 0,
        failed: result?.failed?.length ?? 0,
        ackedPhantoms: result?.ackedPhantoms ?? 0,
      });
      return asText(result);
    }
  );

}
