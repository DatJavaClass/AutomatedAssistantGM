/* Claude Foe Forge - files hostile pf1 actors into the configured destination.
   GM-only Script macro; contract, config journal and image policy in the README. */

if (!game.user.isGM) return ui.notifications.warn("Claude Foe Forge is a GM tool.");

const TAG = "[ClaudeFoeForge]";
const req = (typeof scope === "object" && scope) ? scope : {};

// Configuration.
const JOURNAL_NAME = "Claude Foe Forge Config";
const WORLD_FOLDER = "Claude Foe Forge"; // world-directory fallback folder
const FORMAT_GUIDE_ID = "system.content.stuff"; // the example line, always ignored

// Config-journal seed; edit destination + extras in-world.
const SEED_TEXT = `Destination:
Insert Destination Compendium here

Pathfinder Bestiaries:
pf1-bestiary.bestiary-00
pf1-bestiary.bestiary-02
pf1-bestiary.bestiary-04
pf1-bestiary.bestiary-06
pf1-bestiary.bestiary-08
pf1-bestiary.bestiary-11
pf1-bestiary.bestiary-15
pf1-bestiary.bestiary-20

Animal Companions:
pf-content.pf-companions

Animal Companion Features:
pf-content.pf-companion-features

Familiars:
pf-content.pf-familiars

Familiar Features:
pf1.companion-features

Universal Monster Rules:
pf-content.pf-universal-monster-rules

Monster Abilities & Creature Subtypes:
pf1.monster-abilities

Monster Templates:
pf1.monster-templates

Monster Racial HD:
pf1.racial-hd

Common Build:
pf1.feats
pf1.classes
pf1.class-abilities
pf1.races
pf-content.pf-racial-traits

User Extra Content:
system.content.stuff //Example Label`;

const fail = (error, extra = {}) => {
    ui.notifications.warn(`Claude Foe Forge: ${error}`);
    console.warn(TAG, error, extra);
    return { ok: false, error, ...extra };
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Config journal: find / seed / parse.
const findJournal = () => game.journal.getName(JOURNAL_NAME);

const seedJournal = async () => {
    const journal = await JournalEntry.create({
        name: JOURNAL_NAME,
        pages: [{
            name: "CFF Sources",
            type: "text",
            text: { content: `<pre>${esc(SEED_TEXT)}</pre>`, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS?.HTML ?? 1 }
        }]
    });
    ui.notifications.info(`Claude Foe Forge: seeded config journal "${JOURNAL_NAME}".`);
    return journal;
};

// Flatten journal HTML (ProseMirror <p> wraps) to lines.
const htmlToLines = (html) => String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|pre|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean);

// Entry looks like pack.id (+optional //Label); else a group.
const ID_LIKE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+(\s*\/\/.*)?$/;

const parseConfig = (lines) => {
    const groups = [];
    let current = null;
    for (const line of lines) {
        if (ID_LIKE.test(line)) {
            if (!current) { current = { group: "Ungrouped", entries: [] }; groups.push(current); }
            const [id, ...rest] = line.split("//");
            current.entries.push({ id: id.trim(), label: rest.join("//").trim() || null });
        } else {
            current = { group: line.replace(/:\s*$/, "").trim(), entries: [] };
            groups.push(current);
        }
    }
    const destGroup  = groups.find(g => /^destination/i.test(g.group));
    const extraGroup = groups.find(g => /user\s*extra\s*content/i.test(g.group));
    const extras = (extraGroup?.entries ?? []).filter(e => e.id !== FORMAT_GUIDE_ID);
    const sources = groups.filter(g => g !== destGroup && g !== extraGroup && g.entries.length);
    return { destination: destGroup?.entries[0]?.id ?? null, sources, extras };
};

const readConfig = () => {
    const journal = findJournal();
    if (!journal) return null;
    const text = journal.pages.contents.filter(p => p.type === "text")
        .map(p => p.text?.content ?? "").join("\n");
    return parseConfig(htmlToLines(text));
};

const resolveDestination = (destId) => {
    if (!destId) return { error: `No destination is set in the "${JOURNAL_NAME}" journal. Under "Destination:", replace the placeholder with a compendium id (scope.name) or "world.actors" to file into the world Actors directory.` };
    const pack = game.packs.get(destId);
    if (pack) {
        if (pack.documentName !== "Actor")
            return { error: `Destination pack "${destId}" holds ${pack.documentName}s, not Actors.` };
        return { mode: "pack", pack };
    }
    if (destId === "world.actors") return { mode: "directory" }; // world Actors sidebar fallback
    const actorPacks = game.packs.filter(p => p.documentName === "Actor").map(p => p.collection);
    return { error: `Destination "${destId}" is not a compendium here. Actor packs present: ${actorPacks.join(", ") || "(none)"}` };
};

// action:"config" mode: parsed source list, read-only.
if (req.action === "config") {
    const config = readConfig();
    if (!config) return fail(`Config journal "${JOURNAL_NAME}" not found. Run the macro bare (hotbar click) once to seed it.`);
    const dest = resolveDestination(config.destination);
    const mark = (e) => ({ ...e, present: !!game.packs.get(e.id) });
    return {
        ok: true,
        destination: { id: config.destination, ...(dest.error ? { error: dest.error } : { mode: dest.mode }) },
        sources: config.sources.map(g => ({ group: g.group, entries: g.entries.map(mark) })),
        extras: config.extras.map(mark)
    };
}

// Bare run: seed + diagnostic dialog.
if (!req.actorData) {
    if (!findJournal()) await seedJournal();
    const config = readConfig();
    const dest = resolveDestination(config.destination);
    const destLine = dest.error
        ? `<span style="color:#a33">✗ ${esc(dest.error)}</span>`
        : dest.mode === "pack"
            ? `<span style="color:#282">✓ compendium ${esc(dest.pack.metadata.label)} (${esc(dest.pack.collection)})</span>`
            : `<span style="color:#282">✓ world Actors directory → folder "${esc(WORLD_FOLDER)}" (created on first forge)</span>`;
    const row = (e) => {
        const ok = !!game.packs.get(e.id);
        const label = e.label ? ` <i>${esc(e.label)}</i>` : "";
        return `<tr><td style="padding:1px 8px">${ok ? '<span style="color:#282">✓</span>' : '<span style="color:#a33">✗</span>'} ${esc(e.id)}${label}</td></tr>`;
    };
    const section = (title, entries) =>
        `<tr><td style="padding:4px 8px 1px"><b>${esc(title)}</b></td></tr>` + entries.map(row).join("");
    const body = config.sources.map(g => section(g.group, g.entries)).join("")
        + section("User Extra Content", config.extras.length ? config.extras : [])
        + (config.extras.length ? "" : `<tr><td style="padding:1px 8px"><i>(none - add "pack.id //Label" lines to the config journal)</i></td></tr>`);
    new Dialog({
        title: "Claude Foe Forge - source & routing diagnostic",
        content: `<p>This macro is invoked by Claude with an actor payload; a bare run only seeds/checks the config.</p>
                  <p><b>Destination:</b> ${destLine}</p>
                  <table style="border-collapse:collapse">${body}</table>
                  <p style="margin-top:6px">Sources are edited in the "${esc(JOURNAL_NAME)}" journal, not in this macro.</p>`,
        buttons: { ok: { label: "Close" } },
        default: "ok"
    }, { width: 680 }).render(true);
    return { ok: true, diagnostic: true };
}

// Validation (forge).
const warnings = [];
const config = readConfig() ?? (await seedJournal(), readConfig());
const dest = resolveDestination(config.destination);
if (dest.error) return fail(dest.error);

if (!req.actorData || typeof req.actorData !== "object") return fail("actorData missing or not an object.");
const data = foundry.utils.duplicate(req.actorData);
for (const k of ["_id", "folder", "pack", "ownership", "_stats", "sort"]) delete data[k];

if (typeof data.name !== "string" || !data.name.trim()) return fail("actorData.name must be a non-empty string.");
data.name = data.name.trim();

const validTypes = (Actor.TYPES ?? []).filter(t => t !== "base");
if (!validTypes.includes(data.type)) return fail(`actorData.type "${data.type}" is not a valid Actor type here. Valid: ${validTypes.join(", ")}`);
if (data.type === "character") return fail(`Foes are not player characters; use type "npc" (or another non-character type).`);
if (data.type !== "npc") warnings.push(`Type is "${data.type}", not "npc". Filed anyway; check the sheet.`);

if (data.img && /^https?:\/\//i.test(data.img))
    return fail(`img "${data.img}" is a remote URL; use a local path (icons/, systems/, modules/, worlds/).`);

if (req.linkItems !== undefined) {
    if (!Array.isArray(req.linkItems)) return fail("linkItems must be an array of item data objects.");
    for (const it of req.linkItems)
        if (!it || typeof it.name !== "string" || typeof it.type !== "string")
            return fail("Every linkItems entry needs at least a name and a type.");
}

// Icon coverage mandatory; allowIconless:true is the escape hatch.
const bareItems = (Array.isArray(data.items) ? data.items : [])
    .concat(req.linkItems ?? [])
    .filter(i => !i?.img || i.img === "icons/svg/item-bag.svg");
if (!req.allowIconless) {
    if (!data.img || data.img === "icons/svg/mystery-man.svg")
        return fail(`Actor portrait art is ${data.img ? `the default "${data.img}"` : "missing"}. Set a real img (source-pack indexes and FilePicker.browse have paths), or pass allowIconless:true deliberately.`);
    if (bareItems.length)
        return fail(`${bareItems.length} embedded item(s) carry no icon (first: "${bareItems[0].name}"). Copy each source item's img, or pass allowIconless:true deliberately.`,
            { iconless: bareItems.map(i => i.name) });
} else {
    if (!data.img) {
        data.img = "icons/svg/mystery-man.svg";
        warnings.push("allowIconless: no img supplied; defaulted to icons/svg/mystery-man.svg.");
    }
    if (bareItems.length) warnings.push(`allowIconless: ${bareItems.length} embedded item(s) filed without icons.`);
}

// HP floor governs damage, not creation; flag a sub-1 forge.
const hpv = foundry.utils.getProperty(data, "system.attributes.hp.value");
if (typeof hpv === "number" && hpv < 1) warnings.push(`Forged with hp.value ${hpv} (<1). Check the sheet.`);

// Hostile token defaults fill gaps; caller's values win.
data.prototypeToken = foundry.utils.mergeObject({
    disposition: CONST.TOKEN_DISPOSITIONS.HOSTILE,
    displayName: CONST.TOKEN_DISPLAY_MODES.OWNER_HOVER,
    displayBars: CONST.TOKEN_DISPLAY_MODES.OWNER_HOVER,
    bar1: { attribute: "attributes.hp" }
}, data.prototypeToken ?? {}, { inplace: false });

// Duplicate guard makes retries idempotent.
const norm = (s) => s.trim().toLowerCase();
const twin = dest.mode === "pack"
    ? dest.pack.index.find(e => norm(e.name ?? "") === norm(data.name))
    : game.actors.find(a => norm(a.name) === norm(data.name));
if (twin && !req.allowDuplicate)
    return fail(`"${data.name}" already exists in ${dest.mode === "pack" ? dest.pack.collection : "the world Actors directory"} (${twin.uuid}). Pass allowDuplicate:true to force.`,
        { duplicate: true, existing: twin.uuid });

// Create, link items, read-back verify.
let created, check, folderName = null;
const wasLocked = dest.mode === "pack" && dest.pack.locked;
try {
    if (dest.mode === "pack") {
        if (wasLocked) await dest.pack.configure({ locked: false });
        created = await Actor.create(data, { pack: dest.pack.collection });
    } else {
        let folder = game.folders.find(f => f.type === "Actor" && f.name === WORLD_FOLDER);
        folder ??= await Folder.create({ name: WORLD_FOLDER, type: "Actor" });
        data.folder = folder.id;
        folderName = folder.name;
        created = await Actor.create(data);
    }
    if (!created) return fail("Actor.create returned nothing; foe was not created.");

    if (req.linkItems?.length) {
        try {
            await created.createEmbeddedDocuments("Item", req.linkItems);
        } catch (err) {
            warnings.push(`Actor created but linkItems failed: ${err.message}. Repair via a follow-up, don't re-forge.`);
        }
    }

    check = dest.mode === "pack" ? await dest.pack.getDocument(created.id) : game.actors.get(created.id);
    if (!check) return fail(`Created "${data.name}" but read-back found nothing. Investigate before retrying.`, { uuid: created.uuid });
} catch (err) {
    return fail(`Create failed: ${err.message}`);
} finally {
    if (wasLocked) await dest.pack.configure({ locked: true }).catch(e => console.error(TAG, "relock failed", e));
}

const result = {
    ok: true,
    uuid: created.uuid,
    name: created.name,
    type: created.type,
    destination: dest.mode === "pack" ? dest.pack.collection : "world Actors directory",
    folder: folderName,
    items: check.items?.size ?? 0,
    linkedItems: req.linkItems?.length ?? 0,
    warnings
};
console.log(TAG, "forged", result);
ui.notifications.info(`Claude Foe Forge: "${created.name}" → ${result.folder ?? result.destination}${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? "s" : ""}, see console)` : ""}`);
return result;
