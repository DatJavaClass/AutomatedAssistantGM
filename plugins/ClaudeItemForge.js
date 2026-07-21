/* Claude Item Forge - files magic items into the "Claude Items" world pack.
   GM-only Script macro; contract and storage layout documented in the README. */

if (!game.user.isGM) return ui.notifications.warn("Claude Item Forge is a GM tool.");

const TAG = "[ClaudeItemForge]";
const req = (typeof scope === "object" && scope) ? scope : {};

// Storage layout: pack + folder tree.
const PACK_NAME = "claude-items";
const PACK_LABEL = "Claude Items";

// Definition order matters: parents are created before children.
const FOLDER_DEFS = [
    { key: "weapons-root",   name: "Claude Magic Weapons",         parent: null },
    { key: "weapon-simple",  name: "Claude Magic Simple Weapons",  parent: "weapons-root" },
    { key: "weapon-martial", name: "Claude Magic Martial Weapons", parent: "weapons-root" },
    { key: "weapon-exotic",  name: "Claude Magic Exotic Weapons",  parent: "weapons-root" },
    { key: "weapon-firearm", name: "Claude Magic Firearms",        parent: "weapons-root" },
    { key: "ammo",           name: "Claude Magic Ammo",            parent: "weapons-root" },
    { key: "magic-armor",    name: "Claude Magic Armor",           parent: null },
    { key: "wondrous",       name: "Claude Wondrous Items",        parent: null },
    { key: "alchemy",        name: "Claude Alchemy",               parent: null },
];

// Valid destinations (weapons-root is structural).
const ROUTES = {
    "alchemy":        "consumables: potions, alchemical gear",
    "magic-armor":    "magic armor, shields, armor add-ons",
    "wondrous":       "wands, staves, and all other non-weapon magic",
    "weapon-simple":  "magic simple weapons",
    "weapon-martial": "magic martial weapons",
    "weapon-exotic":  "magic exotic weapons",
    "weapon-firearm": "magic firearms",
    "ammo":           "magic ammunition",
};

// Portable-pack safety: system-resolvable paths only.
const IMG_OK = new RegExp(`^(icons/|systems/${game.system.id}/)`);

const fail = (error, extra = {}) => {
    ui.notifications.warn(`Claude Item Forge: ${error}`);
    console.warn(TAG, error, extra);
    return { ok: false, error, ...extra };
};

// Ensure storage (pack + folder tree, idempotent).
let pack = game.packs.find(p =>
    p.metadata.packageType === "world" &&
    (p.metadata.name === PACK_NAME || p.metadata.label === PACK_LABEL) &&
    p.metadata.type === "Item");

const wasLocked = pack?.locked ?? false;
const created_folders = [];
try {
    if (!pack) {
        pack = await CompendiumCollection.createCompendium({ name: PACK_NAME, label: PACK_LABEL, type: "Item" });
        console.log(TAG, `created world compendium "${PACK_LABEL}" (${pack.collection})`);
    }
    if (pack.locked) await pack.configure({ locked: false });

    const folderByKey = {};
    for (const def of FOLDER_DEFS) {
        let f = pack.folders.find(x => x.name === def.name);
        if (!f) {
            f = await Folder.create(
                { name: def.name, type: "Item", folder: def.parent ? folderByKey[def.parent].id : null },
                { pack: pack.collection });
            created_folders.push(def.name);
        }
        folderByKey[def.key] = f;
    }

    // Bare run: setup + diagnostic, writes no item.
    if (!req.destination && !req.itemData) {
        const rows = Object.entries(ROUTES).map(([key, holds]) =>
            `<tr><td style="padding:2px 8px;white-space:nowrap"><b>${key}</b></td>
                 <td style="padding:2px 8px">${folderByKey[key].name}</td>
                 <td style="padding:2px 8px">${holds}</td></tr>`).join("");
        new Dialog({
            title: "Claude Item Forge - storage diagnostic",
            content: `<p>Pack <b>${pack.metadata.label}</b> (<code>${pack.collection}</code>) is ready.
                      ${created_folders.length ? `Created this run: ${created_folders.join(", ")}.` : "All folders already existed."}</p>
                      <p>This macro is invoked by Claude with an item payload; a bare run only sets up and checks storage.</p>
                      <table style="border-collapse:collapse">${rows}</table>`,
            buttons: { ok: { label: "Close" } },
            default: "ok"
        }, { width: 680 }).render(true);
        return { ok: true, diagnostic: true, pack: pack.collection, createdFolders: created_folders };
    }

    // Validation.
    const warnings = [];
    if (!ROUTES[req.destination])
        return fail(`Unknown destination "${req.destination}". Valid: ${Object.keys(ROUTES).join(", ")}`);
    const folder = folderByKey[req.destination];

    if (!req.itemData || typeof req.itemData !== "object") return fail("itemData missing or not an object.");
    const data = foundry.utils.duplicate(req.itemData);
    for (const k of ["_id", "folder", "pack", "ownership", "_stats", "sort"]) delete data[k];

    if (typeof data.name !== "string" || !data.name.trim()) return fail("itemData.name must be a non-empty string.");
    data.name = data.name.trim();

    const validTypes = (Item.TYPES ?? []).filter(t => t !== "base");
    if (!validTypes.includes(data.type))
        return fail(`itemData.type "${data.type}" is not a valid Item type in this world. Valid: ${validTypes.join(", ")}`);
    if (req.destination.startsWith("weapon-") && data.type !== "weapon")
        return fail(`Destination "${req.destination}" requires type "weapon", got "${data.type}".`);

    if (!data.img) {
        data.img = "icons/svg/item-bag.svg";
        warnings.push("No img supplied; defaulted to icons/svg/item-bag.svg.");
    } else if (!IMG_OK.test(data.img)) {
        return fail(`img "${data.img}" violates the portable-pack image policy (must start with "icons/" or "systems/${game.system.id}/").`);
    }
    // Same policy in description; embedded <img> breaks portability.
    const desc = foundry.utils.getProperty(data, "system.description.value");
    if (typeof desc === "string" && /<img[\s>]/i.test(desc))
        return fail("system.description.value contains an <img> tag; embedded images are not allowed in the pack.");

    // Duplicate guard makes retries idempotent.
    const norm = (s) => s.trim().toLowerCase();
    const twin = pack.index.find(e => norm(e.name ?? "") === norm(data.name));
    if (twin && !req.allowDuplicate)
        return fail(`"${data.name}" already exists in ${pack.collection} (${twin.uuid}). Pass allowDuplicate:true to force.`,
            { duplicate: true, existing: twin.uuid });

    // Create then read-back verify.
    data.folder = folder.id;
    const created = await Item.create(data, { pack: pack.collection });
    if (!created) return fail("Item.create returned nothing; item was not created.");

    const check = await pack.getDocument(created.id);
    if (!check) return fail(`Created "${data.name}" but read-back from ${pack.collection} found nothing. Investigate before retrying.`, { uuid: created.uuid });
    const checkFolderId = check.folder?.id ?? check.folder ?? null;
    if (checkFolderId !== folder.id)
        warnings.push(`Read-back folder is "${checkFolderId}", expected "${folder.id}" (${folder.name}). Move it manually if it landed loose.`);

    const result = {
        ok: true,
        uuid: created.uuid,
        name: created.name,
        type: created.type,
        pack: pack.collection,
        folder: folder.name,
        warnings
    };
    console.log(TAG, "forged", result);
    ui.notifications.info(`Claude Item Forge: "${created.name}" → ${folder.name}${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? "s" : ""}, see console)` : ""}`);
    return result;

} catch (err) {
    return fail(`Forge failed: ${err.message}`);
} finally {
    if (wasLocked && pack) await pack.configure({ locked: true }).catch(e => console.error(TAG, "relock failed", e));
}
