import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyEval } from '../src/eval-guard.js';
import { WorldSettings } from '../src/world-settings.js';
import { PromptQueue } from '../src/prompt-queue.js';
import { WriteQueue } from '../src/write-queue.js';
import { TabTable } from '../src/tabs.js';

function harness() {
  const subscribers = new Map();
  const dispatcher = {
    subscribe: (name, fn) => subscribers.set(name, fn),
    notifyBridge: () => true,
  };
  const audit = { log: () => {} };
  return { subscribers, dispatcher, audit };
}

test('HP reads stay free and writes classify for rollback', () => {
  assert.equal(classifyEval('return actor.system.attributes.hp.value').category, 'read');
  assert.equal(classifyEval('await actor.update({ hp: 5 })').category, 'mutating');
  assert.equal(classifyEval('actor.applyDamage(5)').category, 'mutating');
  assert.equal(classifyEval('await actor.delete()').category, 'destructive');
});

test('relay settings enforce mode presets', () => {
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
  const interrupts = queue.drainInterrupts('t-a');
  assert.deepEqual(interrupts.map(({ promptId }) => promptId), ['p-a2']);
  assert.deepEqual(queue.drainInterrupts('t-a'), []);
  queue._onPrompt({ text: '/ext', tabId: 't-a' });
  queue._onPrompt({ promptId: 'p-a3', text: 'third', tabId: 't-a' });
  queue._onPrompt({ text: '/int', tabId: 't-a' });
  queue._onPrompt({ promptId: 'p-a4', text: '/ext later', tabId: 't-a' });

  /* /int restores parked prompts ahead of new ones. */
  assert.deepEqual(queue.drain().prompts.map(({ promptId, interrupt }) => [promptId, interrupt]),
    [['p-a1', undefined], ['p-b1', undefined], ['p-a4', undefined]]);
  assert.equal(queue.interactionMode, 'internal');
  assert.deepEqual(tabs.tabs.get('t-a').transcript.map(({ text }) => text), ['first', 'second', '/ext later']);
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
