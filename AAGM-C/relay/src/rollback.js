// Rollback Points store and rollback chain.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { localDate } from './daylog.js';

const CAPABILITY_SET = 'debug';
const MAX_INDEX = 200; /* points remembered per relay run */

export class RollbackStore {
  constructor({ dir, dispatcher, audit, daylog }) {
    this.dir = dir;
    this.dispatcher = dispatcher;
    this.audit = audit;
    this.daylog = daylog;
    this.points = []; /* oldest first */
    this.busy = false; /* one rollback at a time */
    this.onRolledBack = null; /* prompt-queue tells the loop */
    this._load();
    dispatcher.subscribe('claude.hello', () => this._notify({ event: 'sync', points: this.list() }));
    dispatcher.subscribe('claude.rollback.request', (p) => this.rollbackTo(p?.pointId, { via: 'box' }).catch((err) => {
      this.audit.log('rollback.error', { pointId: p?.pointId, message: err.message });
      this._notify({ event: 'error', pointId: p?.pointId, text: err.message });
    }));
  }

  // Today's points come back after a relay restart.
  _load() {
    const day = join(this.dir, localDate());
    if (!existsSync(day)) return;
    for (const f of readdirSync(day).filter((n) => n.endsWith('.json')).sort()) {
      try { this.points.push(JSON.parse(readFileSync(join(day, f), 'utf8'))); } catch { /* skip corrupt */ }
    }
    this.points.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    if (this.points.length > MAX_INDEX) this.points.splice(0, this.points.length - MAX_INDEX);
  }

  open({ summary, tabId, kind }) {
    const id = `rp-${randomBytes(3).toString('hex')}`;
    return { id, summary, tabId, kind, ts: new Date().toISOString(), date: localDate() };
  }

  // Bridge returned; snapshot lands on disk, box
  record(rp, entries = [], extra = {}) {
    const point = { ...rp, entries, state: 'live', ...extra };
    this.points.push(point);
    if (this.points.length > MAX_INDEX) this.points.shift();
    this._persist(point);
    this.audit.log('rollback.point', { id: point.id, tabId: point.tabId, kind: point.kind, entries: entries.length });
    this.daylog?.write('write', `${point.id} ${point.summary} (${this._brief(point)})`, { tabId: point.tabId });
    this._notify({ event: 'point', point: this._public(point) });
    return this._public(point);
  }

  get(id) { return this.points.find((p) => p.id === id) || null; }
  latestLive() { for (let i = this.points.length - 1; i >= 0; i--) if (this.points[i].state === 'live') return this.points[i]; return null; }
  list() { return this.points.map((p) => this._public(p)); }

  // Rolls back point plus everything after, newest first
  async rollbackTo(pointId, { via = 'tool' } = {}) {
    if (this.busy) return { refused: true, reason: 'rollback-busy' };
    const target = pointId ? this.get(pointId) : this.latestLive();
    if (!target) return { refused: true, reason: pointId ? `unknown point ${pointId}` : 'no live rollback point' };
    const idx = this.points.indexOf(target);
    const chain = this.points.slice(idx).filter((p) => p.state === 'live').reverse();
    if (!chain.length) return { refused: true, reason: `${target.id} already rolled back` };
    this.busy = true;
    const done = [];
    try {
      for (const p of chain) {
        let r;
        try {
          r = await this.dispatcher.sendToBridge({ capabilitySet: CAPABILITY_SET, method: 'rollback.apply', params: { pointId: p.id, entries: p.entries }, timeoutMs: 300_000 });
        } catch (err) {
          r = { applied: [], error: err.message };
        }
        const failed = (r.applied || []).filter((a) => !a.ok).length + (r.error ? 1 : 0);
        p.state = failed ? 'partial' : 'rolled-back';
        p.via = via;
        p.result = r;
        this._persist(p);
        this.audit.log('rollback.applied', { id: p.id, via, failed, state: p.state });
        this.daylog?.write('rollback', `${p.id} ${p.summary}: ${p.state}${r.error ? ` (${r.error})` : ''} via ${via}`, { tabId: p.tabId });
        done.push({ id: p.id, summary: p.summary, state: p.state, failed, error: r.error });
        this._notify({ event: 'rolled-back', point: this._public(p), via });
        if (r.error) break; /* bridge gone: stop the chain */
      }
    } finally { this.busy = false; }
    const result = { rolledBack: done, target: target.id, via };
    try { this.onRolledBack?.(result); } catch { /* best effort */ }
    return result;
  }

  _brief(p) {
    const n = {};
    for (const e of p.entries) n[e.op] = (n[e.op] || 0) + 1;
    return Object.entries(n).map(([k, v]) => `${v} ${k}`).join(', ') || 'no documents touched';
  }

  _public(p) {
    return { id: p.id, ts: p.ts, summary: p.summary, tabId: p.tabId, kind: p.kind, state: p.state, via: p.via,
      captured: this._brief(p), docs: p.entries.slice(0, 12).map((e) => `${e.op} ${e.documentName} ${e.name || e.uuid}`) };
  }

  _persist(p) {
    const day = join(this.dir, p.date || localDate());
    try {
      mkdirSync(day, { recursive: true });
      writeFileSync(join(day, `${p.id}.json`), JSON.stringify(p));
    } catch (err) { this.audit.log('rollback.persist_error', { id: p.id, message: err.message }); }
  }

  _notify(params) {
    this.dispatcher.notifyBridge({ capabilitySet: CAPABILITY_SET, method: 'claude.rollback', params });
  }
}
