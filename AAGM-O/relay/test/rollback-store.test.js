import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RollbackStore, localDate } from '../src/rollback-store.js';

const entry = (uuid, op = 'update') => ({ op, uuid, documentName: 'Actor', name: uuid, before: { name: uuid } });

/* Fake bridge answering rollback.apply. */
function fakeDispatcher({ fail = new Set(), redo = false } = {}) {
  const sent = [], notes = [];
  return {
    sent, notes,
    subscribe: () => () => {},
    notifyBridge: ({ method, params }) => { notes.push({ method, params }); return true; },
    sendToBridge: async ({ method, params, timeoutMs }) => {
      sent.push({ method, params, timeoutMs });
      const applied = params.entries.map((e) => ({ uuid: e.uuid, op: e.op, ok: !fail.has(e.uuid) }));
      return { pointId: params.pointId, applied, ...(redo ? { rollback: { entries: [entry(`redo-${params.pointId}`)] } } : {}) };
    },
  };
}

const make = (opts) => {
  const root = mkdtempSync(join(tmpdir(), 'aagm rollback '));
  const events = [], dispatcher = fakeDispatcher(opts);
  const store = new RollbackStore({ root, dispatcher, audit: { log: (event) => events.push(event) } });
  return { root, store, dispatcher, events };
};

test('record persists one file per point and lists newest first', () => {
  const { root, store, dispatcher, events } = make();
  const a = store.record(store.open({ summary: 'A', tabId: 't-main', kind: 'eval' }), [entry('Actor.a'), entry('Actor.b', 'create')]);
  const b = store.record(store.open({ summary: 'B', tabId: 't-main', kind: 'damage' }), []);
  assert.match(a.id, /^rp-[0-9a-f]{6}$/);
  assert.equal(a.captured, '1 update, 1 create');
  assert.deepEqual(a.docs, ['update Actor Actor.a', 'create Actor Actor.b']);
  assert.equal(b.captured, 'no documents touched');
  assert.deepEqual(store.list().map((p) => p.id), [b.id, a.id]);
  const file = join(root, localDate(), `${a.id}.json`);
  assert.ok(existsSync(file));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).state, 'live');
  assert.deepEqual(events, ['rollback.point', 'rollback.point']);
  assert.equal(dispatcher.notes.at(-1).params.event, 'point');
});

test('rollbackTo undoes the chain newest first with 300 second timeouts', async () => {
  const { root, store, dispatcher } = make();
  const a = store.record(store.open({ summary: 'A' }), [entry('Actor.a')]);
  const b = store.record(store.open({ summary: 'B' }), [entry('Actor.b')]);
  const c = store.record(store.open({ summary: 'C' }), [entry('Actor.c')]);
  const r = await store.rollbackTo(b.id);
  assert.deepEqual(dispatcher.sent.map((s) => s.params.pointId), [c.id, b.id]);
  assert.ok(dispatcher.sent.every((s) => s.method === 'rollback.apply' && s.timeoutMs === 300_000));
  assert.deepEqual(r.rolledBack.map((p) => [p.id, p.state]), [[c.id, 'rolled-back'], [b.id, 'rolled-back']]);
  assert.equal(store.get(a.id).state, 'live');
  assert.equal(JSON.parse(readFileSync(join(root, localDate(), `${b.id}.json`), 'utf8')).state, 'rolled-back');
  assert.deepEqual(await store.rollbackTo(b.id), { refused: true, reason: `${b.id} already rolled back` });
  assert.equal((await store.rollbackTo()).target, a.id);
  assert.equal((await store.rollbackTo('rp-nope00')).refused, true);
});

test('a failed entry marks the point partial', async () => {
  const { store } = make({ fail: new Set(['Actor.bad']) });
  const p = store.record(store.open({ summary: 'P' }), [entry('Actor.ok'), entry('Actor.bad')]);
  const r = await store.rollbackTo(p.id);
  assert.equal(r.rolledBack[0].state, 'partial');
  assert.equal(r.rolledBack[0].failed, 1);
  assert.equal(store.list()[0].state, 'partial');
});

test('bridge error stops the chain and marks partial', async () => {
  const { store, dispatcher } = make();
  const a = store.record(store.open({ summary: 'A' }), [entry('Actor.a')]);
  store.record(store.open({ summary: 'B' }), [entry('Actor.b')]);
  dispatcher.sendToBridge = async () => { throw new Error('bridge disconnected'); };
  const r = await store.rollbackTo(a.id);
  assert.equal(r.rolledBack.length, 1);
  assert.equal(r.rolledBack[0].state, 'partial');
  assert.equal(store.get(a.id).state, 'live');
});

test('rollback entries recorded by the bridge become a redo point', async () => {
  const { store, dispatcher } = make({ redo: true });
  const a = store.record(store.open({ summary: 'A' }), [entry('Actor.a')]);
  const r = await store.rollbackTo(a.id);
  assert.equal(r.redoPoint.kind, 'redo');
  assert.equal(r.redoPoint.state, 'live');
  assert.equal(dispatcher.sent[0].params.rp.id, r.redoPoint.id);
  assert.equal(store.latestLive().id, r.redoPoint.id);
});

test('one rollback at a time', async () => {
  const { store, dispatcher } = make();
  const a = store.record(store.open({ summary: 'A' }), [entry('Actor.a')]);
  let release;
  dispatcher.sendToBridge = () => new Promise((resolve) => { release = () => resolve({ applied: [] }); });
  const first = store.rollbackTo(a.id);
  assert.deepEqual(await store.rollbackTo(a.id), { refused: true, reason: 'rollback-busy' });
  release();
  await first;
});

test('today\'s points reload in order, corrupt files skipped', () => {
  const { root, store } = make();
  const a = store.record(store.open({ summary: 'A' }), [entry('Actor.a')]);
  const b = store.record(store.open({ summary: 'B' }), [entry('Actor.b')]);
  writeFileSync(join(root, localDate(), 'rp-badbad.json'), '{broken', 'utf8');
  const again = new RollbackStore({ root, dispatcher: fakeDispatcher(), audit: { log: () => {} } });
  assert.deepEqual(again.list().map((p) => p.id), [b.id, a.id]);
  assert.equal(again.get(a.id).entries[0].uuid, 'Actor.a');
  const c = again.record(again.open({ summary: 'C' }), []);
  assert.ok(again.get(c.id).ts > again.get(b.id).ts);
});
