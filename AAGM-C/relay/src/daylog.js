// Day log, one markdown file per day.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const pad = (n) => String(n).padStart(2, '0');

export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const localTime = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const oneLine = (s, max = 600) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + ' [...]' : t;
};

export class DayLog {
  constructor({ dir, audit }) {
    this.dir = dir;
    this.audit = audit;
    try { mkdirSync(dir, { recursive: true }); } catch (err) { console.error('[daylog] mkdir failed:', err.message); }
  }

  file(date = localDate()) { return join(this.dir, `${date}.md`); }

  // kind: short tag like prompt or write
  write(kind, text, { tabId, surface } = {}) {
    const path = this.file();
    const tag = [tabId, surface === 'ext' ? 'ext' : null].filter(Boolean).join(' ');
    const line = `- ${localTime()} ${tag ? `[${tag}] ` : ''}${kind}: ${oneLine(text)}\n`;
    try {
      if (!existsSync(path)) appendFileSync(path, `# AAGM-C log ${localDate()}\n\n`);
      appendFileSync(path, line);
    } catch (err) {
      this.audit?.log('daylog.error', { message: err.message });
    }
  }

  read(date = localDate(), tail = 0) {
    const path = this.file(date);
    if (!existsSync(path)) return { date, path, lines: [], missing: true };
    const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
    return { date, path, lines: tail > 0 ? lines.slice(-tail) : lines };
  }

  list() {
    try { return readdirSync(this.dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort(); }
    catch { return []; }
  }
}
