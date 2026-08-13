// Rescue-queue handlers for the Claude Loot Watchdog. These are the ONLY code
// paths allowed to touch the ItemPile Rescue Log journal: it is a
// journal-as-database, so eval refuses it (relay/src/eval-guard.js) and all
// access goes through here instead.
//
// loot.restore is deliberately un-gated (authorized by DatJavaClass
// 2026-07-14) because it is a constrained primitive: it can only recreate
// exactly what the watchdog recorded, in the recorded shortfall quantity, on
// the recorded recipient. Phantom "trait as loot" records live in a separate
// bucket and are never restorable; they can only be acknowledged.

const RESCUE_LOG_UUID = 'JournalEntry.sbO4oAzBIcAN9b0E';
const FLAG_SCOPE = 'world';
const FLAG_KEY = 'claude-loot-rescue';
const LEGACY_FLAG_KEY = 'itempile-rescue-pending';
const PAGE_NAME = 'Session Log';

async function getLog() {
  const log = await fromUuid(RESCUE_LOG_UUID);
  if (!log) {
    const err = new Error(`rescue log journal not found at ${RESCUE_LOG_UUID}`);
    err.code = -33002;
    throw err;
  }
  return log;
}

function brief(r) {
  return {
    eventId: r.eventId,
    kind: r.kind,
    outcome: r.outcome ?? null,
    item: r.itemData?.name ?? null,
    type: r.itemData?.type ?? null,
    subType: r.itemData?.system?.subType ?? null,
    expectedQty: r.expectedQty,
    deliveredQty: r.deliveredQty,
    shortfall: r.shortfall,
    recipient: r.recipientName,
    recipientUuid: r.recipientUuid,
    looter: r.looterName,
    pile: r.pileName,
    ts: r.ts,
  };
}

export async function handleLootPending() {
  const log = await getLog();
  const stash = log.getFlag(FLAG_SCOPE, FLAG_KEY) || {};
  const legacy = log.getFlag(FLAG_SCOPE, LEGACY_FLAG_KEY) || {};
  return {
    pending: Object.values(stash.pending || {}).map(brief),
    phantoms: Object.values(stash.phantoms || {}).map(brief),
    // Entries written by the retired standalone watchdog macro. They lack
    // reliable recipient attribution, so they are report-only.
    legacyCount: Object.keys(legacy).length,
  };
}

async function appendToLog(log, html) {
  const page = log.pages.getName(PAGE_NAME);
  if (!page) return;
  const cur = page.text?.content || '';
  await page.update({ 'text.content': cur + '\n' + html });
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function handleLootRestore(params = {}) {
  const { eventIds, ackPhantoms } = params;
  const log = await getLog();
  const restored = [];
  const failed = [];

  const stashNow = () => foundry.utils.deepClone(log.getFlag(FLAG_SCOPE, FLAG_KEY) || {});
  const targets = eventIds?.length
    ? eventIds
    : Object.keys(stashNow().pending || {});

  for (const eventId of targets) {
    // Re-read fresh per entry: an entry present means not-yet-restored, so a
    // desynced second caller can never double-grant.
    const stash = stashNow();
    const rec = stash.pending?.[eventId];
    if (!rec) {
      failed.push({ eventId, reason: 'not in pending queue (already restored?)' });
      continue;
    }
    try {
      let doc = await fromUuid(rec.recipientUuid);
      const actor = doc instanceof Actor ? doc : doc?.actor ?? null;
      if (!actor) throw new Error(`recipient not found at ${rec.recipientUuid}`);

      const data = foundry.utils.deepClone(rec.itemData);
      delete data._id;
      if (data.system && data.system.quantity != null) data.system.quantity = rec.shortfall;
      data.flags = data.flags || {};
      data.flags['foundry-bridge'] = { restoredFrom: eventId, restoredAt: new Date().toISOString() };

      const created = await actor.createEmbeddedDocuments('Item', [data]);
      if (!created?.length) throw new Error('createEmbeddedDocuments returned nothing');

      // Only after the item verifiably exists does the entry leave the queue.
      // setFlag merges, so key removal must use Foundry's -= deletion syntax.
      await log.update({ [`flags.${FLAG_SCOPE}.${FLAG_KEY}.pending.-=${eventId}`]: null });

      await appendToLog(log,
        `<p><strong>RESTORED</strong> ${new Date().toLocaleTimeString()} : `
        + `<strong>${esc(rec.itemData.name)}</strong> x ${rec.shortfall} to <em>${esc(rec.recipientName)}</em> `
        + `by Claude (event <code>${esc(eventId)}</code>)</p>`);

      restored.push({ eventId, item: rec.itemData.name, qty: rec.shortfall, recipient: rec.recipientName, createdId: created[0].id });
    } catch (err) {
      failed.push({ eventId, item: rec.itemData?.name, reason: err.message });
    }
  }

  let acked = 0;
  if (ackPhantoms?.length) {
    const stash = stashNow();
    const removals = {};
    for (const id of ackPhantoms) {
      if (stash.phantoms?.[id]) {
        removals[`flags.${FLAG_SCOPE}.${FLAG_KEY}.phantoms.-=${id}`] = null;
        acked++;
      }
    }
    if (acked) await log.update(removals);
  }

  return { restored, failed, ackedPhantoms: acked };
}
