/* Streamable HTTP MCP server. */

import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { classifyEval, SEVERITY } from './eval-guard.js';

export async function startMcpServer({ config, dispatcher, audit, promptQueue, capabilitySet, worldSettings, chains, mirror, gateQueue }) {
  const { host, port } = config.mcp;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`refusing to bind MCP server to non-localhost address "${host}"`);
  }

  /* One server per transport. */
  const makeServer = () => {
    const s = new McpServer({ name: 'aagm-o-relay', version: '0.2.0' });
    registerTools(s, dispatcher, audit, promptQueue, capabilitySet, worldSettings, chains, mirror, gateQueue);
    return s;
  };

  const claimPromptListener = (request) => {
    if (request?.method !== 'tools/call' || request.params?.name !== 'foundry_get_prompts') return true;
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

function registerTools(server, dispatcher, audit, promptQueue, capabilitySet, worldSettings, chains, mirror, gateQueue) {
  const callBridge = (method, params) =>
    dispatcher.sendToBridge({ capabilitySet, method, params });
  const asText = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

  server.tool(
    'foundry_ping',
    'Liveness check across the AAGM-O bridge. Returns pong, Foundry server time, the current ' +
    'mode, and the relay-enforced world settings. Use this first to verify the bridge and read posture.',
    {},
    async () => {
      const settings = worldSettings.snapshot();
      return asText({ ...(await callBridge('ping', {})), mode: settings.mode, settings });
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
    'Run JavaScript in the GM\'s Foundry client. READS run immediately. WRITES (create/update/' +
    'setFlag/settings.set/move tokens/HP changes/etc.) are held at a human confirmation gate. The GM sees ' +
    'your `summary`, exact code, and Approve or Deny controls. DELETES need a double ' +
    'confirm. Always set `intent` ("read"|"write"|"destructive") and, for write/destructive, a ' +
    'short plain-English `summary` shown to the GM. The relay takes the stricter of your ' +
    'declared intent and its own classifier, so be honest. Under-declaring just forces a ' +
    'stronger confirm, never skips it. HP is an ordinary gated write here. For damage, prefer ' +
    'foundry_apply_damage because it previews live HP and escalates lethal outcomes. Protected ' +
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
      chainId: z.string().optional().describe('Active Chain Mode grant id for this single-auth gate'),
    },
    async ({ code, intent, summary, awaitResult, captureConsole, chainId }) => {
      const verdict = classifyEval(code);
      const declared = intent === 'destructive' ? 'destructive' : intent === 'write' ? 'mutating' : 'read';
      const effective = SEVERITY[verdict.category] >= SEVERITY[declared] ? verdict.category : declared;
      audit.log('eval.in', { len: code.length, category: verdict.category, declared, effective });

      if (verdict.category === 'db-journal') {
        audit.log('eval.blocked', { category: 'db-journal', match: verdict.match });
        chains.kill('gate-blocked');
        return asText({ blocked: true, reason:
          `Refused: this touches a Database Journal (${verdict.match}), a macro backing store, ` +
          `strictly off-limits even for reads. Use a sheet, compendium, or sidebar. If only that ` +
          `journal contains it, tell the GM it needs the owning macro.` });
      }
      if (effective === 'read') {
        return asText(await callBridge('eval', { code, awaitResult, captureConsole }));
      }
      return gateQueue.run('eval', async () => {
        if (!summary || !summary.trim()) {
          chains.kill('gate-refused');
          return asText({ refused: true, reason:
            `A plain-English \`summary\` is required for any write or destructive eval. It is shown ` +
            `to the GM at the confirmation gate. Re-issue with intent and summary.` });
        }
        const opId = randomUUID();
        const level = effective === 'destructive' ? 'double' : 'single';
        if (level === 'double') chains.kill('escalated-destructive');
        const riding = level === 'single' && chains.consume(chainId, summary.trim());
        if (!riding) {
          const decision = await dispatcher.requestConfirmation({
            capabilitySet, opId, kind: 'eval', level, summary: summary.trim(), code,
          });
          if (!decision.approved) {
            audit.log('eval.denied', { opId, reason: decision.reason });
            chains.kill('gate-denied');
            return asText({ refused: true, reason:
              `Not executed: ${decision.reason}. The GM did not approve. Report that plainly and do not retry ` +
              `unless asked.` });
          }
        }
        let r;
        try {
          r = await dispatcher.sendToBridge({
            capabilitySet, method: 'eval', params: { code, awaitResult, captureConsole }, timeoutMs: 300_000,
          });
        } catch (error) {
          chains.kill('gate-error');
          throw error;
        }
        if (r?.refused || r?.blocked || r?.error) chains.kill('gate-refused');
        else if (riding) chains.complete(chainId);
        audit.log('eval.executed', { opId, chainId: riding ? chainId : null });
        return asText(r);
      });
    }
  );

  server.tool(
    'foundry_apply_damage',
    'Apply damage to one or more actors through the confirmation gate. Pass `targets` (names ' +
    'or UUIDs), positive integer `amount`, and a plain-English `summary` shown to the GM. ' +
    'The relay previews against live HP and selects the gate tier. Outcomes at 1 HP or above use ' +
    'a single confirmation. Any target below 1 HP requires double confirmation. Application is ' +
    'atomic, with no partial writes. Damage hits temp ' +
    'HP first, then value. This manipulates state. It does not adjudicate DR or resistances. Pass ' +
    'the final amount you intend.',
    {
      targets: z.array(z.string()).min(1).describe('Actor names or UUIDs (token UUIDs resolve to their actor)'),
      amount: z.number().int().positive().describe('Damage to deal (positive integer)'),
      summary: z.string().describe('Plain-English description shown to the GM at the gate'),
      note: z.string().optional().describe('Optional context (e.g. damage source)'),
      chainId: z.string().optional().describe('Active Chain Mode grant id for nonlethal damage'),
    },
    async ({ targets, amount, summary, note, chainId }) => gateQueue.run('damage', async () => {
      const plan = await callBridge('damage', { targets, amount, commit: false });
      if (plan && plan.error) {
        chains.kill('gate-error');
        return asText({ error: plan.error });
      }
      audit.log('damage.plan', { n: targets.length, amount, lethal: !!plan.lethal });
      const opId = randomUUID();
      if (plan.lethal) chains.kill('escalated-lethal');
      const riding = !plan.lethal && chains.consume(chainId, summary.trim());
      if (!riding) {
        const decision = await dispatcher.requestConfirmation({
          capabilitySet, opId, kind: 'damage', level: plan.lethal ? 'double' : 'single',
          summary: `${plan.lethal ? 'LETHAL: at least one target drops below 1 HP. ' : ''}${summary.trim()}`,
          preview: plan.preview,
        });
        if (!decision.approved) {
          audit.log('damage.denied', { opId, reason: decision.reason });
          chains.kill('gate-denied');
          return asText({ refused: true, reason: `Not applied: ${decision.reason}.`, preview: plan.preview });
        }
      }
      let result;
      try {
        result = await callBridge('damage', { targets, amount, commit: true, allowLethal: !!plan.lethal });
      } catch (error) {
        chains.kill('gate-error');
        throw error;
      }
      audit.log('damage.commit', { opId, committed: !!result.committed, lethal: !!plan.lethal, chainId: riding ? chainId : null });
      if (!result.committed) {
        chains.kill('commit-race');
        /* Refuse unapproved lethal races. */
        return asText({ refused: true, reason:
          `Not applied because live HP changed after approval, making the operation lethal. ` +
          `Reissue it for a fresh double confirmation.`, preview: result.preview });
      }
      if (riding) chains.complete(chainId);
      return asText(result);
    })
  );

  server.tool(
    'foundry_chain_offer',
    'Offer one GM approval for a homogeneous batch of relay-classified single-auth gates. ' +
    'Use only when settings.chainOffers is true and count meets chainOfferThreshold. Pass the ' +
    'returned chainId on every gate. Deletes, lethal outcomes, errors, refusals, TTL, count, ' +
    'off-manifest gates, and GM cancellation end the chain immediately.',
    {
      count: z.number().int().min(2).describe('Exact number of single-auth gates in the batch'),
      summary: z.string().min(1).describe('Homogeneous batch manifest shown to the GM'),
    },
    async ({ count, summary }) => gateQueue.run('chain.offer', async () => asText(await chains.offer({ count, summary })))
  );

  server.tool(
    'foundry_mirror_backup',
    'Back up world macro source beneath the configured Macro Mirror path. Omit name for all ' +
    'macros. Existing files rotate to .bkp and no file is deleted. Reads are ungated.',
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
    'List available Macro Mirror .js backups beneath the configured mirror path. Use this ' +
    'before a bulk restore, then offer a chain when the batch meets the configured threshold.',
    {},
    async () => {
      try { return asText(await mirror.list()); }
      catch (error) { return asText({ refused: true, reason: error.message }); }
    }
  );

  server.tool(
    'foundry_mirror_restore',
    'Restore one world macro from its mirrored .js file. This is a gated write. Existing macros ' +
    'update by UUID. Vanished macros are recreated using the three-line header. For bulk restore, ' +
    'list backups, offer an eligible chain, then call once per macro with that chainId.',
    {
      name: z.string().min(1).describe('Macro name matching the mirrored filename'),
      chainId: z.string().optional().describe('Active Chain Mode grant id for bulk restore'),
    },
    async ({ name, chainId }) => gateQueue.run('mirror.restore', async () => {
      let record;
      try { record = await mirror.read(name); }
      catch (error) {
        chains.kill('gate-error');
        return asText({ refused: true, reason: error.message });
      }
      const opId = randomUUID();
      const summary = `Restore macro "${record.name}" from ${record.file}`;
      const riding = chains.consume(chainId, summary);
      if (!riding) {
        const decision = await dispatcher.requestConfirmation({
          capabilitySet, opId, kind: 'macro-restore', level: 'single', summary, code: record.command,
        });
        if (!decision.approved) {
          chains.kill('gate-denied');
          return asText({ refused: true, reason: decision.reason });
        }
      }
      let result;
      try {
        result = await callBridge('mirror.restore', { record });
      } catch (error) {
        chains.kill('gate-error');
        throw error;
      }
      if (result?.refused || result?.blocked || result?.error) {
        chains.kill('gate-refused');
      } else if (riding) {
        chains.complete(chainId);
      }
      audit.log('mirror.restore', { opId, name: record.name, created: !!result?.created, chainId: riding ? chainId : null });
      return asText(result);
    })
  );

  /* Foundry chat channel. */

  server.tool(
    'foundry_get_prompts',
    'Long-polling drain of chat messages the GM typed in the in-Foundry "Open AAGM-O Chat" ' +
    'box. This BLOCKS server-side until a message arrives or ~25s elapses, then returns ' +
    '{ prompts: [{promptId,text,ts}], terminate } (prompts may be empty on timeout). Because it ' +
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
      if (r.prompts.length || r.terminate) {
        audit.log('chat.poll', { count: r.prompts.length, terminate: r.terminate });
      }
      return asText(r);
    }
  );

  server.tool(
    'foundry_send_reply',
    'Send a reply back into the in-Foundry chat box so the GM sees it. Call this after ' +
    'foundry_get_prompts returns prompts. Pass the reply `text`. Optionally echo the `promptId` ' +
    'you are answering. Returns { delivered }. False means the bridge box or WebSocket is not currently ' +
    'connected. The message is not buffered, so report repeated delivery failures on the next poll.',
    {
      text: z.string().describe('The reply to render in the Foundry chat box'),
      promptId: z.string().optional().describe('The promptId being answered, if known'),
    },
    async ({ text, promptId }) => {
      const delivered = dispatcher.notifyBridge({
        capabilitySet,
        method: 'aagm.reply',
        params: { promptId, text },
      });
      audit.log('chat.reply', { promptId, delivered, len: text.length });
      return asText({ delivered });
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
    'is ungated because it can only recreate the recorded item, recorded shortfall quantity, ' +
    'and recorded recipient. Omit eventIds to restore all pending entries. Phantom records are ' +
    'never restorable. Acknowledge reported phantoms with ackPhantoms.',
    {
      eventIds: z.array(z.string()).optional().describe('Pending eventIds to restore. Omit for all pending.'),
      ackPhantoms: z.array(z.string()).optional().describe('Reported phantom eventIds to clear'),
    },
    async ({ eventIds, ackPhantoms }) => gateQueue.run('loot.restore', async () => {
      const result = await callBridge('loot.restore', { eventIds, ackPhantoms });
      audit.log('loot.restore', {
        requested: eventIds?.length ?? 'all',
        restored: result?.restored?.length ?? 0,
        failed: result?.failed?.length ?? 0,
        ackedPhantoms: result?.ackedPhantoms ?? 0,
      });
      return asText(result);
    })
  );

}
