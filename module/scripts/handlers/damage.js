// damage handler — the ONLY path that changes HP. Absolute rule (DatJavaClass):
// Claude Code may never reduce any actor below 1 HP; lethal blows are
// human-only. Enforced here on live data, not by heuristics:
//
//   commit:false → plan only. Returns per-target before→after + lethal flag.
//                  Never writes. The relay refuses the whole op if lethal.
//   commit:true  → re-checks the floor on fresh data and applies ATOMICALLY:
//                  if ANY target would land < 1 HP, nothing is written and it
//                  throws. No partial application.
//
// Damage hits temp HP first, then value. This manipulates state; it does not
// adjudicate DR/resistances (DESIGN §12) — the caller passes the final amount.

async function resolveTarget(ref) {
  const s = String(ref ?? '').trim();
  if (!s) return null;
  // UUID-ish (Actor.* / Token.* / Scene.x.Token.y / Compendium.*)
  if (s.includes('.')) {
    try {
      let d = await fromUuid(s);
      if (d && d.documentName === 'Token') d = d.actor;
      if (d && d.documentName === 'Actor') return d;
    } catch { /* fall through to name resolution */ }
  }
  const exact = game.actors.getName(s);
  if (exact) return exact;
  const low = s.toLowerCase();
  const ci = game.actors.find((a) => a.name.toLowerCase() === low);
  if (ci) return ci;
  const partial = game.actors.filter((a) => a.name.toLowerCase().includes(low));
  return partial.length === 1 ? partial[0] : null;   // ambiguous → unresolved
}

function hpOf(actor) {
  const hp = actor.system?.attributes?.hp || {};
  return { value: Number(hp.value ?? 0), temp: Number(hp.temp ?? 0) };
}

function project({ value, temp }, amount) {
  const absorbed = Math.min(Math.max(temp, 0), amount);
  const after = value - (amount - absorbed);
  return { after, newTemp: Math.max(0, temp - absorbed) };
}

export async function handleDamage({ targets, amount, commit } = {}) {
  if (!Array.isArray(targets) || targets.length === 0) {
    const e = new Error('damage: `targets` must be a non-empty array'); e.code = -32602; throw e;
  }
  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt <= 0) {
    const e = new Error('damage: `amount` must be a positive integer'); e.code = -32602; throw e;
  }

  const resolved = [];
  for (const ref of targets) resolved.push({ ref, actor: await resolveTarget(ref) });
  const missing = resolved.filter((r) => !r.actor).map((r) => r.ref);
  if (missing.length) {
    return { error: `Could not resolve target(s): ${missing.join(', ')}. Use exact names or UUIDs.` };
  }

  const preview = resolved.map(({ actor }) => {
    const hp = hpOf(actor);
    const { after } = project(hp, amt);
    return { name: actor.name, uuid: actor.uuid, before: hp.value, temp: hp.temp, after, lethal: after < 1 };
  });
  const lethal = preview.some((p) => p.lethal);

  // Lethal — for plan OR commit — is an atomic structured refusal: never a
  // throw, never a partial write. (The relay refuses before confirm; this also
  // catches a plan→commit race where HP dropped after approval.)
  if (!commit || lethal) {
    return { committed: false, lethal, amount: amt, preview };
  }

  // Commit, non-lethal: re-read live HP and verify ALL before writing ANY.
  const writes = [];
  for (const { actor } of resolved) {
    const hp = hpOf(actor);
    const { after, newTemp } = project(hp, amt);
    if (after < 1) return { committed: false, lethal: true, amount: amt, preview };
    writes.push({ actor, after, newTemp });
  }
  const applied = [];
  for (const w of writes) {
    await w.actor.update({ 'system.attributes.hp.value': w.after, 'system.attributes.hp.temp': w.newTemp });
    applied.push({ name: w.actor.name, hp: w.after });
  }
  return { committed: true, amount: amt, applied };
}
