/* Manual Item Piles rescue observer. */

async function lootWatchdogMain() {
  const RESCUE_LOG_UUID = 'JournalEntry.REPLACE_WITH_RESCUE_LOG_JOURNAL_ID';
  const FLAG_SCOPE = 'world';
  const FLAG_KEY = 'aagm-g-loot-rescue';
  const WINDOW_KEY = '__aagmOLootWatchdog';
  const VERIFY_WINDOW_MS = 4000;
  const PAGE_NAME = 'Session Log';
  const TAG = '[AAGM-GLootWatchdog]';
  const L = (k) => game.i18n.localize('AAGM_G.LOOT.' + k);

  if (!game.user.isGM) { /* non GM warns and exits */
    ui.notifications.warn(L('GmOnly'));
    return;
  }
  if (!game.modules.get('item-piles')?.active) { /* Item Piles inactive errors and exits */
    ui.notifications.error(L('NoItemPiles'));
    return;
  }

  /* Repeated runs disarm the watchdog. */
  const prev = window[WINDOW_KEY];
  if (prev && prev.armed) { /* prior watchdog armed disarms and exits */
    for (const [hookName, hookId] of prev.hookIds) Hooks.off(hookName, hookId); /* each hook removed, ends after last */
    for (const rec of prev.watch.values()) clearTimeout(rec.timerId); /* each timer cleared, ends after last */
    prev.watch.clear();
    prev.armed = false;
    ui.notifications.info(L('Disarmed'));
    console.log(TAG, 'disarmed', prev.stats);
    return;
  }

  const rescueLog = await fromUuid(RESCUE_LOG_UUID);
  if (!rescueLog) { /* no rescue log errors and exits */
    ui.notifications.error(L('NoJournal') + ' ' + RESCUE_LOG_UUID);
    return;
  }

  let page = rescueLog.pages.getName(PAGE_NAME);
  if (!page) { /* page missing created, else reused */
    const created = await rescueLog.createEmbeddedDocuments('JournalEntryPage', [{
      name: PAGE_NAME, type: 'text', 'text.content': '<h2>ItemPile Rescue Log</h2>\n',
    }]);
    page = created[0];
  }

  /* Serialize Rescue Log writes. */
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
    if (!stash[bucket]) stash[bucket] = {}; /* bucket missing created, else reused */
    stash[bucket][eventId] = record;
    await rescueLog.setFlag(FLAG_SCOPE, FLAG_KEY, stash);
  });

  /* Reject phantom PF1 equipment. */
  const PHYSICAL_TYPES = new Set(['weapon', 'equipment', 'consumable', 'loot', 'container', 'implant']);
  const classifyItemData = (d) => {
    if (!PHYSICAL_TYPES.has(d.type)) return 'phantom'; /* non physical type returns phantom */
    if (d.type === 'equipment') { /* equipment checks subtype validity */
      const valid = Object.keys((globalThis.pf1 && pf1.config && pf1.config.equipmentTypes) || {});
      const sub = d.system ? d.system.subType : null;
      if (valid.length && !valid.includes(sub)) return 'phantom'; /* invalid subtype returns phantom */
    }
    return 'physical';
  };

  const isLootPile = (actor) => {
    const ip = actor && actor.flags && actor.flags['item-piles'] && actor.flags['item-piles'].data;
    if (!ip || ip.enabled !== true) return false; /* not enabled pile returns false */
    return !['merchant', 'vault', 'auctioneer'].includes(ip.type);
  };
  const isPlayerActor = (actor) => {
    if (!actor) return false;
    for (const [userId, level] of Object.entries(actor.ownership || {})) { /* each owner checked, player owner returns true */
      if (userId === 'default') continue; /* default ownership skipped */
      const u = game.users.get(userId);
      if (u && !u.isGM && level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) return true; /* non GM owner returns true */
    }
    return false;
  };
  const resolveActor = (thing) => {
    if (!thing) return null; /* empty returns null */
    if (thing instanceof Actor) return thing; /* actor returns itself */
    if (thing.actor instanceof Actor) return thing.actor; /* token returns its actor */
    if (typeof thing === 'string') { /* string resolves through UUID */
      try { return resolveActor(fromUuidSync(thing)); } catch { return null; }
    }
    if (thing.documentName === 'Actor') return thing; /* actor document returns itself */
    return null;
  };
  const fingerprint = (d) => [
    d.name, d.type,
    (d.system && d.system.subType) || '',
    (d._stats && d._stats.compendiumSource) || (d.flags && d.flags.core && d.flags.core.sourceId) || '',
    d.img || '',
  ].join('|');
  const qtyOf = (d) => Number((d.system && d.system.quantity) != null ? d.system.quantity : 1) || 1;

  /* Parse Item Piles hook variants. */
  const parseIpArgs = (args) => {
    const actors = [];
    let items = null;
    let userId = null;
    for (const a of args) { /* each hook arg classified, ends after last */
      if (Array.isArray(a)) { if (items === null) items = a; continue; } /* array arg becomes items, once */
      if (typeof a === 'string') { /* string arg is user or actor */
        if (game.users.get(a)) { userId = a; continue; } /* user id captured, next arg */
        const act = resolveActor(a);
        if (act) actors.push(act); /* actor found collected */
        continue;
      }
      const act = resolveActor(a);
      if (act) actors.push(act); /* actor found collected */
    }
    return { source: actors[0] || null, target: actors[1] || null, items: items || [], userId };
  };
  const snapshotFromEntry = (entry, sourceActor) => {
    const raw = entry && entry.item ? entry.item : entry;
    const id = raw && (raw._id || raw.id);
    const live = id && sourceActor ? sourceActor.items.get(id) : null;
    const data = live ? live.toObject(true) : (raw && raw.name ? foundry.utils.deepClone(raw) : null);
    if (!data) return null; /* no data returns null */
    /* Use the transfer magnitude. */
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

  /* Hold arrivals preceding attribution. */
  const recentArrivals = [];
  const rememberArrival = (item, mode) => {
    if (!isPlayerActor(item.parent)) return; /* non player parent returns */
    const d = item.toObject(true);
    recentArrivals.push({
      fingerprint: fingerprint(d), actorUuid: item.parent.uuid,
      itemUuid: item.uuid, qty: qtyOf(d), mode, at: Date.now(),
    });
    const cutoff = Date.now() - VERIFY_WINDOW_MS * 2;
    while (recentArrivals.length && recentArrivals[0].at < cutoff) recentArrivals.shift(); /* expired arrivals dropped, ends when fresh */
  };

  const newEventId = () => 'lw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  async function settle(rec) {
    controller.watch.delete(rec.eventId);
    const shortfall = Math.max(0, rec.expectedQty - rec.deliveredQty);
    const stamp = new Date(rec.ts).toLocaleTimeString();

    if (rec.kind === 'phantom') { /* phantom record stashed, then returns */
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
        speaker: { alias: 'AAGM-G Loot Watchdog' },
      });
      await appendToLog('<div style="border-left:4px solid #c80; padding-left:8px; margin:8px 0;">'
        + '<p><strong>PHANTOM (' + esc(outcome) + ')</strong> ' + stamp + ' : ' + esc(rec.itemData.name)
        + ' from <em>' + esc(rec.pileName) + '</em> looted by <em>' + esc(rec.looterName || '?') + '</em>'
        + ' for <em>' + esc(rec.recipientName || '?') + '</em> (event <code>' + esc(rec.eventId) + '</code>)</p></div>');
      return;
    }

    if (shortfall === 0) { /* full delivery logs OK, then returns */
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
        + '<em>Queued for Grok auto-restore. Event ' + esc(rec.eventId) + '</em></div>',
      whisper: ChatMessage.getWhisperRecipients('GM'),
      speaker: { alias: 'AAGM-G Loot Watchdog' },
    });
    await appendToLog('<div style="border-left:4px solid #c00; padding-left:8px; margin:8px 0;">'
      + '<p><strong>VANISH</strong> ' + stamp + ' : <strong>' + esc(rec.itemData.name) + '</strong> x ' + shortfall
      + ' from <em>' + esc(rec.pileName) + '</em> owed to <em>' + esc(rec.recipientName || '?') + '</em>'
      + ' (looted by ' + esc(rec.looterName || '?') + ', event <code>' + esc(rec.eventId) + '</code>)</p>'
      + '<details><summary>Full item data</summary><pre>' + esc(JSON.stringify(rec.itemData, null, 2)) + '</pre></details></div>');
  }

  function track(source, target, entry, userId, via) {
    const snap = snapshotFromEntry(entry, source);
    if (!snap) return; /* no snapshot returns, else tracks */
    const fp = fingerprint(snap.data);

    /* Merge duplicate hook records. */
    for (const open of controller.watch.values()) { /* each open record checked, duplicate returns */
      if (open.fingerprint === fp && open.pileUuid === source.uuid && open.recipientUuid === target.uuid) { /* same item, pile, recipient counts duplicate */
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
      if (controller.watch.has(rec.eventId)) { /* still watched settles, else skipped */
        settle(rec).catch((e) => console.error(TAG, 'settle error:', e));
      }
    }, VERIFY_WINDOW_MS);
    controller.watch.set(rec.eventId, rec);
    controller.stats.tracked++;
    console.log(TAG, 'tracking', rec.kind + ':', snap.data.name, 'x' + snap.qty, '->', target.name, 'via', rec.via);

    /* Credit pre-attribution deliveries. */
    for (const a of recentArrivals) { /* each recent arrival checked, ends after last */
      if (!a.at || a.fingerprint !== fp || a.actorUuid !== rec.recipientUuid) continue; /* unmatched arrival skipped */
      /* Count merged stacks conservatively. */
      rec.deliveredQty += (a.mode === 'create') ? a.qty : rec.expectedQty;
      rec.landedItemUuid = a.itemUuid;
      a.at = 0; /* one arrival credits one record */
    }
    if (rec.deliveredQty >= rec.expectedQty) { /* fully delivered settles early */
      clearTimeout(rec.timerId);
      settle(rec).catch((e) => console.error(TAG, 'settle error:', e));
    }
  }

  function onPreTransfer({ source, target, items, userId }) {
    if (!source || !target || !isLootPile(source) || !isPlayerActor(target)) return; /* non pile or non player returns */
    for (const entry of items) track(source, target, entry, userId); /* each entry tracked, ends after last */
  }

  function onPreTransferAll({ source, target, userId }) {
    if (!source || !target || !isLootPile(source) || !isPlayerActor(target)) return; /* non pile or non player returns */
    for (const item of source.items) { /* each pile item tracked, ends after last */
      const d = item.toObject(true);
      if (classifyItemData(d) === 'phantom' && !PHYSICAL_TYPES.has(d.type)) continue; /* non physical phantom skipped */
      track(source, target, d, userId);
    }
  }

  function onPostTransfer({ source, target, items, userId }) {
    if (!source || !target || !isLootPile(source) || !isPlayerActor(target)) return; /* non pile or non player returns */
    for (const entry of items) track(source, target, entry, userId, 'post'); /* each entry tracked post, ends after last */
  }

  const creditDelivery = (item, mode) => {
    const parent = item.parent;
    if (!(parent instanceof Actor)) return; /* non actor parent returns */
    const d = item.toObject(true);
    const fp = fingerprint(d);
    let match = null;
    for (const rec of controller.watch.values()) { /* each open record scanned, ends after last */
      if (rec.fingerprint !== fp || rec.recipientUuid !== parent.uuid) continue; /* mismatch skipped */
      if (!match || rec.ts < match.ts) match = rec; /* keeps oldest matching record */
    }
    if (!match) { rememberArrival(item, mode); controller.stats.ignored++; return; } /* no match remembers arrival, returns */
    if (mode === 'create') { /* create adds quantity, else update */
      match.deliveredQty += qtyOf(d);
      match.landedItemUuid = item.uuid;
    } else { /* update raises delivered to difference */
      match.deliveredQty = Math.max(match.deliveredQty, qtyOf(d) - match.targetPreQty);
      match.landedItemUuid = item.uuid;
    }
    if (match.deliveredQty >= match.expectedQty) { /* fully delivered settles now */
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

  /* Observe local and broadcast transfers. */
  hookOn('item-piles-preTransferItems', (...args) => onPreTransfer(parseIpArgs(args)));
  hookOn('item-piles-preTransferAllItems', (...args) => onPreTransferAll(parseIpArgs(args)));
  hookOn('item-piles-transferItems', (...args) => onPostTransfer(parseIpArgs(args)));
  hookOn('item-piles-transferAllItems', (...args) => onPostTransfer(parseIpArgs(args)));
  hookOn('item-piles-transferEverything', (...args) => onPostTransfer(parseIpArgs(args)));
  hookOn('createItem', (item) => creditDelivery(item, 'create'));
  hookOn('updateItem', (item, changes) => {
    if (changes && changes.system && changes.system.quantity != null) creditDelivery(item, 'update'); /* quantity change credits delivery */
  });

  await appendToLog('<hr><h3>Watchdog armed: ' + new Date().toLocaleString() + '</h3>'
    + '<p><em>Scene at arm time: ' + esc((canvas && canvas.scene && canvas.scene.name) || '(none)') + '</em></p>');

  ui.notifications.info(L('Armed'));
  console.log(TAG, 'armed', { rescueLog: rescueLog.name, verifyWindowMs: VERIFY_WINDOW_MS });
}

export const LOOT_MACRO_COMMAND =
  `(${lootWatchdogMain.toString()})().catch((e) => console.error('[aagm-g] loot watchdog macro error:', e));`;
