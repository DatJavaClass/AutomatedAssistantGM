import test from 'node:test';
import assert from 'node:assert/strict';

import { Dispatcher } from '../src/dispatcher.js';
import { PromptQueue } from '../src/prompt-queue.js';
import { TabTable } from '../src/tabs.js';
import { WorldSettings } from '../src/world-settings.js';
import { WriteQueue } from '../src/write-queue.js';
import { startMcpServer } from '../src/mcp-server.js';
import { RollbackStore } from '../src/rollback-store.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('tabs route prompts, interrupts, rollback points, and closure through MCP', { timeout: 15000 }, async () => {
  const audit = { log: () => {}, listLogs: () => [], readLog: () => '' }, outbox = [];
  const dispatcher = new Dispatcher({ audit });
  const tabs = new TabTable({ dispatcher, audit, capabilitySet: 'gm' });
  const promptQueue = new PromptQueue({ dispatcher, audit, capabilitySet: 'gm', stopFilePath: null, tabs });
  const worldSettings = new WorldSettings({ dispatcher, audit });
  const writeQueue = new WriteQueue({ audit });
  const rollbacks = new RollbackStore({ root: mkdtempSync(join(tmpdir(), 'aagm tabs ')), dispatcher, audit, capabilitySet: 'gm' });
  const touched = [{ op: 'update', uuid: 'Actor.x', documentName: 'Actor', name: 'X', before: { name: 'X' } }];
  dispatcher.registerBridge({
    sessionId: 'fake', userId: 'gm', userName: 'GM', capabilitySet: 'gm',
    capabilities: new Set(['eval', 'rollback.apply']), send: (message) => {
      outbox.push(message);
      if (!message.id) return;
      const { method, params } = message;
      const reply = method === 'rollback.apply'
        ? { result: { pointId: params.pointId, applied: params.entries.map((e) => ({ uuid: e.uuid, op: e.op, ok: true })) } }
        : params.code?.includes('FAIL_WRITE')
          ? { error: { code: -33002, message: 'eval: execution threw: write failed', data: { rollback: { entries: touched } } } }
          : { result: params.rp ? { ok: true, rollback: { entries: touched } } : { ok: true } };
      queueMicrotask(() => dispatcher.resolveResponse({ id: message.id, ...reply }));
    },
  });
  const mcp = await startMcpServer({
    config: { mcp: { host: '127.0.0.1', port: 0 } }, dispatcher, audit, promptQueue,
    capabilitySet: 'gm', worldSettings, mirror: {}, writeQueue, rollbacks, tabs,
  });
  const port = mcp.server.address().port;
  let rpcId = 0;
  const box = (method, params = {}) => dispatcher.routeNotification({ method, params });
  const sent = (method) => outbox.filter((message) => message.method === method);
  const last = (method) => sent(method).at(-1)?.params;
  const waitFor = async (check) => {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('expected relay event did not arrive');
  };
  const call = async (name, args = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await response.json();
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
    if (body.result.isError) throw new Error(body.result.content[0].text);
    return JSON.parse(body.result.content[0].text);
  };

  try {
    box('aagm.prompt', { promptId: 'p1', text: 'Build out the goblin lair please', tabId: 't-a' });
    box('aagm.prompt', { promptId: 'p2', text: 'hello' });
    assert.equal(tabs.tabs.get('t-a').title, 'Build out the goblin lai');
    assert.equal(tabs.tabs.get('t-a').state, 'working');
    assert.ok(tabs.tabs.has('t-main'));
    assert.equal(last('aagm.tabs').tabs.length, 2);
    let result = await call('foundry_get_prompts', { listenerId: 'listener-one' });
    assert.deepEqual(result.prompts.map((prompt) => prompt.tabId), ['t-a', 't-main']);
    assert.equal(result.mode, 'internal');
    assert.equal(result.tabs.length, 2);
    assert.deepEqual(result.closedTabs, []);
    await assert.rejects(call('foundry_get_prompts', { listenerId: 'listener-two' }), { code: -33005 });

    box('aagm.prompt', { promptId: 'p3', text: 'follow up', tabId: 't-a' });
    result = await call('foundry_get_prompts', { listenerId: 'listener-one' });
    assert.deepEqual(result.prompts.map(({ text, interrupt }) => [text, interrupt]), [['follow up', true]]);
    box('aagm.prompt', { text: '/ext', tabId: 't-a' });
    assert.equal(promptQueue.interactionMode, 'external');
    assert.equal(last('aagm.mode').mode, 'external');
    const repliesBeforeExternal = sent('aagm.reply').length;
    assert.deepEqual(await call('foundry_send_reply', { text: 'late external reply', tabId: 't-a' }), {
      delivered: false, tabId: 't-a', refused: true, reason: 'external-mode',
    });
    assert.equal(sent('aagm.reply').length, repliesBeforeExternal);
    assert.deepEqual(await call('foundry_eval', {
      code: 'await actor.update({name:"blocked"})', intent: 'write', summary: 'Blocked internal write', tabId: 't-a',
    }), { refused: true, reason: 'external-mode: internal worker writes are suspended' });
    assert.equal(sent('eval').length, 0);
    box('aagm.prompt', { text: '/int', tabId: 't-a' });
    assert.equal(promptQueue.interactionMode, 'internal');
    assert.equal(last('aagm.mode').mode, 'internal');

    result = await call('foundry_send_reply', { text: 'working', tabId: 't-a', final: false });
    assert.deepEqual(result, { delivered: true, tabId: 't-a' });
    assert.equal(tabs.tabs.get('t-a').state, 'working');
    await call('foundry_send_reply', { text: 'done', tabId: 't-a' });
    assert.equal(tabs.tabs.get('t-a').state, 'done');
    assert.equal(last('aagm.reply').tabId, 't-a');
    for (let i = 0; i < 45; i++) box('aagm.prompt', { text: `line ${i}`, tabId: 't-b' });
    assert.equal(tabs.tabs.get('t-b').transcript.length, 40);
    assert.equal(tabs.tabs.get('t-b').transcript[0].text, 'line 5');
    await call('foundry_get_prompts', { listenerId: 'listener-one' });

    box('aagm.prompt', { text: '/close', tabId: 't-a' });
    assert.equal(tabs.tabs.has('t-a'), false);
    result = await call('foundry_get_prompts', { listenerId: 'listener-one' });
    assert.deepEqual(result.prompts.map(({ text, tabId, close }) => [text, tabId, close]), [['/close', 't-a', true]]);
    assert.deepEqual(result.closedTabs, ['t-a']);
    const repliesBeforeLate = sent('aagm.reply').length;
    assert.deepEqual(await call('foundry_send_reply', { text: 'late', tabId: 't-a' }), {
      delivered: false, tabId: 't-a', dropped: true,
    });
    assert.equal(sent('aagm.reply').length, repliesBeforeLate);
    box('aagm.prompt', { text: '/close', tabId: 't-unknown' });
    box('aagm.prompt', { text: 'next', tabId: 't-main' });
    result = await call('foundry_get_prompts', { listenerId: 'listener-one' });
    assert.deepEqual(result.prompts.map((prompt) => prompt.text), ['next']);
    assert.deepEqual(result.closedTabs, []);

    box('aagm.status.request');
    assert.equal(last('aagm.tabs').tabs.find((tab) => tab.id === 't-main').transcript.at(-1).text, 'next');
    const writeResult = await call('foundry_eval', {
      code: 'await game.actors.get("x").update({name:"Y"})', intent: 'write', summary: 'Rename actor', tabId: 't-b',
    });
    assert.equal(writeResult.ok, true);
    assert.equal(writeResult.rollback, undefined);
    assert.equal(writeResult.rollbackPoint.summary, 'Rename actor');
    assert.equal(writeResult.rollbackPoint.captured, '1 update');
    assert.equal(writeResult.rollbackPoint.tabId, 't-b');
    assert.match(sent('eval')[0].params.rp.id, /^rp-[0-9a-f]{6}$/);
    assert.equal(sent('aagm.confirm').length, 0);
    assert.equal(last('aagm.rollback').event, 'point');
    assert.equal(last('aagm.rollback').point.id, writeResult.rollbackPoint.id);

    const listed = await call('foundry_rollback_points');
    assert.equal(listed.points[0].id, writeResult.rollbackPoint.id);
    const rolledBack = await call('foundry_rollback', { rollbackId: writeResult.rollbackPoint.id, tabId: 't-b' });
    assert.deepEqual(rolledBack.rolledBack.map((p) => p.state), ['rolled-back']);
    assert.deepEqual(last('rollback.apply').entries, [{ op: 'update', uuid: 'Actor.x', documentName: 'Actor', name: 'X', before: { name: 'X' } }]);
    assert.equal(last('aagm.rollback').event, 'rolled-back');

    await assert.rejects(call('foundry_eval', {
      code: 'await actor.update({name:"FAIL_WRITE"})', intent: 'write', summary: 'Failing write', tabId: 't-b',
    }), /write failed \(rollback point rp-[0-9a-f]{6} holds 1 update/);
    assert.equal(sent('rollback.apply').length, 1);
    assert.equal(rollbacks.list()[0].summary, 'Failing write');

    box('aagm.prompt', { text: '/exit', tabId: 't-b' });
    result = await call('foundry_get_prompts', { listenerId: 'listener-one' });
    assert.equal(result.terminate, true);
    assert.deepEqual(result.tabs, []);
    assert.equal(tabs.tabs.size, 0);
  } finally {
    await new Promise((resolve) => mcp.server.close(resolve));
  }
});
