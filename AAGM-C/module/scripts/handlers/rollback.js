// rollback.apply: restores a Rollback Point's entries, newest first.

import { runExclusive } from '../rollback-recorder.js';

const STRIP_KEYS = ['_id','_stats','type','items','effects','pages','results','sounds','tokens','walls','lights','tiles','drawings','notes','templates','regions','combatants','cards','behaviors'];

async function undoUpdate(e) {
  if (e.oversized || !e.before) return { ok: false, error: 'snapshot oversized' }; // oversized or missing fails
  const d = await fromUuid(e.uuid);
  if (!d) return { ok: false, error: 'document gone' }; // gone doc returns failure
  const payload = foundry.utils.deepClone(e.before);
  for (const k of STRIP_KEYS) delete payload[k]; // each embedded key stripped
  if (d.documentName === 'Token' && d.actorLink) delete payload.delta; // linked token skips delta write
  await d.update(payload, { diff: false, recursive: false });
  return { ok: true };
}

async function undoCreate(e) {
  const d = await fromUuid(e.uuid);
  if (!d) return { ok: true, note: 'already gone' }; // gone doc counts as undone
  await d.delete();
  return { ok: true };
}

async function undoDelete(e) {
  if (e.oversized || !e.data) return { ok: false, error: 'snapshot oversized' }; // oversized or missing fails
  if (e.parentUuid) { // embedded doc recreated in parent
    const p = await fromUuid(e.parentUuid);
    if (!p) return { ok: false, error: 'parent gone' }; // gone parent returns failure
    await p.createEmbeddedDocuments(e.documentName, [e.data], { keepId: true });
    return { ok: true };
  }
  const Cls = CONFIG[e.documentName]?.documentClass ?? getDocumentClass(e.documentName);
  await Cls.create(e.data, { keepId: true, ...(e.pack ? { pack: e.pack } : {}) });
  return { ok: true };
}

const UNDO = { update: undoUpdate, create: undoCreate, delete: undoDelete };

export async function handleRollbackApply({ pointId, entries } = {}, ctx) {
  if (!Array.isArray(entries)) { // bad entries throw -32602
    const e = new Error('rollback.apply: `entries` must be an array'); e.code = -32602; throw e;
  }
  return runExclusive(async () => {
    const applied = [];
    for (const e of [...entries].reverse()) { // entries undone newest first
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
    console.log(`[foundry-bridge] rollback ${pointId}: ${good} ok, ${applied.length - good} failed`);
    return { pointId, applied };
  });
}
