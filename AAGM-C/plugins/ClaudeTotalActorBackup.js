/* Claude Total Actor Backup: snapshots actors into seeds */

if (!game.user.isGM) return ui.notifications.warn("Claude Total Actor Backup is a GM tool."); // others warned out, GM proceeds

const TAG = "[ClaudeTAB]", VERSION = "0.1.0"; // log tag, version
const req = (typeof scope === "object" && scope) ? scope : {}; // caller args or empty
const FOLDER_NAME = "Claude Actor Backups"; // seed folder name
const FLAG_KEY = "claude-tab"; // write key, legacy read
const EXCLUDED_TYPES = ["spell"]; // spells restore as feats
const PARENT_TYPES = ["race", "class"]; // parents restored first
const SETTLE_MS = 1500; // 350 was not enough
const TIME_BOX_MS = 90 * 1000; // 90s run cutoff
const deadline = Date.now() + TIME_BOX_MS; // run cutoff timestamp

const fail = (error, extra = {}) => {
    ui.notifications.warn(`Claude Total Actor Backup: ${error}`);
    console.warn(TAG, error, extra);
    return { ok: false, error, ...extra };
};

// Shared machinery.

// world folder: eyeball, rename, hand off
async function ensureFolder() {
    let folder = game.folders.find(f => f.type === "Item" && f.name === FOLDER_NAME && !f.folder);
    if (!folder) { // missing folder gets created
        folder = await Folder.create({ name: FOLDER_NAME, type: "Item" });
        console.log(TAG, "created backup folder", folder.id);
    }
    return folder;
}

// Partial-name resolve; ambiguity is a refusal, not a guess.
function resolveActor(query) {
    const q = String(query);
    const byId = game.actors.get(q);
    if (byId) return { actor: byId }; // id hit returns actor
    const exact = game.actors.filter(a => a.name.toLowerCase() === q.toLowerCase());
    if (exact.length === 1) return { actor: exact[0] }; // single exact name returns it
    const part = game.actors.filter(a => a.name.toLowerCase().includes(q.toLowerCase()));
    if (part.length === 1) return { actor: part[0] }; // single partial match returns it
    if (part.length === 0) return { error: `No world actor matches "${q}".` }; // no match returns error
    return { error: `"${q}" is ambiguous: ${part.map(a => a.name).join(", ")}` };
}

const getSnapshot = (item) => item?.flags?.[FLAG_KEY]?.snapshot ?? item?.flags?.["grubby-tab"]?.snapshot ?? null;

// Seed lookup: uuid first, then exact world name.
async function resolveSeed(ref) {
    if (typeof ref === "string" && ref.includes(".")) { // uuid like ref tries lookup
        const doc = await fromUuid(ref).catch(() => null);
        if (doc && getSnapshot(doc)) return { seed: doc }; // valid seed returns it
        if (doc) return { error: `"${ref}" is not a backup seed (no snapshot flags).` }; // non seed doc returns error
    }
    const world = game.items.find(i => i.name === ref && getSnapshot(i));
    if (world) return { seed: world }; // world name hit returns it
    return { error: `No backup seed named or identified by "${ref}".` };
}

// Grubby TAB v1 schema, old seeds compatible
async function buildSnapshot(actor) {
    const backable = actor.items.filter(i => !EXCLUDED_TYPES.includes(i.type));
    const excluded = actor.items.size - backable.length;
    const items = [];
    for (const item of backable) { // per backable item, exits after last
        const sourceUUID = item.flags?.core?.sourceId || item.flags?.pf1?.sourceUUID || null;
        let uuidValid = false;
        if (sourceUUID) uuidValid = !!(await fromUuid(sourceUUID).catch(() => null)); // source id gets validated
        if (uuidValid) { // valid uuid stores reference
            items.push({
                mode: "uuid", uuid: sourceUUID, name: item.name, type: item.type,
                qty: item.system?.quantity ?? 1,
                classLvl: item.type === "class" ? (item.system?.level ?? 1) : null
            });
        } else { // invalid uuid stores blob
            const data = item.toObject();
            delete data._id;
            items.push({ mode: "blob", name: item.name, type: item.type, qty: item.system?.quantity ?? 1, data });
        }
    }
    const abilities = {};
    for (const [k, v] of Object.entries(actor.system.abilities ?? {})) abilities[k] = v.value ?? 10; // per ability, exits after last
    return {
        version: 1,
        createdAt: new Date().toISOString(),
        actorName: actor.name,
        actorType: actor.type,
        tokenImg: actor.prototypeToken?.texture?.src ?? "",
        portraitImg: actor.img ?? "",
        abilities,
        hpMax: actor.system.attributes?.hp?.max ?? 0,
        biography: actor.system.details?.biography?.value ?? "",
        items,
        excludedSpells: excluded
    };
}

// Self-contained pf1 on-use restore, embedded in every seed.
// no template literals: ships as seed data
const MANUAL_RESTORE = `// Claude TAB - manual seed restore. Wipes this actor, rebuilds from the seed.
(async () => {
  if (!item || !actor) return ui.notifications.error("Use this seed from an actor's inventory.");
  if (!game.user.isGM && !actor.isOwner) return ui.notifications.warn("Only the GM or this actor's owner can restore.");
  const snapshot = item.flags?.["claude-tab"]?.snapshot ?? item.flags?.["grubby-tab"]?.snapshot ?? null;
  if (!snapshot?.version || !snapshot?.actorName) return ui.notifications.error("No valid snapshot on this seed.");
  if (actor.type !== snapshot.actorType) return ui.notifications.error("Seed is a " + snapshot.actorType + " snapshot; this actor is a " + actor.type + ".");
  const okGo = await Dialog.confirm({
    title: "Restore " + snapshot.actorName + "?",
    content: "<p><b>This will WIPE everything on " + actor.name + "</b> and rebuild them as <b>" + snapshot.actorName + "</b> from this seed (" + (snapshot.items?.length ?? 0) + " items, made " + String(snapshot.createdAt).slice(0, 16).replace("T", " ") + ").</p><p>Current HP, conditions, and spells are not part of a seed. The seed is consumed.</p>",
    defaultYes: false
  });
  if (!okGo) return;
  await actor.deleteEmbeddedDocuments("Item", actor.items.filter(i => i.id !== item.id).map(i => i.id));
  const u = {};
  for (const [k, v] of Object.entries(snapshot.abilities ?? {})) u["system.abilities." + k + ".value"] = v;
  if (snapshot.hpMax) { u["system.attributes.hp.max"] = snapshot.hpMax; u["system.attributes.hp.value"] = snapshot.hpMax; }
  if (snapshot.portraitImg) u["img"] = snapshot.portraitImg;
  if (snapshot.tokenImg) u["prototypeToken.texture.src"] = snapshot.tokenImg;
  if (snapshot.biography) u["system.details.biography.value"] = snapshot.biography;
  if (snapshot.actorName) { u["name"] = snapshot.actorName; u["prototypeToken.name"] = snapshot.actorName; }
  await actor.update(u);
  try {
    for (const scene of game.scenes) {
      for (const t of scene.tokens.filter(t => t.actorId === actor.id)) {
        const tu = {};
        if (snapshot.actorName) tu["name"] = snapshot.actorName;
        if (snapshot.tokenImg) tu["texture.src"] = snapshot.tokenImg;
        if (Object.keys(tu).length) await t.update(tu);
      }
    }
  } catch (e) { console.warn("ClaudeTAB manual restore | token sweep:", e); }
  const prep = async (entry) => {
    if (entry.mode === "uuid") {
      const src = await fromUuid(entry.uuid).catch(() => null);
      if (!src) return null;
      const d = src.toObject(); delete d._id;
      if (entry.qty && d.system?.quantity !== undefined) d.system.quantity = entry.qty;
      if (entry.type === "class" && entry.classLvl !== null) d.system.level = entry.classLvl;
      return d;
    }
    if (entry.mode === "blob") {
      const d = foundry.utils.deepClone(entry.data); delete d._id;
      if (entry.qty && d.system?.quantity !== undefined) d.system.quantity = entry.qty;
      return d;
    }
    return null;
  };
  const parents = (snapshot.items ?? []).filter(e => e.type === "race" || e.type === "class");
  const children = (snapshot.items ?? []).filter(e => e.type !== "race" && e.type !== "class");
  const failed = [];
  const before = new Set(actor.items.map(i => i.id));
  for (const e of parents) {
    const d = await prep(e);
    if (!d) { failed.push(e.name); continue; }
    try { await actor.createEmbeddedDocuments("Item", [d]); } catch (err) { failed.push(e.name); }
  }
  await new Promise(r => setTimeout(r, 1500));  // pf1 async child generation
  const autoGen = actor.items.filter(i => !before.has(i.id)).map(i => i.id);
  if (autoGen.length) await actor.deleteEmbeddedDocuments("Item", autoGen);
  for (const e of children) {
    const d = await prep(e);
    if (!d) { failed.push(e.name); continue; }
    try { await actor.createEmbeddedDocuments("Item", [d]); } catch (err) { failed.push(e.name); }
  }
  await actor.deleteEmbeddedDocuments("Item", [item.id]).catch(() => {});
  ui.notifications.info("Restored " + snapshot.actorName + (failed.length ? " (" + failed.length + " item(s) failed - see console)" : "") + ".");
  if (failed.length) console.warn("ClaudeTAB manual restore | failed:", failed);
  ChatMessage.create({ content: "<p><b>Backup Seed used:</b> " + snapshot.actorName + " restored." + (failed.length ? " " + failed.length + " item(s) could not be restored." : "") + "</p>", whisper: ChatMessage.getWhisperRecipients("GM") });
})();`;

// Inline seeds: loot type or first type
function seedItemData(snapshot) {
    const types = (game.documentTypes?.Item ?? []).filter(t => t !== "base");
    const type = types.includes("loot") ? "loot" : types[0];
    const stamp = snapshot.createdAt.replace("T", " ").slice(0, 16);
    return {
        name: `${snapshot.actorName} - Backup Seed [${stamp}]`,
        type,
        img: snapshot.portraitImg || "icons/magic/time/hourglass-yellow-green.webp",
        flags: { [FLAG_KEY]: { snapshot } }, // flags, never description: ProseMirror corrupts JSON
        /* pf1 loot must be subType "gear" - "misc" loot gets no Use action,
           which would strand the embedded manual-restore script. */
        system: { ...(type === "loot" ? { subType: "gear" } : {}), scriptCalls: [{
            _id: foundry.utils.randomID(), name: "Restore Actor", type: "script",
            value: MANUAL_RESTORE, category: "use", hidden: false
        }], description: { value: `
<div style="padding:10px;border:1px solid #888;border-radius:6px;">
  <h3 style="margin:0 0 6px 0;">Backup Seed</h3>
  <p style="margin:0 0 3px 0;"><strong>Actor:</strong> ${snapshot.actorName} (${snapshot.actorType})</p>
  <p style="margin:0 0 3px 0;"><strong>Created:</strong> ${stamp}</p>
  <p style="margin:0 0 3px 0;"><strong>Items:</strong> ${snapshot.items.length}${snapshot.excludedSpells ? ` (+${snapshot.excludedSpells} spells excluded)` : ""}</p>
  <p style="margin:0;font-size:0.85em;">Use from an actor's inventory to restore manually (wipes that actor, consumes the seed), or have Claude restore it onto a blank ${snapshot.actorType} actor.</p>
</div>` } }
    };
}

// Bare run: diagnostic dialog, ensures storage.
if (!req.action) { // no action shows diagnostic
    const folder = await ensureFolder();
    const seedCount = game.items.filter(i => getSnapshot(i)).length;
    new Dialog({
        title: "Claude Total Actor Backup - diagnostic",
        content: `<p>This macro is invoked by Claude with <code>{action: "backup" | "list" | "restore" | "prune"}</code>;
                  a bare run only ensures storage and reports state.</p>
                  <table style="border-collapse:collapse">
                  <tr><td style="padding:2px 8px"><b>Version</b></td><td style="padding:2px 8px">${VERSION}</td></tr>
                  <tr><td style="padding:2px 8px"><b>Backup folder</b></td><td style="padding:2px 8px">${FOLDER_NAME} (${seedCount} seed(s) in world)</td></tr>
                  <tr><td style="padding:2px 8px"><b>World actors</b></td><td style="padding:2px 8px">${game.actors.size}</td></tr>
                  </table>`,
        buttons: { ok: { label: "Close" } },
        default: "ok"
    }, { width: 520 }).render(true);
    return { ok: true, diagnostic: true, version: VERSION, folder: FOLDER_NAME, seeds: seedCount };
}

// backup: creates seeds, deletes nothing.
if (req.action === "backup") { // backup action creates seeds
    const queries = Array.isArray(req.actors) ? req.actors : (req.actors ? [req.actors] : []); // array, single, or empty
    if (!queries.length) return fail(`backup needs actors: ["name or id", ...].`); // empty list fails

    // resolve names first, fail before writes
    const actors = [];
    for (const q of queries) { // per query, bad name returns fail
        const r = resolveActor(q);
        if (r.error) return fail(r.error); // bad name fails
        actors.push(r.actor);
    }

    const folder = await ensureFolder();
    const made = [], remaining = [];
    for (const actor of actors) { // per actor, fail returns, deadline skips
        if (Date.now() > deadline) { remaining.push(actor.name); continue; } // deadline defers actor
        const snapshot = await buildSnapshot(actor);
        const data = seedItemData(snapshot);
        data.folder = folder.id;
        const seed = await Item.create(data);
        if (!seed) return fail(`Seed creation failed for ${actor.name}.`, { made }); // failed create fails
        const verify = game.items.get(seed.id);
        if (!getSnapshot(verify)) return fail(`Seed for ${actor.name} failed read-back verify.`, { made }); // failed verify fails
        made.push({
            actor: actor.name, seed: verify.name, uuid: verify.uuid,
            items: snapshot.items.length,
            byUuid: snapshot.items.filter(i => i.mode === "uuid").length,
            asBlob: snapshot.items.filter(i => i.mode === "blob").length,
            excludedSpells: snapshot.excludedSpells
        });
    }
    return {
        ok: true, action: "backup", version: VERSION, folder: FOLDER_NAME, made,
        partial: remaining.length > 0, remaining,
        note: remaining.length ? "Time-boxed out - re-run backup for the remaining actors." :
            "Seeds are reusable library copies. Prune old generations with {action:'prune'} when they pile up."
    };
}

// list: read-only.
if (req.action === "list") { // list action reads seeds
    const folder = await ensureFolder();
    const seeds = [];
    for (const i of game.items) { // per world item, exits after last
        const s = getSnapshot(i);
        if (s) seeds.push({ seed: i.name, uuid: i.uuid, actor: s.actorName, type: s.actorType, createdAt: s.createdAt, items: s.items?.length ?? 0, where: i.folder?.id === folder.id ? "folder" : "loose" }); // seed adds row, others skip
    }
    const filtered = req.actor ? seeds.filter(s => s.actor.toLowerCase().includes(String(req.actor).toLowerCase())) : seeds;
    filtered.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { ok: true, action: "list", seeds: filtered, note: "Loose entries live outside the backup folder (old Grubby seeds land here) - restorable, but never pruned." };
}

// restore: write; destructive when allowNonEmpty wipes.
if (req.action === "restore") { // restore action rebuilds actor
    if (!req.seed) return fail("restore needs seed: <uuid or exact seed name>."); // missing seed fails
    if (!req.target) return fail("restore needs target: <actor name or id>."); // missing target fails

    const sr = await resolveSeed(req.seed);
    if (sr.error) return fail(sr.error); // seed error fails
    const snapshot = getSnapshot(sr.seed);
    if (!snapshot?.version || !snapshot?.actorName) return fail("Snapshot data is invalid or incomplete."); // invalid snapshot fails

    const ar = resolveActor(req.target);
    if (ar.error) return fail(ar.error); // target error fails
    const actor = ar.actor;

    // hard guard: seed lands on own type
    if (actor.type !== snapshot.actorType) // type mismatch fails
        return fail(`Type mismatch: seed is a "${snapshot.actorType}" snapshot, target "${actor.name}" is "${actor.type}". Spawn a blank ${snapshot.actorType} actor instead.`);

    // Blank-target guard: the wipe must be explicit.
    if (actor.items.size > 0) { // non blank target needs allowance
        if (!req.allowNonEmpty) // no allowance fails
            return fail(`Target "${actor.name}" is not blank (${actor.items.size} item(s)). Restore onto a blank actor, or pass allowNonEmpty:true to WIPE it first (destructive - double confirm).`);
        await actor.deleteEmbeddedDocuments("Item", actor.items.map(i => i.id));
    }

    // Snapshot values, not runtime state; HP lands at max.
    const statUpdates = {};
    for (const [k, v] of Object.entries(snapshot.abilities ?? {})) statUpdates[`system.abilities.${k}.value`] = v; // per ability, exits after last
    if (snapshot.hpMax) { // saved hp sets max and value
        statUpdates["system.attributes.hp.max"] = snapshot.hpMax;
        statUpdates["system.attributes.hp.value"] = snapshot.hpMax;
    }
    if (snapshot.portraitImg) statUpdates["img"] = snapshot.portraitImg; // portrait present restores it
    if (snapshot.tokenImg) statUpdates["prototypeToken.texture.src"] = snapshot.tokenImg; // token art present restores it
    if (snapshot.biography) statUpdates["system.details.biography.value"] = snapshot.biography; // biography present restores it
    if (snapshot.actorName) { // name present restores both
        statUpdates["name"] = snapshot.actorName;
        statUpdates["prototypeToken.name"] = snapshot.actorName;
    }
    await actor.update(statUpdates);

    // actor.update skips placed tokens - sweep them.
    let liveTokens = 0;
    try {
        for (const scene of game.scenes) { // per scene, exits after last
            for (const t of scene.tokens.filter(t => t.actorId === actor.id)) { // per actor token, exits after last
                const u = {};
                if (snapshot.actorName) u["name"] = snapshot.actorName; // name present updates token
                if (snapshot.tokenImg) u["texture.src"] = snapshot.tokenImg; // art present updates token
                if (Object.keys(u).length) { await t.update(u); liveTokens++; } // non empty update applies, counts
            }
        }
    } catch (err) { console.warn(TAG, "live token sweep (non-fatal):", err); }

    // ancestor order: parents, settle, strip, rest
    const restored = [], failed = [];
    async function prepareItemData(entry) {
        if (entry.mode === "uuid") { // uuid entry resolves source
            const src = await fromUuid(entry.uuid).catch(() => null);
            if (!src) return null; // lost source returns null
            const data = src.toObject();
            delete data._id;
            if (entry.qty && data.system?.quantity !== undefined) data.system.quantity = entry.qty; // qty present overrides
            if (entry.type === "class" && entry.classLvl !== null) data.system.level = entry.classLvl; // class level overrides
            return data;
        }
        if (entry.mode === "blob") { // blob entry clones data
            const data = foundry.utils.deepClone(entry.data);
            delete data._id;
            if (entry.qty && data.system?.quantity !== undefined) data.system.quantity = entry.qty; // qty present overrides
            return data;
        }
        return null;
    }
    const parents = (snapshot.items ?? []).filter(e => PARENT_TYPES.includes(e.type));
    const children = (snapshot.items ?? []).filter(e => !PARENT_TYPES.includes(e.type));

    const idsBefore = new Set(actor.items.map(i => i.id));
    for (const entry of parents) { // per parent, exits after last
        const data = await prepareItemData(entry);
        if (!data) { failed.push({ name: entry.name, reason: "UUID not found: " + (entry.uuid ?? "blob") }); continue; } // no data records failure
        try { await actor.createEmbeddedDocuments("Item", [data]); restored.push(entry.name); }
        catch (err) { failed.push({ name: entry.name, reason: err.message }); }
    }

    await new Promise(r => setTimeout(r, SETTLE_MS));

    // auto defaults are wrong, strip them
    const autoGen = actor.items.filter(i => !idsBefore.has(i.id)).map(i => i.id);
    if (autoGen.length) await actor.deleteEmbeddedDocuments("Item", autoGen); // generated extras get deleted

    for (const entry of children) { // per child, exits after last
        const data = await prepareItemData(entry);
        if (!data) { failed.push({ name: entry.name, reason: "UUID not found: " + (entry.uuid ?? "blob") }); continue; } // no data records failure
        try { await actor.createEmbeddedDocuments("Item", [data]); restored.push(entry.name); }
        catch (err) { failed.push({ name: entry.name, reason: err.message }); }
    }

    return {
        ok: true, action: "restore", version: VERSION,
        target: actor.name, fromSeed: sr.seed.name,
        itemsRestored: restored.length, itemsFailed: failed, autoGenStripped: autoGen.length,
        liveTokensUpdated: liveTokens,
        note: "Seed kept (library copy). VERIFY with a separate read - never trust in-eval read-back."
    };
}

// prune: the only op that deletes seeds.
if (req.action === "prune") { // prune action deletes old seeds
    const keep = Number.isInteger(req.keep) && req.keep > 0 ? req.keep : 5;
    const folder = await ensureFolder();
    // Folder seeds only; loose seeds are the GM's.
    const byActor = new Map();
    for (const i of game.items.filter(i => i.folder?.id === folder.id)) { // per folder item, exits after last
        const s = getSnapshot(i);
        if (!s) continue; // non seed skips
        if (req.actor && !s.actorName.toLowerCase().includes(String(req.actor).toLowerCase())) continue; // other actor skips
        if (!byActor.has(s.actorName)) byActor.set(s.actorName, []); // new actor starts list
        byActor.get(s.actorName).push({ id: i.id, name: i.name, createdAt: s.createdAt });
    }
    const pruned = [];
    for (const [actorName, seeds] of byActor) { // per actor name, exits after last
        seeds.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        for (const old of seeds.slice(keep)) { // per old seed, deletes it
            await game.items.get(old.id).delete();
            pruned.push({ actor: actorName, seed: old.name });
        }
    }
    return { ok: true, action: "prune", version: VERSION, keep, pruned, note: pruned.length ? "Deleted oldest folder generations beyond the keep count. Loose seeds untouched." : "Nothing to prune." };
}

return fail(`Unknown action "${req.action}". Valid: backup, list, restore, prune (bare run = diagnostic).`);
