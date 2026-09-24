import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

import { Audit, truncateFields, truncateForLog } from '../src/audit.js';

test('audit writes one local Markdown session log and keeps stdout format', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'aagm audit '));
  const started = new Date(2026, 8, 24, 14, 5, 6, 7), calls = [];
  const originalLog = console.log;
  console.log = (line) => calls.push(line);
  try {
    const audit = new Audit({ logDir, now: () => started });
    audit.log('chat.in', { promptId: 'p1', len: 3 });
    const name = basename(audit.logPath), text = readFileSync(audit.logPath, 'utf8');
    assert.equal(name, 'September 24 14.05.06.007.md');
    assert.match(text, /# AAGM-G/);
    assert.match(text, /## September 24, 2026 14:05:06 chat\.in/);
    assert.match(text, /"promptId": "p1"/);
    assert.deepEqual(audit.listLogs().map((entry) => entry.name), [name]);
    assert.equal(audit.readLog(name), text);
    assert.throws(() => audit.readLog('../outside.md'), /not valid/);
    assert.deepEqual(calls, ['2026-09-24T18:05:06.007Z chat.in {"promptId":"p1","len":3}']);
  } finally {
    console.log = originalLog;
  }
});

test('audit falls back to stdout when the log cannot be created', () => {
  const blocker = join(mkdtempSync(join(tmpdir(), 'aagm audit ')), 'file');
  writeFileSync(blocker, 'not a folder', 'utf8');
  const errors = [], originalError = console.error, originalLog = console.log;
  console.error = (...args) => errors.push(args.join(' '));
  console.log = () => {};
  try {
    const audit = new Audit({ logDir: join(blocker, 'Logs') });
    assert.equal(audit.logPath, null);
    audit.log('chat.in', { promptId: 'p1' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /stdout only/);
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
});

test('log text is capped at 4000 characters', () => {
  const long = 'x'.repeat(4500);
  assert.equal(truncateForLog('short'), 'short');
  assert.equal(truncateForLog(long), `${'x'.repeat(4000)} [... 500 more chars]`);
  assert.deepEqual(truncateFields({ code: long, n: 3 }), { code: truncateForLog(long), n: 3 });
});
