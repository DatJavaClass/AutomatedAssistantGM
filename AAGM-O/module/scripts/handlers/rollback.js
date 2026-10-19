/* rollback.apply restores a point's entries, newest first. */

import { runExclusive } from '../rollback-recorder.js';

const STRIP_KEYS = ['_id','_stats','type','items','effects','pages','results','sounds','tokens','walls','lights','tiles','drawings','notes','templates','regions','combatants','cards','behaviors'];

async function undoUpdate(e) {
  if (e.oversized || !e.before) return { ok: false, error: 'snapshot oversized' }; // oversized snapshot fails, else continues
  const d = await fromUuid(e.uuid);
  if (!d) return { ok: false, error: 'document gone' }; // document gone fails
  const payload = foundry.utils.deepClone(e.before);
  for (const k of STRIP_KEYS) delete payload[k]; // each stripped key deleted, ends at last
  if (d.documentName === 'Token' && d.actorLink) delete payload.delta; // linked delta writes through
  await d.update(payload, { diff: false, recursive: false });
  return { ok: true };
}

async function undoCreate(e) {
  const d = await fromUuid(e.uuid);
  if (!d) return { ok: true, note: 'already gone' }; // already gone succeeds early
  await d.delete();
  return { ok: true };
}

async function undoDelete(e) {
  if (e.oversized || !e.data) return { ok: false, error: 'snapshot oversized' }; // oversized snapshot fails, else continues
  if (e.parentUuid) { // parent known restores under parent
    const p = await fromUuid(e.parentUuid);
    if (!p) return { ok: false, error: 'parent gone' }; // parent gone fails
    await p.createEmbeddedDocuments(e.documentName, [e.data], { keepId: true });
    return { ok: true };
  }
  const Cls = CONFIG[e.documentName]?.documentClass ?? getDocumentClass(e.documentName);
  await Cls.create(e.data, { keepId: true, ...(e.pack ? { pack: e.pack } : {}) });
  return { ok: true };
}

const UNDO = { update: undoUpdate, create: undoCreate, delete: undoDelete };

export async function handleRollbackApply({ pointId, entries, rp } = {}) {
  if (!Array.isArray(entries)) { // non array throws, array continues
    const e = new Error('rollback.apply: `entries` must be an array'); e.code = -32602; throw e;
  }
  const run = rp?.id ? (fn) => fn() : runExclusive; // recorded runs hold chain
  return run(async () => {
    const applied = [];
    for (const e of [...entries].reverse()) { // each entry undone, newest first
      const row = { uuid: e?.uuid ?? null, op: e?.op ?? null };
      try { // undo failure recorded per row
        const fn = UNDO[e?.op]; // known op or unknown
        Object.assign(row, fn ? await fn(e) : { ok: false, error: `unknown op "${e?.op}"` });
      } catch (err) {
        Object.assign(row, { ok: false, error: err?.message || String(err) });
      }
      applied.push(row);
    }
    const good = applied.filter((a) => a.ok).length;
    console.log(`[aagm-o] rollback ${pointId}: ${good} ok, ${applied.length - good} failed`);
    return { pointId, applied };
  });
}
