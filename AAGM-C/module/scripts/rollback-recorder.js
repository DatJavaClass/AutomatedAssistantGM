// Hook recorder for Rollback Points.

const DOC_TYPES = ['Actor','Item','Scene','JournalEntry','JournalEntryPage','Macro','RollTable','TableResult','Playlist','PlaylistSound','Folder','Token','ActiveEffect','Combat','Combatant','Wall','Tile','Drawing','MeasuredTemplate','Note','AmbientLight','AmbientSound','Cards','Card','ChatMessage','User','Region','RegionBehavior','Setting','FogExploration'];
const SIZE_CAP = 4_000_000;

let installed = false;
let rec = null; // { id, entries, updated:Set, created:Set }
let chain = Promise.resolve();

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
  if (!rec) return;
  const uuid = doc.uuid;
  if (rec.updated.has(uuid) || rec.created.has(uuid)) return; // earliest state wins
  rec.updated.add(uuid);
  const s = snap(doc);
  rec.entries.push(stamp({ op: 'update', uuid, documentName: doc.documentName, name: doc.name ?? null, before: s.obj }, s));
}

function onPreCreate(doc, data, options) {
  if (rec && options) options._aagmRp = rec.id;
}

function onCreate(doc, options) {
  if (!rec || options?._aagmRp !== rec.id) return;
  rec.created.add(doc.uuid);
  rec.entries.push({ op: 'create', uuid: doc.uuid, documentName: doc.documentName, name: doc.name ?? null });
}

function onPreDelete(doc) {
  if (!rec) return;
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
