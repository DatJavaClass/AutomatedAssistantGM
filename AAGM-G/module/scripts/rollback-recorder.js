/* Records every document a recorded write touches. */

const DOC_TYPES = ['Actor','Item','Scene','JournalEntry','JournalEntryPage','Macro','RollTable','TableResult','Playlist','PlaylistSound','Folder','Token','ActiveEffect','Combat','Combatant','Wall','Tile','Drawing','MeasuredTemplate','Note','AmbientLight','AmbientSound','Cards','Card','ChatMessage','User','Region','RegionBehavior','Setting','FogExploration'];
const SIZE_CAP = 4_000_000;

/* Same deny list as the relay eval guard. */
const DENY_IDS = new Set(['yB5klzKycb6bTbcy', 'REPLACE_WITH_RESCUE_LOG_JOURNAL_ID', 'qT0K8p3N4jMuPcP9', 'zV2mxKvnDWcGqi9F']);
const DENY_NAME = /^(?:NPC Register|Mail Index|Mailbox Index|ItemPile Rescue Log|SkillList|World Travel Log:.*)$/i;

let installed = false;
let rec = null; // { id, entries, updated:Set, created:Set }
let chain = Promise.resolve();

const managed = (p) => p?.getFlag?.('world', 'runManaged') || p?.flags?.world?.runManaged;

/* Deny list by id, name, or runManaged page. */
export function isProtectedJournal(j) {
  try {
    if (DENY_IDS.has(j.id) || DENY_NAME.test(String(j.name ?? ''))) return true;
    return Array.from(j.pages ?? []).some(managed);
  } catch { return true; } // unsure means skip
}

/* Database Journals never enter a point. */
function denied(doc) {
  try {
    const page = doc.documentName === 'JournalEntryPage';
    const j = page ? doc.parent : doc.documentName === 'JournalEntry' ? doc : null;
    if (!j) return false;
    return (page && !!managed(doc)) || isProtectedJournal(j);
  } catch { return true; } // unsure means skip
}

function snap(doc) {
  let obj, partial = false, len;
  try { obj = doc.toObject(); } catch { obj = { _id: doc.id, name: doc.name }; partial = true; }
  try { len = JSON.stringify(obj).length; } catch { len = Infinity; }
  return len > SIZE_CAP ? { obj: null, oversized: true, partial } : { obj, oversized: false, partial };
}

function stamp(entry, s) {
  if (s.oversized) entry.oversized = true;
  if (s.partial) entry.partial = true;
  return entry;
}

function onPreUpdate(doc) {
  if (!rec || denied(doc)) return;
  const uuid = doc.uuid;
  if (rec.updated.has(uuid) || rec.created.has(uuid)) return; // earliest state wins
  rec.updated.add(uuid);
  const s = snap(doc);
  rec.entries.push(stamp({ op: 'update', uuid, documentName: doc.documentName, name: doc.name ?? null, before: s.obj }, s));
}

function onPreCreate(doc, data, options) {
  if (rec && options && !denied(doc)) options._aagmRp = rec.id;
}

function onCreate(doc, options) {
  if (!rec || options?._aagmRp !== rec.id) return;
  rec.created.add(doc.uuid);
  rec.entries.push({ op: 'create', uuid: doc.uuid, documentName: doc.documentName, name: doc.name ?? null });
}

function onPreDelete(doc) {
  if (!rec || denied(doc)) return;
  const s = snap(doc);
  rec.entries.push(stamp({ op: 'delete', uuid: doc.uuid, documentName: doc.documentName, name: doc.name ?? null,
    parentUuid: doc.parent?.uuid ?? null, pack: doc.pack ?? null, data: s.obj }, s));
}

export function installRecorder() {
  if (installed) return;
  installed = true;
  for (const T of DOC_TYPES) {
    Hooks.on(`preUpdate${T}`, onPreUpdate);
    Hooks.on(`preCreate${T}`, onPreCreate);
    Hooks.on(`create${T}`, onCreate);
    Hooks.on(`preDelete${T}`, onPreDelete);
  }
}

function enqueue(fn) {
  const p = chain.then(() => fn());
  chain = p.catch(() => {}); // failures never jam the chain
  return p;
}

export function runRecorded(rp, fn) {
  return enqueue(async () => {
    rec = { id: rp.id, entries: [], updated: new Set(), created: new Set() };
    const entries = rec.entries;
    try {
      const result = await fn();
      return { result, entries };
    } catch (err) {
      if (err && typeof err === 'object') err.rollbackEntries = entries;
      throw err;
    } finally {
      rec = null;
    }
  });
}

export function runExclusive(fn) {
  return enqueue(fn);
}
