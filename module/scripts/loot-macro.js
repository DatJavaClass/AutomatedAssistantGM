// "Claude Loot Watchdog" macro, serialized into a world macro by bridge.js
// (same Function.toString pattern as chat-macro.js; no build step to break).
//
// Successor to the standalone Item Piles Loot Watchdog macro. Detection is
// two-layer: Item Piles' own transfer hooks provide ATTRIBUTION (which pile,
// which recipient, which user), and core createItem/updateItem hooks on the
// recipient provide VERIFICATION (did the item actually land, including
// quantity merges into an existing stack, which fire updateItem not
// createItem). A shortfall after the verify window is a vanish: the full
// item snapshot goes into the rescue queue (a flag stash on the Rescue Log
// journal) for foundry_restore_loot to replay.
//
// Attribution comes from two hook families because their reach differs
// (verified against Item Piles source, 2026-07-14): PRE-transfer hooks run
// via Helpers.hooks.call - LOCAL to the client that initiates the transfer -
// so alone they miss every player-initiated loot (the 2026-07-14 test:
// tracked 0 / ignored 58). POST-transfer hooks are broadcast to every client
// through Item Piles' own socket (ItemPileSocket.callHook ->
// executeForEveryone), with full item data in the deltas. Pre gives this
// client's own transfers their exact intent; post covers everyone else;
// duplicates are merged. Residual gap: a transfer whose pipeline dies before
// the post hook broadcast, initiated on another client, is invisible here.
//
// pf1 11.11 "trait as loot" phantoms: statblock-converted gear is type
// equipment with a subType (e.g. "misc") that is no longer a valid pf1
// equipment subtype, so the sheet renders it nowhere while its weight still
// counts. Phantoms are HELD and reported, never queued for restore.
//
// Non-intercepting observer: it never cancels or alters a transfer; worst
// case it logs wrong. Manual arm only: run the macro to arm, again to disarm.

async function lootWatchdogMain() {
  const RESCUE_LOG_UUID = 'JournalEntry.sbO4oAzBIcAN9b0E';
  const FLAG_SCOPE = 'world';
  const FLAG_KEY = 'claude-loot-rescue';
  const WINDOW_KEY = '__claudeLootWatchdog';
  const VERIFY_WINDOW_MS = 4000;
  const PAGE_NAME = 'Session Log';
  const TAG = '[ClaudeLootWatchdog]';
  const L = (k) => game.i18n.localize('FOUNDRY_BRIDGE.LOOT.' + k);

  if (!game.user.isGM) {
    ui.notifications.warn(L('GmOnly'));
    return;
  }

  // Toggle: re-running the macro disarms.
  const prev = window[WINDOW_KEY];
  if (prev && prev.armed) {
    for (const [hookName, hookId] of prev.hookIds) Hooks.off(hookName, hookId);
    for (const rec of prev.watch.values()) clearTimeout(rec.timerId);
    prev.watch.clear();
    prev.armed = false;
    ui.notifications.info(L('Disarmed'));
    console.log(TAG, 'disarmed', prev.stats);
    return;
  }

  const rescueLog = await fromUuid(RESCUE_LOG_UUID);
  if (!rescueLog) {
    ui.notifications.error(L('NoJournal') + ' ' + RESCUE_LOG_UUID);
    return;
  }

  let page = rescueLog.pages.getName(PAGE_NAME);
  if (!page) {
    const created = await rescueLog.createEmbeddedDocuments('JournalEntryPage', [{
      name: PAGE_NAME, type: 'text', 'text.content': '<h2>ItemPile Rescue Log</h2>\n',
    }]);
    page = created[0];
  }

  // Every journal write (page HTML and flag stash) runs through one promise
  // chain so rapid events cannot read-modify-write over each other.
  let chain = Promise.resolve();
  const enqueue = (job) => {
    chain = chain.then(job).catch((err) => console.error(TAG, 'journal write failed:', err));
    return chain;
  };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const appendToLog = (html) => enqueue(async () => {
    const fresh = await fromUuid(page.uuid);
    const cur = (fresh && fresh.text && fresh.text.content) || '';
    await fresh.update({ 'text.content': cur + '\n' + html });
  });
  const stashPut = (bucket, eventId, record) => enqueue(async () => {
    const stash = foundry.utils.deepClone(rescueLog.getFlag(FLAG_SCOPE, FLAG_KEY) || {});
    if (!stash[bucket]) stash[bucket] = {};
    stash[bucket][eventId] = record;
    await rescueLog.setFlag(FLAG_SCOPE, FLAG_KEY, stash);
  });

  // Phantom classifier: only physical types are real loot, and equipment must
  // carry a subType the current pf1 sheet can actually render.
  const PHYSICAL_TYPES = new Set(['weapon', 'equipment', 'consumable', 'loot', 'container', 'implant']);
  const classifyItemData = (d) => {
    if (!PHYSICAL_TYPES.has(d.type)) return 'phantom';
    if (d.type === 'equipment') {
      const valid = Object.keys((globalThis.pf1 && pf1.config && pf1.config.equipmentTypes) || {});
      const sub = d.system ? d.system.subType : null;
      if (valid.length && !valid.includes(sub)) return 'phantom';
    }
    return 'physical';
  };

  const isLootPile = (actor) => {
    const ip = actor && actor.flags && actor.flags['item-piles'] && actor.flags['item-piles'].data;
    if (!ip || ip.enabled !== true) return false;
    return !['merchant', 'vault', 'auctioneer'].includes(ip.type);
  };
  const isPlayerActor = (actor) => {
    if (!actor) return false;
    for (const [userId, level] of Object.entries(actor.ownership || {})) {
      if (userId === 'default') continue;
      const u = game.users.get(userId);
      if (u && !u.isGM && level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) return true;
    }
    return false;
  };
  const resolveActor = (thing) => {
    if (!thing) return null;
    if (thing instanceof Actor) return thing;
    if (thing.actor instanceof Actor) return thing.actor;
    if (typeof thing === 'string') {
      try { return resolveActor(fromUuidSync(thing)); } catch (e) { return null; }
    }
    if (thing.documentName === 'Actor') return thing;
    return null;
  };
  const fingerprint = (d) => [
    d.name, d.type,
    (d.system && d.system.subType) || '',
    (d._stats && d._stats.compendiumSource) || (d.flags && d.flags.core && d.flags.core.sourceId) || '',
    d.img || '',
  ].join('|');
  const qtyOf = (d) => Number((d.system && d.system.quantity) != null ? d.system.quantity : 1) || 1;

  // Item Piles hook args vary slightly by version; duck-type instead of
  // trusting positions blindly. Order is preserved: source before target.
  const parseIpArgs = (args) => {
    const actors = [];
    let items = null;
    let userId = null;
    for (const a of args) {
      if (Array.isArray(a)) { if (items === null) items = a; continue; }
      if (typeof a === 'string') {
        if (game.users.get(a)) { userId = a; continue; }
        const act = resolveActor(a);
        if (act) actors.push(act);
        continue;
      }
      const act = resolveActor(a);
      if (act) actors.push(act);
    }
    return { source: actors[0] || null, target: actors[1] || null, items: items || [], userId };
  };
  const snapshotFromEntry = (entry, sourceActor) => {
    const raw = entry && entry.item ? entry.item : entry;
    const id = raw && (raw._id || raw.id);
    const live = id && sourceActor ? sourceActor.items.get(id) : null;
    const data = live ? live.toObject(true) : (raw && raw.name ? foundry.utils.deepClone(raw) : null);
    if (!data) return null;
    // Post-hook deltas can be signed; a transfer's magnitude is what matters.
    const qty = Math.abs(Number(entry && entry.quantity != null ? entry.quantity : qtyOf(data))) || qtyOf(data);
    return { data, qty };
  };

  const controller = {
    armed: true,
    hookIds: [],
    watch: new Map(),
    stats: { tracked: 0, delivered: 0, vanished: 0, phantoms: 0, ignored: 0, dupes: 0 },
  };
  window[WINDOW_KEY] = controller;

  // The broadcast post hook and the DB-replicated document events race on
  // this client: a remote loot's createItem can arrive before the transfer
  // hook that opens its record. Uncredited arrivals wait here so a
  // late-opening record is credited instead of settling as a false vanish
  // (which would queue a restore for an item that actually landed).
  const recentArrivals = [];
  const rememberArrival = (item, mode) => {
    if (!isPlayerActor(item.parent)) return;
    const d = item.toObject(true);
    recentArrivals.push({
      fingerprint: fingerprint(d), actorUuid: item.parent.uuid,
      itemUuid: item.uuid, qty: qtyOf(d), mode, at: Date.now(),
    });
    const cutoff = Date.now() - VERIFY_WINDOW_MS * 2;
    while (recentArrivals.length && recentArrivals[0].at < cutoff) recentArrivals.shift();
  };

  const newEventId = () => 'lw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  async function settle(rec) {
    controller.watch.delete(rec.eventId);
    const shortfall = Math.max(0, rec.expectedQty - rec.deliveredQty);
    const stamp = new Date(rec.ts).toLocaleTimeString();

    if (rec.kind === 'phantom') {
      controller.stats.phantoms++;
      const outcome = shortfall === 0 ? 'landed' : 'lost';
      await stashPut('phantoms', rec.eventId, {
        eventId: rec.eventId, kind: 'phantom', outcome, via: rec.via,
        itemData: rec.itemData, expectedQty: rec.expectedQty, deliveredQty: rec.deliveredQty, shortfall,
        pileName: rec.pileName, pileUuid: rec.pileUuid,
        recipientName: rec.recipientName, recipientUuid: rec.recipientUuid,
        looterName: rec.looterName, looterId: rec.looterId,
        landedItemUuid: rec.landedItemUuid || null, ts: rec.ts,
      });
      ui.notifications.warn(L('Phantom'), { permanent: true });
      await ChatMessage.create({
        content: '<div style="border:2px solid #c80; padding:8px; background:#fed;">'
          + '<strong>PHANTOM "TRAIT AS LOOT" DETECTED (' + esc(outcome) + ')</strong><br>'
          + '<strong>Item:</strong> ' + esc(rec.itemData.name) + ' (' + esc(rec.itemData.type) + '/' + esc((rec.itemData.system && rec.itemData.system.subType) || '?') + ')<br>'
          + '<strong>Pile:</strong> ' + esc(rec.pileName) + '<br>'
          + '<strong>Looter:</strong> ' + esc(rec.looterName || '(unknown)') + '<br>'
          + '<strong>Intended for:</strong> ' + esc(rec.recipientName || '(unknown)') + '<br>'
          + '<em>Held for review, never auto-restored. Event ' + esc(rec.eventId) + '</em></div>',
        whisper: ChatMessage.getWhisperRecipients('GM'),
        speaker: { alias: 'Claude Loot Watchdog' },
      });
      await appendToLog('<div style="border-left:4px solid #c80; padding-left:8px; margin:8px 0;">'
        + '<p><strong>PHANTOM (' + esc(outcome) + ')</strong> ' + stamp + ' : ' + esc(rec.itemData.name)
        + ' from <em>' + esc(rec.pileName) + '</em> looted by <em>' + esc(rec.looterName || '?') + '</em>'
        + ' for <em>' + esc(rec.recipientName || '?') + '</em> (event <code>' + esc(rec.eventId) + '</code>)</p></div>');
      return;
    }

    if (shortfall === 0) {
      controller.stats.delivered++;
      await appendToLog('<p>OK ' + stamp + ' : <strong>' + esc(rec.itemData.name) + '</strong> x ' + rec.expectedQty
        + ' from <em>' + esc(rec.pileName) + '</em> to <em>' + esc(rec.recipientName) + '</em>'
        + ' (looted by ' + esc(rec.looterName || '?') + ')</p>');
      return;
    }

    controller.stats.vanished++;
    console.error(TAG, 'VANISH:', rec.itemData.name, 'x' + shortfall, 'to', rec.recipientName);
    await stashPut('pending', rec.eventId, {
      eventId: rec.eventId, kind: 'item', status: 'pending', via: rec.via,
      itemData: rec.itemData, expectedQty: rec.expectedQty, deliveredQty: rec.deliveredQty, shortfall,
      pileName: rec.pileName, pileUuid: rec.pileUuid,
      recipientName: rec.recipientName, recipientUuid: rec.recipientUuid,
      looterName: rec.looterName, looterId: rec.looterId, ts: rec.ts,
    });
    ui.notifications.error(L('Vanish'), { permanent: true });
    await ChatMessage.create({
      content: '<div style="border:2px solid #c00; padding:8px; background:#fee;">'
        + '<strong>ITEM VANISH DETECTED</strong><br>'
        + '<strong>Item:</strong> ' + esc(rec.itemData.name) + ' x ' + shortfall + '<br>'
        + '<strong>Pile:</strong> ' + esc(rec.pileName) + '<br>'
        + '<strong>Looter:</strong> ' + esc(rec.looterName || '(unknown)') + '<br>'
        + '<strong>Owed to:</strong> ' + esc(rec.recipientName || '(unknown)') + '<br>'
        + '<em>Queued for Claude auto-restore. Event ' + esc(rec.eventId) + '</em></div>',
      whisper: ChatMessage.getWhisperRecipients('GM'),
      speaker: { alias: 'Claude Loot Watchdog' },
    });
    await appendToLog('<div style="border-left:4px solid #c00; padding-left:8px; margin:8px 0;">'
      + '<p><strong>VANISH</strong> ' + stamp + ' : <strong>' + esc(rec.itemData.name) + '</strong> x ' + shortfall
      + ' from <em>' + esc(rec.pileName) + '</em> owed to <em>' + esc(rec.recipientName || '?') + '</em>'
      + ' (looted by ' + esc(rec.looterName || '?') + ', event <code>' + esc(rec.eventId) + '</code>)</p>'
      + '<details><summary>Full item data</summary><pre>' + esc(JSON.stringify(rec.itemData, null, 2)) + '</pre></details></div>');
  }

  function track(source, target, entry, userId, via) {
    const snap = snapshotFromEntry(entry, source);
    if (!snap) return;
    const fp = fingerprint(snap.data);

    // A transfer this client initiated arrives twice: once from the local pre
    // hook, once from its own post-hook broadcast echoing back. One open
    // record per (item, pile, recipient) - the credit layer verifies against
    // the earlier record's intent either way.
    for (const open of controller.watch.values()) {
      if (open.fingerprint === fp && open.pileUuid === source.uuid && open.recipientUuid === target.uuid) {
        controller.stats.dupes++;
        return;
      }
    }

    const targetStack = target.items.find((i) => fingerprint(i.toObject(true)) === fp);
    const rec = {
      eventId: newEventId(),
      via: via || 'pre',
      kind: classifyItemData(snap.data),
      itemData: snap.data,
      fingerprint: fp,
      expectedQty: snap.qty,
      deliveredQty: 0,
      targetPreQty: targetStack ? qtyOf(targetStack.toObject(true)) : 0,
      pileName: source.name, pileUuid: source.uuid,
      recipient: target, recipientName: target.name, recipientUuid: target.uuid,
      looterName: (game.users.get(userId) && game.users.get(userId).name) || null,
      looterId: userId || null,
      landedItemUuid: null,
      ts: new Date().toISOString(),
      timerId: null,
    };
    rec.timerId = setTimeout(() => {
      if (controller.watch.has(rec.eventId)) {
        settle(rec).catch((e) => console.error(TAG, 'settle error:', e));
      }
    }, VERIFY_WINDOW_MS);
    controller.watch.set(rec.eventId, rec);
    controller.stats.tracked++;
    console.log(TAG, 'tracking', rec.kind + ':', snap.data.name, 'x' + snap.qty, '->', target.name, 'via', rec.via);

    // Credit any delivery that raced ahead of this record.
    for (const a of recentArrivals) {
      if (!a.at || a.fingerprint !== fp || a.actorUuid !== rec.recipientUuid) continue;
      // A create tells us exactly what arrived; a quantity merge from a
      // remote transfer has no pre-quantity to diff against, so it counts as
      // full delivery (observer bias: rather miss a vanish than restore a
      // duplicate).
      rec.deliveredQty += (a.mode === 'create') ? a.qty : rec.expectedQty;
      rec.landedItemUuid = a.itemUuid;
      a.at = 0; // consumed - an arrival credits at most one record
    }
    if (rec.deliveredQty >= rec.expectedQty) {
      clearTimeout(rec.timerId);
      settle(rec).catch((e) => console.error(TAG, 'settle error:', e));
    }
  }

  function onPreTransfer({ source, target, items, userId }) {
    if (!source || !target || !isLootPile(source) || !isPlayerActor(target)) return;
    for (const entry of items) track(source, target, entry, userId);
  }

  function onPreTransferAll({ source, target, userId }) {
    if (!source || !target || !isLootPile(source) || !isPlayerActor(target)) return;
    for (const item of source.items) {
      const d = item.toObject(true);
      if (classifyItemData(d) === 'phantom' && !PHYSICAL_TYPES.has(d.type)) continue;
      track(source, target, d, userId);
    }
  }

  function onPostTransfer({ source, target, items, userId }) {
    if (!source || !target || !isLootPile(source) || !isPlayerActor(target)) return;
    for (const entry of items) track(source, target, entry, userId, 'post');
  }

  const creditDelivery = (item, mode) => {
    const parent = item.parent;
    if (!(parent instanceof Actor)) return;
    const d = item.toObject(true);
    const fp = fingerprint(d);
    let match = null;
    for (const rec of controller.watch.values()) {
      if (rec.fingerprint !== fp || rec.recipientUuid !== parent.uuid) continue;
      if (!match || rec.ts < match.ts) match = rec;
    }
    if (!match) { rememberArrival(item, mode); controller.stats.ignored++; return; }
    if (mode === 'create') {
      match.deliveredQty += qtyOf(d);
      match.landedItemUuid = item.uuid;
    } else {
      match.deliveredQty = Math.max(match.deliveredQty, qtyOf(d) - match.targetPreQty);
      match.landedItemUuid = item.uuid;
    }
    if (match.deliveredQty >= match.expectedQty) {
      clearTimeout(match.timerId);
      settle(match).catch((e) => console.error(TAG, 'settle error:', e));
    }
  };

  const hookOn = (name, fn) => {
    const id = Hooks.on(name, (...args) => {
      try { fn(...args); } catch (err) { console.error(TAG, name, 'hook error:', err); }
    });
    controller.hookIds.push([name, id]);
  };

  // Pre hooks: local to the initiating client - exact intent for this
  // window's own transfers. Post hooks: broadcast to every client by Item
  // Piles' socket, args (source, target, itemDeltas [{item, quantity}],
  // userId, interactionId) with uuids pre-resolved - they are what makes
  // player-initiated loots visible here at all.
  hookOn('item-piles-preTransferItems', (...args) => onPreTransfer(parseIpArgs(args)));
  hookOn('item-piles-preTransferAllItems', (...args) => onPreTransferAll(parseIpArgs(args)));
  hookOn('item-piles-transferItems', (...args) => onPostTransfer(parseIpArgs(args)));
  hookOn('item-piles-transferAllItems', (...args) => onPostTransfer(parseIpArgs(args)));
  hookOn('item-piles-transferEverything', (...args) => onPostTransfer(parseIpArgs(args)));
  hookOn('createItem', (item) => creditDelivery(item, 'create'));
  hookOn('updateItem', (item, changes) => {
    if (changes && changes.system && changes.system.quantity != null) creditDelivery(item, 'update');
  });

  await appendToLog('<hr><h3>Watchdog armed: ' + new Date().toLocaleString() + '</h3>'
    + '<p><em>Scene at arm time: ' + esc((canvas && canvas.scene && canvas.scene.name) || '(none)') + '</em></p>');

  ui.notifications.info(L('Armed'));
  console.log(TAG, 'armed', { rescueLog: rescueLog.name, verifyWindowMs: VERIFY_WINDOW_MS });
}

export const LOOT_MACRO_COMMAND =
  `(${lootWatchdogMain.toString()})().catch((e) => console.error('[foundry-bridge] loot watchdog macro error:', e));`;
