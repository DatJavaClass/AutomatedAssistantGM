/* Claude Link ReForge: repairs broken compendium UUIDs */

if (!game.user.isGM) return ui.notifications.warn("Claude Link ReForge is a GM tool."); // non GM bails, GM falls through

const TAG = "[ClaudeLinkReForge]", VERSION = "0.1.0", MACRO_NAME = "Claude Link ReForge"; // log tag, version, name
const req = (typeof scope === "object" && scope) ? scope : {}; // scope or empty fallback
const FLAG_SCOPE = "world", FLAG_KEY = "linkReforgeReceipt"; // receipt flag location
const RECEIPT_TTL_MS = 30 * 60 * 1000, TIME_BOX_MS = 90 * 1000; // receipt 30m, box 90s
const deadline = Date.now() + TIME_BOX_MS; // time box cutoff

const fail = (error, extra = {}) => {
    ui.notifications.warn(`Claude Link ReForge: ${error}`);
    console.warn(TAG, error, extra);
    return { ok: false, error, ...extra };
};

const self = game.macros.getName(MACRO_NAME);
if (!self) return fail(`This macro must be named exactly "${MACRO_NAME}" (receipt storage is by name).`); // wrong macro name fails

// Shared machinery.

// Optional middle segment absorbs Type-qualified UUID forms.
const UUID_RE = /Compendium\.([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\.(?:([A-Za-z]+)\.)?([a-zA-Z0-9]{16})/g;

// Bonus feats can't resolve by name; human fixes them.
const defaultSkip = (n) => { const s = n.toLowerCase(); return s.includes("bonus feat") || s.endsWith("(b)"); };
const skipRx = req.skipNames ? new RegExp(req.skipNames, "i") : null;
const isSkipName = (n) => n ? (skipRx ? skipRx.test(n) : defaultSkip(n)) : false; // blank false, else test

// Name tiers: exact match, then cleaning rules.
const nameExact = (n) => n.toLowerCase().trim();
const nameCleaned = (n) => n
    .replace(/\s*\d+%\s*$/i, "")
    .replace(/\s*\([^)]+\)\s*$/i, "")
    .replace(/\s+at\s+\d+(st|nd|rd|th)\s+level/i, "")
    .trim().toLowerCase();

// FNV-1a job hash; change anything, apply refuses.
const jobHash = (r) => {
    const spec = JSON.stringify({
        mapping: Object.keys(r.mapping ?? {}).sort().map(k => [k, r.mapping[k]]),
        packs: Array.isArray(r.packs) && r.packs.length ? [...r.packs].sort() : null,
        skipNames: r.skipNames ?? null
    });
    let h = 0x811c9dc5;
    for (let i = 0; i < spec.length; i++) { h ^= spec.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } // per char, exits at end
    return "lr-" + h.toString(16).padStart(8, "0");
};

// Every Compendium UUID in one string; @UUID label beats hint.
function scanString(str, path, nameHint, out) {
    UUID_RE.lastIndex = 0;
    let m;
    while ((m = UUID_RE.exec(str)) !== null) { // per match, ends at none
        let hint = nameHint;
        const label = str.slice(m.index + m[0].length).match(/^\]\{([^}]+)\}/);
        if (label) hint = label[1]; // label overrides hint
        out.push({ path: [...path], uuid: m[0], packId: m[1], docId: m[3], nameHint: hint ?? null });
    }
}

// Provenance metadata (compendiumSource, core.sourceId) is not a live link.
const ROOT_SKIP = new Set(["_id", "_stats", "flags", "ownership", "sort", "folder"]);

function walkValue(value, path, nameHint, out) {
    if (typeof value === "string") return scanString(value, path, nameHint, out); // string value scans it
    if (Array.isArray(value)) return value.forEach((v, i) => walkValue(v, [...path, i], nameHint, out)); // array value recurses per element
    if (value && typeof value === "object") { // object value recurses per key
        const hint = (typeof value.name === "string" && value.name) ? value.name : nameHint;
        for (const [k, v] of Object.entries(value)) walkValue(v, [...path, k], hint, out); // per key, exits after last
    }
}

function walkDoc(docObj, out) {
    // own doc name is never a hint
    for (const [k, v] of Object.entries(docObj)) { // per entry, exits after last
        if (ROOT_SKIP.has(k)) continue; // root key skips, others walk
        walkValue(v, [k], null, out);
    }
}

const defaultPackIds = () => game.packs.filter(p => p.metadata.packageType === "world").map(p => p.collection);

// Load, walk, mark live/broken via pack indexes.
async function collectRefs(packIds) {
    const occs = [], scanned = [], skipped = [], docRefs = new Map();
    for (const pid of packIds) { // per pack id, exits after last
        if (Date.now() > deadline) { skipped.push(pid); continue; } // past deadline skips pack
        const pack = game.packs.get(pid);
        if (!pack) { skipped.push(`${pid} (not found)`); continue; } // missing pack skips
        const docs = await pack.getDocuments();
        const before = occs.length;
        for (const d of docs) { // per doc, exits after last
            docRefs.set(`${pid}::${d.id}`, d);
            const found = [];
            walkDoc(d.toObject(), found);
            found.forEach(o => { o.srcPack = pid; o.srcDocId = d.id; o.srcDocName = d.name; }); // per ref, stamps source
            occs.push(...found);
        }
        scanned.push({ pack: pid, docs: docs.length, refs: occs.length - before });
    }
    const idxCache = new Map();
    for (const o of occs) { // per occurrence, exits after last
        if (!idxCache.has(o.packId)) { // uncached pack loads index
            const p = game.packs.get(o.packId);
            idxCache.set(o.packId, p ? new Set((await p.getIndex()).map(e => e._id)) : null);
        }
        const ids = idxCache.get(o.packId);
        o.broken = !ids || !ids.has(o.docId);
    }
    return { occs, scanned, skipped, docRefs };
}

// Mutates occs with resolution + newUuid; returns pair stats.
async function resolveMapping(broken, mapping) {
    const lookups = {}, pairs = {};
    for (const live of new Set(Object.values(mapping))) { // per target pack, missing returns error
        const lp = game.packs.get(live);
        if (!lp) return { error: `Mapped target pack "${live}" not found.` }; // missing pack returns error
        const docs = await lp.getDocuments();
        const idMap = new Map(), exactMap = new Map(), cleanMap = new Map();
        let collisions = 0;
        for (const d of docs) { // per target doc, exits after last
            idMap.set(d.id, d.uuid);
            const ek = nameExact(d.name), ck = nameCleaned(d.name);
            if (exactMap.has(ek)) collisions++; // duplicate name counts collision
            exactMap.set(ek, d.uuid); // last wins - matches both ancestor macros
            cleanMap.set(ck, d.uuid);
        }
        lookups[live] = { idMap, exactMap, cleanMap, collisions, docCount: docs.length };
    }
    for (const o of broken) { // per broken ref, exits after last
        const live = mapping[o.packId];
        if (!live) continue; // unmapped ref skips
        const L = lookups[live];
        const s = pairs[`${o.packId} -> ${live}`] ??= {
            refs: 0, byId: 0, byName: 0, skippedPolicy: 0, unresolved: 0,
            targetDocs: L.docCount, targetNameCollisions: L.collisions
        };
        s.refs++;
        if (isSkipName(o.nameHint)) { o.resolution = "skippedPolicy"; s.skippedPolicy++; continue; } // policy skip counts, continues
        let nu = L.idMap.get(o.docId);
        if (!nu && o.nameHint) nu = L.exactMap.get(nameExact(o.nameHint)) ?? L.cleanMap.get(nameCleaned(o.nameHint)); // id miss tries name
        if (nu) { // found target sets uuid
            o.newUuid = nu;
            o.resolution = L.idMap.get(o.docId) ? "byId" : "byName";
            s[o.resolution]++;
        } else { o.resolution = "unresolved"; s.unresolved++; } // no match marks unresolved
    }
    for (const s of Object.values(pairs)) s.matchRate = s.refs ? Math.round(100 * (s.byId + s.byName) / s.refs) : 0; // per pair, rate or zero
    return { pairs };
}

const packIds = Array.isArray(req.packs) && req.packs.length ? req.packs : defaultPackIds(); // request packs or defaults

// Bare run: diagnostic dialog, no writes.
if (!req.action) { // no action shows diagnostic
    const receipt = self.getFlag(FLAG_SCOPE, FLAG_KEY);
    const age = receipt ? Math.round((Date.now() - receipt.ts) / 60000) : null;
    new Dialog({
        title: "Claude Link ReForge - diagnostic",
        content: `<p>This macro is invoked by Claude with <code>{action: "scan" | "dryrun" | "apply"}</code>;
                  a bare run only reports state.</p>
                  <table style="border-collapse:collapse">
                  <tr><td style="padding:2px 8px"><b>Version</b></td><td style="padding:2px 8px">${VERSION}</td></tr>
                  <tr><td style="padding:2px 8px"><b>Default scan scope</b></td><td style="padding:2px 8px">${defaultPackIds().length} world pack(s)</td></tr>
                  <tr><td style="padding:2px 8px"><b>Dry-run receipt</b></td><td style="padding:2px 8px">${receipt
                      ? `${receipt.hash} (${age} min old${age * 60000 > RECEIPT_TTL_MS ? " - EXPIRED" : ""})<br><code>${JSON.stringify(receipt.mapping)}</code>`
                      : "(none - apply is locked until a dryrun runs)"}</td></tr>
                  </table>`,
        buttons: { ok: { label: "Close" } },
        default: "ok"
    }, { width: 560 }).render(true);
    return { ok: true, diagnostic: true, version: VERSION };
}

// scan: read-only.
if (req.action === "scan") { // scan action reads only
    const { occs, scanned, skipped } = await collectRefs(packIds);
    const broken = occs.filter(o => o.broken);
    const groups = {};
    for (const o of broken) { // per broken ref, tallies group
        const g = groups[o.packId] ??= { refs: 0, packStillExists: !!game.packs.get(o.packId), inDocs: new Set(), samples: [] };
        g.refs++;
        g.inDocs.add(`${o.srcPack} :: ${o.srcDocName}`);
        if (g.samples.length < 5) g.samples.push({ uuid: o.uuid, name: o.nameHint }); // under five samples adds one
    }
    for (const g of Object.values(groups)) g.inDocs = [...g.inDocs].slice(0, 15); // per group, caps docs at 15
    return {
        ok: true, action: "scan", version: VERSION,
        totalRefs: occs.length, brokenRefs: broken.length,
        brokenByDeadPack: groups,
        scanned, skippedPacks: skipped, partial: skipped.length > 0,
        livePacks: game.packs.map(p => ({ id: p.collection, label: p.metadata.label, type: p.metadata.type, size: p.index.size })),
        next: broken.length ? "Propose {deadPackId: livePackId} and call dryrun." : "Nothing broken in scope."
    };
}

// dryrun: read plus receipt flag write.
if (req.action === "dryrun") { // dryrun action stores receipt
    if (!req.mapping || typeof req.mapping !== "object" || !Object.keys(req.mapping).length) // bad mapping fails
        return fail("dryrun needs a non-empty mapping {deadPackId: livePackId}.");
    const { occs, skipped } = await collectRefs(packIds);
    const broken = occs.filter(o => o.broken && req.mapping[o.packId]);
    const res = await resolveMapping(broken, req.mapping);
    if (res.error) return fail(res.error); // resolve error fails
    const hash = jobHash(req);
    await self.setFlag(FLAG_SCOPE, FLAG_KEY, { hash, ts: Date.now(), mapping: req.mapping });
    const unresolvedSamples = broken.filter(o => o.resolution === "unresolved").slice(0, 10)
        .map(o => ({ name: o.nameHint, uuid: o.uuid, inDoc: o.srcDocName }));
    return {
        ok: true, action: "dryrun", version: VERSION, hash,
        pairs: res.pairs, unresolvedSamples, skippedPacks: skipped, partial: skipped.length > 0,
        note: "No links were changed. Receipt stored (30 min). A low matchRate means a wrong pack - do not apply.",
        next: `Show the GM this report; on their go, call apply with the SAME mapping and confirmHash "${hash}".`
    };
}

// apply: gated write, receipt-locked.
if (req.action === "apply") { // apply action writes fixes
    if (!req.mapping || !Object.keys(req.mapping ?? {}).length) return fail("apply needs the dry-run mapping."); // apply without mapping fails
    if (!req.confirmHash) return fail("apply needs confirmHash from the dryrun report."); // missing hash fails
    const hash = jobHash(req);
    if (hash !== req.confirmHash) // hash mismatch fails
        return fail(`confirmHash mismatch: this job hashes to ${hash}. The mapping/packs/skipNames differ from what was dry-run.`);
    const receipt = self.getFlag(FLAG_SCOPE, FLAG_KEY);
    if (!receipt || receipt.hash !== hash) // no matching receipt fails
        return fail("No matching dry-run receipt. Run dryrun with this exact job first - apply never runs cold.");
    if (Date.now() - receipt.ts > RECEIPT_TTL_MS) // expired receipt fails
        return fail("Dry-run receipt expired (30 min). Re-run dryrun and re-confirm.");

    const { occs, docRefs } = await collectRefs(packIds);
    const broken = occs.filter(o => o.broken && req.mapping[o.packId]);
    const res = await resolveMapping(broken, req.mapping);
    if (res.error) return fail(res.error); // resolve error aborts apply

    // Group resolved refs by host document.
    const byDoc = new Map();
    for (const o of broken) { // per ref, groups by doc
        if (!o.newUuid) continue; // unresolved ref skips
        const k = `${o.srcPack}::${o.srcDocId}`;
        if (!byDoc.has(k)) byDoc.set(k, []); // new doc key starts list
        byDoc.get(k).push(o);
    }

    const unlocked = [];
    let docsUpdated = 0, refsFixed = 0, partial = false; // counters and partial flag
    const counts = { byId: 0, byName: 0 };
    try {
        for (const [k, list] of byDoc) { // per host doc, deadline breaks
            if (Date.now() > deadline) { partial = true; break; } // deadline stops loop, flags partial
            const doc = docRefs.get(k);
            const pack = game.packs.get(list[0].srcPack);
            if (pack.locked) { await pack.configure({ locked: false }); unlocked.push(pack); } // locked pack unlocks before write

            const clone = doc.toObject();
            const done = new Set();
            for (const o of list) { // per ref, applies replacement
                const dk = `${o.path.join(".")}|${o.uuid}`;
                if (done.has(dk)) continue; // repeat skips, one replace covers it
                done.add(dk);
                let node = clone;
                for (let i = 0; i < o.path.length - 1; i++) node = node[o.path[i]]; // per path step, walks down
                const leaf = o.path[o.path.length - 1];
                node[leaf] = String(node[leaf]).split(o.uuid).join(o.newUuid);
                refsFixed++;
                counts[o.resolution]++;
            }
            // arrays write whole, truncate at first index
            const keys = new Set();
            for (const o of list) { // per ref, collects write key
                const n = o.path.findIndex(seg => typeof seg === "number");
                keys.add((n >= 0 ? o.path.slice(0, n) : o.path).join("."));
            }
            const payload = {};
            for (const key of keys) payload[key] = foundry.utils.getProperty(clone, key); // per key, copies cloned value
            await doc.update(payload);
            docsUpdated++;
        }
    } finally {
        for (const p of unlocked) await p.configure({ locked: true }); // per unlocked pack, relocks
    }

    if (!partial) await self.unsetFlag(FLAG_SCOPE, FLAG_KEY); // full run clears, partial keeps
    const skippedPolicy = broken.filter(o => o.resolution === "skippedPolicy").length;
    const unresolved = broken.filter(o => o.resolution === "unresolved").length;
    return {
        ok: true, action: "apply", version: VERSION,
        docsUpdated, refsFixed, ...counts, skippedPolicy, unresolved,
        partial, remainingDocs: partial ? byDoc.size - docsUpdated : 0,
        note: partial
            ? "Time-boxed out. Receipt kept - re-run apply with the same mapping+hash to continue; fixed links drop out automatically."
            : "Receipt cleared. VERIFY with a fresh scan call - never trust in-eval read-back."
    };
}

return fail(`Unknown action "${req.action}". Valid: scan, dryrun, apply (bare run = diagnostic).`);
