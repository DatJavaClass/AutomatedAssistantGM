/* Rollback points: the documents each write touched. */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const MAX_INDEX = 200; // points kept per relay run
const APPLY_TIMEOUT_MS = 300_000;

export function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class RollbackStore {
  constructor({ root, dispatcher, audit, capabilitySet = 'gm' }) {
    Object.assign(this, { root, dispatcher, audit, capabilitySet });
    this.points = []; // oldest first
    this.busy = false; // one rollback at a time
    this.lastTs = 0;
    this.load();
    dispatcher?.subscribe('aagm.status.request', () => this.notify({ event: 'sync', points: this.list() }));
  }

  /* Today's points return after a restart. */
  load() {
    const day = join(this.root, localDate());
    if (!existsSync(day)) return;
    for (const f of readdirSync(day).filter((n) => /^rp-[0-9a-f]+\.json$/.test(n))) {
      try {
        const p = JSON.parse(readFileSync(join(day, f), 'utf8'));
        if (p?.id && typeof p.ts === 'string' && Array.isArray(p.entries)) this.points.push(p);
      } catch { /* skip corrupt */ }
    }
    this.points.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    this.points.splice(0, Math.max(0, this.points.length - MAX_INDEX));
    this.lastTs = Math.max(0, ...this.points.map((p) => Date.parse(p.ts) || 0));
  }

  open({ summary, tabId, kind }) {
    this.lastTs = Math.max(Date.now(), this.lastTs + 1); // strict order within a millisecond
    const d = new Date(this.lastTs);
    let id;
    do id = `rp-${randomBytes(3).toString('hex')}`; while (this.get(id));
    return { id, ts: d.toISOString(), date: localDate(d), summary, tabId: tabId || null, kind };
  }

  /* Bridge returned: point lands on disk and box. */
  record(rp, entries = [], extra = {}) {
    const point = { ...rp, entries: Array.isArray(entries) ? entries : [], state: 'live', ...extra };
    this.points.push(point);
    if (this.points.length > MAX_INDEX) this.points.shift();
    this.persist(point);
    this.audit.log('rollback.point', { id: point.id, tabId: point.tabId, kind: point.kind, entries: point.entries.length });
    this.notify({ event: 'point', point: this.brief(point) });
    return this.brief(point);
  }

  get(id) { return this.points.find((p) => p.id === id) || null; }
  latestLive() { return this.points.findLast((p) => p.state === 'live') || null; }
  list() { return this.points.map((p) => this.brief(p)).reverse(); } // newest first

  /* Undo the point and every later live point. */
  async rollbackTo(pointId, { via = 'tool' } = {}) {
    if (this.busy) return { refused: true, reason: 'rollback-busy' };
    const target = pointId ? this.get(pointId) : this.latestLive();
    if (!target) return { refused: true, reason: pointId ? `unknown point ${pointId}` : 'no live rollback point' };
    const chain = this.points.slice(this.points.indexOf(target)).filter((p) => p.state === 'live').reverse();
    if (!chain.length) return { refused: true, reason: `${target.id} already rolled back` };
    this.busy = true;
    const done = [], redo = [];
    const rp = this.open({ summary: `Redo: undo the rollback to ${target.id}`, tabId: target.tabId, kind: 'redo' });
    try {
      for (const p of chain) {
        let r;
        try {
          r = await this.dispatcher.sendToBridge({ capabilitySet: this.capabilitySet, method: 'rollback.apply',
            params: { pointId: p.id, entries: p.entries, rp: { id: rp.id } }, timeoutMs: APPLY_TIMEOUT_MS });
        } catch (err) {
          r = { applied: [], error: err.message, rollback: err.data?.rollback };
        }
        redo.push(...(r?.rollback?.entries || []));
        const failed = (r?.applied || []).filter((a) => !a?.ok).length + (r?.error ? 1 : 0);
        Object.assign(p, { state: failed ? 'partial' : 'rolled-back', via, result: { applied: r?.applied || [], error: r?.error } });
        this.persist(p);
        this.audit.log('rollback.applied', { id: p.id, via, failed, state: p.state });
        done.push({ id: p.id, summary: p.summary, state: p.state, failed, error: r?.error });
        this.notify({ event: 'rolled-back', point: this.brief(p), via });
        if (r?.error) break; // bridge gone, stop the chain
      }
    } finally { this.busy = false; }
    const redoPoint = redo.length ? this.record(rp, redo) : null;
    return { rolledBack: done, target: target.id, via, redoPoint };
  }

  brief(p) {
    const n = {};
    for (const e of p.entries) n[e.op] = (n[e.op] || 0) + 1;
    return {
      id: p.id, ts: p.ts, summary: p.summary, tabId: p.tabId, kind: p.kind, state: p.state, via: p.via,
      captured: Object.entries(n).map(([k, v]) => `${v} ${k}`).join(', ') || 'no documents touched',
      docs: p.entries.slice(0, 12).map((e) => `${e.op} ${e.documentName} ${e.name || e.uuid}`),
      file: `${p.date || localDate(new Date(p.ts))}/${p.id}.json`,
    };
  }

  persist(p) {
    try {
      const day = join(this.root, p.date || localDate(new Date(p.ts)));
      mkdirSync(day, { recursive: true });
      const file = join(day, `${p.id}.json`);
      writeFileSync(`${file}.tmp`, JSON.stringify(p));
      renameSync(`${file}.tmp`, file);
    } catch (err) { this.audit.log('rollback.persist_error', { id: p.id, message: err.message }); }
  }

  notify(params) {
    this.dispatcher?.notifyBridge({ capabilitySet: this.capabilitySet, method: 'aagm.rollback', params });
  }
}
