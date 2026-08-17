import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyEval } from '../src/eval-guard.js';
import { WorldSettings } from '../src/world-settings.js';
import { PromptQueue } from '../src/prompt-queue.js';
import { ChainRegistry } from '../src/chain.js';
import { GateQueue } from '../src/gate-queue.js';

function harness() {
  const subscribers = new Map(), events = [];
  const dispatcher = {
    subscribe: (name, fn) => subscribers.set(name, fn),
    notifyBridge: () => true,
    requestConfirmation: async () => ({ approved: true, reason: 'approved' }),
  };
  const audit = { log: (event, data) => events.push({ event, data }) };
  return { subscribers, events, dispatcher, audit };
}

test('HP reads stay free and writes gate', () => {
  assert.equal(classifyEval('return actor.system.attributes.hp.value').category, 'read');
  assert.equal(classifyEval('await actor.update({ hp: 5 })').category, 'mutating');
  assert.equal(classifyEval('actor.applyDamage(5)').category, 'mutating');
  assert.equal(classifyEval('await actor.delete()').category, 'destructive');
});

test('relay settings enforce presets and caps', () => {
  const { dispatcher, audit } = harness();
  const settings = new WorldSettings({ dispatcher, audit });
  settings.update({ mode: 'assistant', multitasking: true, chainOffers: true, chainMaxLength: 500 });
  assert.equal(settings.get('multitasking'), false);
  assert.equal(settings.get('chainOffers'), false);
  assert.equal(settings.get('chainMaxLength'), 40);
  settings.update({ mode: 'custom', multitasking: true, chainOffers: true });
  assert.equal(settings.get('multitasking'), true);
  assert.equal(settings.get('chainOffers'), true);
});

test('listener ownership releases on terminate', () => {
  const { dispatcher, audit } = harness();
  const queue = new PromptQueue({ dispatcher, audit, stopFilePath: null, capabilitySet: 'gm' });
  assert.equal(queue.claimListener('listener-one'), true);
  assert.equal(queue.claimListener('listener-two'), false);
  queue._onPrompt({ text: '/exit' });
  assert.equal(queue.drain().terminate, true);
  assert.equal(queue.claimListener('listener-two'), true);
});

test('write queue never interleaves tasks', async () => {
  const { audit } = harness();
  const queue = new GateQueue({ audit });
  let active = 0, maximum = 0;
  const run = (delay) => queue.run('test', async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active--;
  });
  await Promise.all([run(20), run(5), run(1)]);
  assert.equal(maximum, 1);
});

test('chains enforce threshold, count, mismatch, and cancel', async () => {
  const { dispatcher, audit, events, subscribers } = harness();
  const values = { chainOffers: true, chainOfferThreshold: 2, chainMaxLength: 4 };
  const chains = new ChainRegistry({ dispatcher, audit, settings: { get: (key) => values[key] }, capabilitySet: 'gm' });
  assert.equal((await chains.offer({ count: 1, summary: 'too small' })).refused, true);
  let grant = await chains.offer({ count: 2, summary: 'two writes' });
  assert.equal(chains.consume(grant.chainId, 'one'), true);
  assert.equal(chains.consume(grant.chainId, 'two'), true);
  chains.complete(grant.chainId);
  assert.equal(chains.active, null);
  grant = await chains.offer({ count: 2, summary: 'another batch' });
  assert.equal(chains.consume('wrong-id', 'wrong'), false);
  assert.equal(chains.active, null);
  grant = await chains.offer({ count: 2, summary: 'cancelled batch' });
  subscribers.get('aagm.chain.cancel')({ chainId: grant.chainId });
  assert.equal(chains.active, null);
  assert.ok(events.some(({ event, data }) => event === 'chain.end' && data.reason === 'count-exhausted'));
  assert.ok(events.some(({ event, data }) => event === 'chain.end' && data.reason === 'off-manifest-gate'));
  assert.ok(events.some(({ event, data }) => event === 'chain.end' && data.reason === 'gm-cancel'));
});
