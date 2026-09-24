import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyEval } from '../src/eval-guard.js';
import { WorldSettings } from '../src/world-settings.js';
import { PromptQueue } from '../src/prompt-queue.js';
import { TabTable } from '../src/tabs.js';
import { WriteQueue } from '../src/write-queue.js';

function harness() {
  const dispatcher = { subscribe: () => () => {}, notifyBridge: () => true };
  const audit = { log: () => {} };
  return { dispatcher, audit };
}

test('eval guard classifies reads, writes, and side effects', () => {
  assert.equal(classifyEval('return actor.system.attributes.hp.value').category, 'read');
  assert.equal(classifyEval('await actor.update({ hp: 5 })').category, 'mutating');
  assert.equal(classifyEval('actor.applyDamage(5)').category, 'mutating');
  assert.equal(classifyEval('await actor.delete()').category, 'destructive');
  assert.equal(classifyEval('ChatMessage.create({ content: "hi" })').category, 'side-effect');
  assert.equal(classifyEval('ChatMessage.createDocuments([{ content: "hi" }])').category, 'side-effect');
  assert.equal(classifyEval('actor.sheet.render(true)').category, 'side-effect');
});

test('relay settings enforce presets', () => {
  const { dispatcher, audit } = harness();
  const settings = new WorldSettings({ dispatcher, audit });
  settings.update({ mode: 'assistant', multitasking: true });
  assert.equal(settings.get('multitasking'), false);
  settings.update({ mode: 'cogm', multitasking: false });
  assert.equal(settings.get('multitasking'), true);
  settings.update({ mode: 'custom', multitasking: true });
  assert.equal(settings.get('multitasking'), true);
});

test('listener ownership releases on terminate', () => {
  const { dispatcher, audit } = harness();
  const tabs = new TabTable({ dispatcher, audit, capabilitySet: 'gm' });
  const queue = new PromptQueue({ dispatcher, audit, stopFilePath: null, capabilitySet: 'gm', tabs });
  assert.equal(queue.claimListener('listener-one'), true);
  assert.equal(queue.claimListener('listener-two'), false);
  queue._onPrompt({ text: '/exit' });
  assert.equal(queue.drain().terminate, true);
  assert.equal(queue.claimListener('listener-two'), true);
});

test('prompt modes intercept commands and drain tab interrupts once', () => {
  const { dispatcher, audit } = harness();
  const tabs = new TabTable({ dispatcher, audit, capabilitySet: 'gm' });
  const queue = new PromptQueue({ dispatcher, audit, stopFilePath: null, capabilitySet: 'gm', tabs });
  queue._onPrompt({ promptId: 'p-a1', text: 'first', tabId: 't-a' });
  queue._onPrompt({ promptId: 'p-b1', text: 'other', tabId: 't-b' });
  queue._onPrompt({ promptId: 'p-a2', text: 'second', tabId: 't-a' });
  queue._onPrompt({ text: '/ext', tabId: 't-a' });
  queue._onPrompt({ promptId: 'p-a3', text: 'third', tabId: 't-a' });
  queue._onPrompt({ text: '/int', tabId: 't-a' });
  queue._onPrompt({ promptId: 'p-a4', text: '/ext later', tabId: 't-a' });

  const interrupts = queue.drainInterrupts('t-a');
  assert.deepEqual(interrupts.map(({ promptId }) => promptId), ['p-a2', 'p-a3', 'p-a4']);
  assert.deepEqual(queue.drainInterrupts('t-a'), []);
  assert.deepEqual(queue.drain().prompts.map(({ promptId }) => promptId), ['p-a1', 'p-b1']);
  assert.equal(queue.parked.length, 0);
  assert.equal(queue.interactionMode, 'internal');
  assert.deepEqual(tabs.tabs.get('t-a').transcript.map(({ text }) => text), ['first', 'second', 'third', '/ext later']);
});

test('external mode holds the listener and keeps the prompt for the next tool', () => {
  const { dispatcher, audit } = harness();
  const tabs = new TabTable({ dispatcher, audit, capabilitySet: 'gm' });
  const queue = new PromptQueue({ dispatcher, audit, stopFilePath: null, capabilitySet: 'gm', tabs });
  queue.claimListener('listener-one');
  queue._onPrompt({ text: '/ext', tabId: 't-main' });
  queue._onPrompt({ promptId: 'p-x', text: 'from the box', tabId: 't-main' });
  const held = queue.drain();
  assert.equal(held.hold, true);
  assert.deepEqual(held.prompts, []);
  assert.equal(queue.takeInterrupt('t-main')[0].promptId, 'p-x');
  assert.equal(queue.claimListener('listener-two'), true);
});

test('external mode parks a queued prompt and /int returns it', async () => {
  const { dispatcher, audit } = harness();
  const events = [];
  audit.log = (event, data) => events.push([event, data?.count]);
  const tabs = new TabTable({ dispatcher, audit, capabilitySet: 'gm' });
  const queue = new PromptQueue({ dispatcher, audit, stopFilePath: null, capabilitySet: 'gm', tabs });
  queue._onPrompt({ promptId: 'p-before', text: 'roll initiative', tabId: 't-main' });
  queue._onPrompt({ text: '/ext', tabId: 't-main' });
  assert.equal(queue.parked.length, 1);
  const held = queue.drain();
  assert.equal(held.hold, true);
  assert.deepEqual(queue.takeInterrupt('t-main'), []);
  queue._onPrompt({ text: '/ext', tabId: 't-main' });
  assert.equal(queue.parked.length, 1);
  const waiting = queue.waitForWork({ timeoutMs: 5000 }), t0 = Date.now();
  queue._onPrompt({ text: '/int', tabId: 't-main' });
  await waiting;
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(queue.parked.length, 0);
  assert.deepEqual(queue.drain().prompts.map(({ promptId }) => promptId), ['p-before']);
  assert.deepEqual(events.filter(([e]) => e.endsWith('parked')), [['chat.external.parked', 1], ['chat.internal.unparked', 1]]);
});

test('write queue never interleaves tasks', async () => {
  const { audit } = harness();
  const queue = new WriteQueue({ audit });
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
