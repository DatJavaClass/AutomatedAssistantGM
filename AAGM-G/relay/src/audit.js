/* Standard output and Markdown audit sink. */

import { appendFileSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function localTime(date) {
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function logName(date, n = 0) {
  const time = `${String(date.getHours()).padStart(2, '0')}.${String(date.getMinutes()).padStart(2, '0')}.${String(date.getSeconds()).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${time}${n ? ` ${n}` : ''}.md`;
}

function json(data, space = 0) {
  try {
    return JSON.stringify(data, null, space) ?? 'undefined';
  } catch (err) {
    return `<unserializable: ${err.message}>`;
  }
}

const LOG_TEXT_LIMIT = 4000;

/* Cap long strings before they hit the log. */
export function truncateForLog(str) {
  if (typeof str !== 'string' || str.length <= LOG_TEXT_LIMIT) return str;
  return `${str.slice(0, LOG_TEXT_LIMIT)} [... ${str.length - LOG_TEXT_LIMIT} more chars]`;
}

/* Same cap on each top level string field. */
export function truncateFields(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, truncateForLog(v)]));
}

export class Audit {
  constructor({ stdout = true, logDir = null, now = () => new Date() } = {}) {
    this.toStdout = stdout;
    this.logDir = logDir ? resolve(logDir) : null;
    this.now = now;
    this.logPath = null;
    if (this.logDir) {
      try { this.logPath = this.createLog(); }
      catch (err) { console.error(`[audit] could not create log at ${this.logDir}, stdout only:`, err.message); }
    }
  }

  createLog() {
    mkdirSync(this.logDir, { recursive: true });
    for (let n = 0; ; n++) {
      const path = join(this.logDir, logName(this.now(), n));
      try {
        const fd = openSync(path, 'wx');
        try {
          writeFileSync(fd, `# AAGM-G\n\nStarted: ${localTime(this.now())}\n`, 'utf8');
        } finally {
          closeSync(fd);
        }
        return path;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
  }

  log(event, data = {}) {
    const date = this.now(), payload = json(data);
    if (this.logPath) {
      const formatted = json(data, 2);
      try {
        appendFileSync(this.logPath, `\n## ${localTime(date)} ${event}\n\n\`\`\`json\n${formatted}\n\`\`\`\n`, 'utf8');
      } catch {}
    }
    if (this.toStdout) console.log(`${date.toISOString()} ${event} ${payload}`); // one line per event, grep friendly
  }

  listLogs() {
    if (!this.logDir) return [];
    try {
      return readdirSync(this.logDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md')
        .map((entry) => {
          const path = join(this.logDir, entry.name), info = lstatSync(path);
          return { name: entry.name, bytes: info.size, modified: info.mtime.toISOString() };
        })
        .sort((a, b) => b.modified.localeCompare(a.modified));
    } catch {
      return [];
    }
  }

  get filePath() { return this.logPath; }

  readLog(name) {
    if (name == null && this.logPath) name = basename(this.logPath);
    if (!this.logDir || typeof name !== 'string' || basename(name) !== name || extname(name).toLowerCase() !== '.md') {
      throw new Error('Audit log name is not valid.');
    }
    const path = resolve(this.logDir, name);
    const localPath = relative(this.logDir, path);
    if (localPath.startsWith('..') || isAbsolute(localPath)) throw new Error('Audit log path is outside the log directory.');
    if (!lstatSync(path).isFile()) throw new Error('Audit log was not found.');
    return readFileSync(path, 'utf8');
  }
}
