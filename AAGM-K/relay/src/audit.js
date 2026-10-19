/* Standard output and Markdown audit sink. */

import { appendFileSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';

const MONTHS = [ // month names
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function localTime(date) {
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function logName(date, n = 0) {
  const time = `${String(date.getHours()).padStart(2, '0')}.${String(date.getMinutes()).padStart(2, '0')}.${String(date.getSeconds()).padStart(2, '0')}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${time}${n ? ` ${n}` : ''}.md`;
}

function json(data, space = 0) {
  try {
    return JSON.stringify(data, null, space) ?? 'undefined';
  } catch (err) {
    return `<unserializable: ${err.message}>`;
  }
}

const LOG_TEXT_LIMIT = 4000; // log truncation cap

/* Cap long strings before they hit the log. */
export function truncateForLog(str) {
  if (typeof str !== 'string' || str.length <= LOG_TEXT_LIMIT) return str; // short or non string returns as is
  return `${str.slice(0, LOG_TEXT_LIMIT)} [... ${str.length - LOG_TEXT_LIMIT} more chars]`;
}

export class Audit {
  constructor({ stdout = true, logDir = null, now = () => new Date() } = {}) {
    this.toStdout = stdout;
    this.logDir = logDir ? resolve(logDir) : null;
    this.now = now;
    this.logPath = null;
    if (this.logDir) { // log dir set creates file, else skips
      try { this.logPath = this.createLog(); }
      catch (err) { console.error(`[audit] could not create log at ${this.logDir}:`, err.message); }
    }
  }

  createLog() {
    mkdirSync(this.logDir, { recursive: true });
    for (let n = 0; ; n++) { // retries names, returns path, errors throw
      const path = join(this.logDir, logName(this.now(), n));
      try {
        const fd = openSync(path, 'wx');
        try {
          writeFileSync(fd, `# AAGM O audit\n\nStarted: ${localTime(this.now())}\n`, 'utf8');
        } finally {
          closeSync(fd);
        }
        return path;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err; // other errors throw, EEXIST retries
      }
    }
  }

  log(event, data = {}) {
    const date = this.now(), payload = json(data);
    if (this.logPath) { // file log on appends, off skips
      const formatted = json(data, 2);
      appendFileSync(this.logPath, `\n## ${localTime(date)} ${event}\n\n\`\`\`json\n${formatted}\n\`\`\`\n`, 'utf8');
    }
    if (this.toStdout) console.log(`${date.toISOString()} ${event} ${payload}`); // stdout on prints, off skips
  }

  listLogs() {
    if (!this.logDir) return []; // no log dir returns empty list
    try {
      return readdirSync(this.logDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.md') // keeps .md files only
        .map((entry) => { // entry becomes name, size, mtime
          const path = join(this.logDir, entry.name), info = lstatSync(path);
          return { name: entry.name, bytes: info.size, modified: info.mtime.toISOString() };
        })
        .sort((a, b) => b.modified.localeCompare(a.modified)); // newest modified first
    } catch {
      return [];
    }
  }

  readLog(name) {
    if (name == null && this.logPath) name = basename(this.logPath); // no name defaults to current log
    if (!this.logDir || typeof name !== 'string' || basename(name) !== name || extname(name).toLowerCase() !== '.md') { // invalid name throws, valid continues
      throw new Error('Audit log name is not valid.');
    }
    const path = resolve(this.logDir, name);
    const localPath = relative(this.logDir, path);
    if (localPath.startsWith('..') || isAbsolute(localPath)) throw new Error('Audit log path is outside the log directory.'); // outside log dir throws
    let info;
    try { info = lstatSync(path); } catch { throw new Error('Audit log was not found.'); } // stat fails, throws not found
    if (!info.isFile()) throw new Error('Audit log was not found.'); // non file throws, file reads
    try { return readFileSync(path, 'utf8'); } catch { throw new Error('Audit log could not be read.'); } // read fails, throws unreadable
  }
}
