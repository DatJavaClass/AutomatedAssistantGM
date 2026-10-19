/* rollback.apply restores a point's entries, newest first. */

import { runExclusive } from '../rollback-recorder.js';

const STRIP_KEYS = ['_id','_stats','type','items','effects','pages','results','sounds','tokens','walls','lights','tiles','drawings','notes','templates','regions','combatants','cards','behaviors'];

async function undoUpdate(e) {
  if (e.oversized || !e.before) return { ok: false, error: 'snapshot oversized' }; // oversized or no before fails
  const d = await fromUuid(e.uuid);
  if (!d) return { ok: false, error: 'document gone' }; // document gone returns failure
  const payload = foundry.utils.deepClone(e.before);
  for (const k of STRIP_KEYS) delete payload[k]; // each key stripped, ends after last
  if (d.documentName === 'Token' && d.actorLink) delete payload.delta; // linked delta writes through
  await d.update(payload, { diff: false, recursive: false });
  return { ok: true };
}

async function undoCreate(e) {
  const d = await fromUuid(e.uuid);
  if (!d) return { ok: true, note: 'already gone' }; // already gone returns ok
  await d.delete();
  return { ok: true };
}

async function undoDelete(e) {
  if (e.oversized || !e.data) return { ok: false, error: 'snapshot oversized' }; // oversized or no data fails
  if (e.parentUuid) { // parent known recreates embedded
    const p = await fromUuid(e.parentUuid);
    if (!p) return { ok: false, error: 'parent gone' }; // parent gone returns failure
    await p.createEmbeddedDocuments(e.documentName, [e.data], { keepId: true });
    return { ok: true };
  }
  const Cls = CONFIG[e.documentName]?.documentClass ?? getDocumentClass(e.documentName);
  await Cls.create(e.data, { keepId: true, ...(e.pack ? { pack: e.pack } : {}) });
  return { ok: true };
}

const UNDO = { update: undoUpdate, create: undoCreate, delete: undoDelete };

export async function handleRollbackApply({ pointId, entries, rp } = {}) {
  if (!Array.isArray(entries)) { // bad entries throw, else continue
    const e = new Error('rollback.apply: `entries` must be an array'); e.code = -32602; throw e;
  }
  const run = rp?.id ? (fn) => fn() : runExclusive; // recorded runs skip re-locking
  return run(async () => {
    const applied = [];
    for (const e of [...entries].reverse()) { // each entry undone newest first
      const row = { uuid: e?.uuid ?? null, op: e?.op ?? null };
      try {
        const fn = UNDO[e?.op];
        Object.assign(row, fn ? await fn(e) : { ok: false, error: `unknown op "${e?.op}"` });
      } catch (err) {
        Object.assign(row, { ok: false, error: err?.message || String(err) });
      }
      applied.push(row);
    }
    const good = applied.filter((a) => a.ok).length;
    console.log(`[aagm-g] rollback ${pointId}: ${good} ok, ${applied.length - good} failed`);
    return { pointId, applied };
  });
}
