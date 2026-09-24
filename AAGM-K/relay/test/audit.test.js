import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

import { Audit } from '../src/audit.js';

test('audit writes one local Markdown session log and keeps stdout format', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'aagm audit '));
  const started = new Date(2026, 8, 24, 14, 5, 6, 7), calls = [];
  const originalLog = console.log;
  console.log = (line) => calls.push(line);
  try {
    const audit = new Audit({ logDir, now: () => started });
    audit.log('chat.in', { promptId: 'p1', len: 3 });
    const name = basename(audit.logPath), text = readFileSync(audit.logPath, 'utf8');
    assert.equal(name, 'September 24 14.05.06.md');
    assert.match(text, /# AAGM O audit/);
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
