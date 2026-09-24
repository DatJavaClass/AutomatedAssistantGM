import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

const INVALID = /[<>:"/\\|?*\x00-\x1f]/g;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export class MacroMirror {
  constructor({ settings, audit }) {
    this.settings = settings;
    this.audit = audit;
  }

  async backup(macros) {
    const root = await this._root();
    const contextual = this.settings.get('mirrorContextualSort');
    const directories = contextual ? await listDirectories(root) : [];
    const written = [], failed = [], targets = new Set();
    for (const macro of macros || []) {
      try {
        validateMacro(macro);
        const folder = contextual ? await chooseFolder(root, directories, macro.folderPath) : root;
        await mkdir(folder, { recursive: true });
        const scopedFolder = await realpath(folder);
        assertInside(root, scopedFolder);
        const target = resolve(scopedFolder, `${sanitizeSegment(macro.name)}.js`);
        assertInside(root, target);
        const key = target.toLowerCase();
        if (targets.has(key)) throw new Error('sanitized filename collision');
        targets.add(key);
        if (await exists(target)) await copyFile(target, `${target}.bkp`);
        await writeFile(target, renderMacro(macro), 'utf8');
        written.push(relative(root, target));
      } catch (error) {
        failed.push({ name: macro?.name ?? null, reason: error.message });
      }
    }
    this.audit.log('mirror.backup', { written: written.length, failed: failed.length });
    return { root, written, failed };
  }

  async list() {
    const root = await this._root();
    const files = await listFiles(root);
    return { root, backups: files.map((file) => relative(root, file)) };
  }

  async read(name) {
    const root = await this._root();
    const expected = `${sanitizeSegment(name)}.js`.toLowerCase();
    const matches = (await listFiles(root)).filter((file) => basename(file).toLowerCase() === expected);
    if (!matches.length) throw new Error(`mirror backup not found for "${name}"`);
    if (matches.length > 1) throw new Error(`multiple mirror backups match "${name}"`);
    assertInside(root, matches[0]);
    const text = await readFile(matches[0], 'utf8');
    const record = parseMacro(text, basename(matches[0], '.js'));
    this.audit.log('mirror.read', { file: relative(root, matches[0]), uuid: record.uuid });
    return { ...record, file: relative(root, matches[0]) };
  }

  async _root() {
    if (!this.settings.get('mirrorEnabled')) throw new Error('Macro Mirror is disabled');
    const configured = String(this.settings.get('mirrorPath') || '').trim();
    if (!configured) throw new Error('Macro Mirror path is empty');
    if (!isAbsolute(configured)) throw new Error('Macro Mirror path must be absolute');
    let root;
    try { root = await realpath(configured); } catch { throw new Error(`Macro Mirror path does not exist: ${configured}`); }
    if (!(await stat(root)).isDirectory()) throw new Error(`Macro Mirror path is not a directory: ${configured}`);
    return root;
  }
}

function validateMacro(macro) {
  if (!macro || typeof macro.name !== 'string' || !macro.name.trim()) throw new Error('macro name is required');
  if (typeof macro.uuid !== 'string' || !macro.uuid.trim()) throw new Error('macro UUID is required');
  if (typeof macro.command !== 'string') throw new Error('macro command must be text');
}

function renderMacro(macro) {
  const clean = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ');
  return `// Macro UUID: ${clean(macro.uuid)} | Name: ${JSON.stringify(macro.name)}\n// Foundry folder: ${clean(macro.folderPath)}\n// Image: ${clean(macro.img)}\n${macro.command}`;
}

function parseMacro(text, name) {
  const lines = text.split(/\r?\n/);
  const first = lines[0]?.match(/^\/\/ Macro UUID:\s*(\S+)(?:\s+\|\s+Name:\s*(.+))?$/);
  const uuid = first?.[1]?.trim();
  const folderPath = lines[1]?.match(/^\/\/ Foundry folder:\s*(.*)$/)?.[1]?.trim() ?? null;
  const img = lines[2]?.match(/^\/\/ Image:\s*(.*)$/)?.[1]?.trim() ?? null;
  if (!uuid || folderPath === null || img === null) throw new Error('invalid three-line mirror header');
  if (first?.[2]) {
    try { name = JSON.parse(first[2]); } catch { throw new Error('invalid macro name in mirror header'); }
  }
  return { uuid, folderPath, img, name, command: lines.slice(3).join('\n') };
}

async function chooseFolder(root, directories, folderPath) {
  const parts = String(folderPath || '').split('/').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return root;
  const wanted = normalize(parts.at(-1));
  const matches = directories.filter((folder) => normalize(basename(folder)) === wanted);
  if (matches.length === 1) return matches[0];
  const literal = resolve(root, ...parts.map(sanitizeSegment));
  assertInside(root, literal);
  return literal;
}

async function listDirectories(root) {
  const found = [];
  const walk = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = join(folder, entry.name);
      assertInside(root, child);
      found.push(child);
      await walk(child);
    }
  };
  await walk(root);
  return found;
}

async function listFiles(root) {
  const found = [];
  const walk = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = join(folder, entry.name);
      assertInside(root, child);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.js')) found.push(child);
    }
  };
  await walk(root);
  return found;
}

function sanitizeSegment(value) {
  let clean = String(value || '').replace(INVALID, '_').replace(/[. ]+$/g, '').trim();
  if (!clean || clean === '.' || clean === '..') clean = 'untitled';
  if (RESERVED.test(clean)) clean = `_${clean}`;
  return clean;
}

function normalize(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

function assertInside(root, target) {
  const rel = relative(root, target);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return;
  throw new Error('Macro Mirror path escaped its configured root');
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
