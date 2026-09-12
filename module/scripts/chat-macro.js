// Auto-created "Open Claude Code Chat" macro source.
//
// The chat box is a Dialog, NOT a module Application class: the bridge module
// still ships no GUI surface of its own (CLAUDE.md, relaxed for Phase 2). We
// author it as a real function and serialize it with Function.prototype
// .toString() so its own template literals / ${} don't need hand-escaping.
// Safe because there is no build/minify step (locked decision 7).
//
// chatBoxMain must stay self-contained: it may reference only runtime globals
// (game, ui, Dialog, document, window, console, set/clearInterval) and the
// module's public API at game.modules.get('foundry-bridge').api. No closures
// over this file's scope survive .toString().

async function chatBoxMain() {
  const MODULE_ID = 'foundry-bridge';
  const STYLE_ID = 'ccc-claude-code-chat-theme';
  const LAYOUT_ID = 'ccc-claude-code-chat-layout';
  const L = (k) => game.i18n.localize('FOUNDRY_BRIDGE.CHAT.' + k);
  // §14 tabs: bar shows only with multitasking on; one tab = one task.
  const TABS_ON = !!game.settings.get(MODULE_ID, 'multitasking');
  const TAB_MAX = 5; /* real estate; keeps the flash legible */
  const TAB_TITLE_LEN = 24;
  const MAIN_TAB = 't-main'; /* tabs off = this single tab */

  // Style loader, per Foundry JS/Stylesfolderhowto: prefer the "VTT Macro
  // Styles" journal, fall back to inline CSS if it can't be read.
  async function injectMacroStyles(styleId, pageName, fallbackCSS) {
    if (document.getElementById(styleId)) return;
    let css = fallbackCSS || '';
    try {
      const journal = game.journal.getName('VTT Macro Styles');
      const page = journal?.pages?.getName(pageName);
      if (page) {
        const div = document.createElement('div');
        div.innerHTML = page.text?.content || '';
        const raw = div.textContent?.trim();
        if (raw) css = raw;
      }
    } catch (e) { /* fallback silently takes over */ }
    if (!css) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Dark Theme fallback if the journal is gone.
  const FALLBACK_CSS = `
    .forge-dialog-dark { background:#1a1a1a; color:#e0e0e0; }
    .forge-dialog-dark .section { background:#2a2a2a; border:1px solid #00ffcc; padding:8px; border-radius:4px; }
    .forge-dialog-dark label, .forge-dialog-dark .section-title { color:#00ffcc; }
    .forge-dialog-dark .warning { color:#ffaa00; }
  `;

  await injectMacroStyles(STYLE_ID, 'Dark Theme', FALLBACK_CSS);

  // Chat-only layout, ccc- prefixed, out of shared theme.
  // Typed text forced pure white (DatJavaClass's instruction).
  if (!document.getElementById(LAYOUT_ID)) {
    const s = document.createElement('style');
    s.id = LAYOUT_ID;
    // Explicit heights; flex:1 collapses in Foundry Dialogs.
    s.textContent = `
      .ccc-wrap { display:flex; flex-direction:column; gap:8px; }
      .ccc-status { font-size:12px; padding:5px 8px; border-radius:3px; border:1px solid #00ffcc; }
      .ccc-status.ready { color:#00ffcc; border-color:#00ffcc; }
      .ccc-status.warn  { color:#ffaa00; border-color:#ffaa00; }
      .ccc-tabs { display:flex; gap:4px; margin-bottom:-8px; }
      .ccc-tab { flex:0 1 auto; min-width:0; max-width:150px; display:flex; align-items:center; gap:6px;
                 padding:4px 8px; background:#222; border:1px solid #444; border-bottom:none;
                 border-radius:4px 4px 0 0; color:#bbb; cursor:pointer; font-size:12px; }
      .ccc-tab::before { content:''; width:7px; height:7px; border-radius:50%; background:#555; flex:none; }
      .ccc-tab.ccc-active { background:#2a2a2a; border-color:#00ffcc; color:#e0e0e0; }
      .ccc-tab.ccc-working::before { background:#00ffcc; }
      .ccc-tab.ccc-done::before { background:#3a7; }
      .ccc-tab.ccc-gated { border-color:#ffaa00; animation:ccc-pulse 1s ease-in-out infinite; }
      .ccc-tab.ccc-gated::before { background:#ffaa00; }
      @keyframes ccc-pulse { 0%,100% { background:#241f12; } 50% { background:#5a4410; } }
      .ccc-tab-t { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .ccc-tab-x { opacity:0.6; padding:0 2px; flex:none; }
      .ccc-tab-x:hover { opacity:1; color:#ff6666; }
      .ccc-tab-add { flex:none; padding:4px 9px; background:#222; border:1px solid #444; border-bottom:none;
                     border-radius:4px 4px 0 0; color:#00ffcc; cursor:pointer; font-weight:600; }
      .ccc-tab-add:disabled { opacity:0.35; cursor:default; }
      .ccc-log { height:320px; width:100%; box-sizing:border-box; overflow-y:auto;
                 background:#141414; border:1px solid #333; border-radius:4px; padding:8px;
                 display:flex; flex-direction:column; gap:6px; }
      .ccc-log[hidden] { display:none; }
      .ccc-msg { white-space:pre-wrap; word-break:break-word; padding:6px 8px;
                 border-radius:6px; font-size:13px; line-height:1.4; }
      .ccc-msg .ccc-who { display:block; font-size:11px; opacity:0.75; margin-bottom:2px; }
      .ccc-user   { background:#22323a; border-left:3px solid #00ffcc; align-self:flex-end; max-width:85%; }
      .ccc-claude { background:#2a2a2a; border-left:3px solid #ffaa00; align-self:flex-start; max-width:85%; }
      .ccc-sys    { color:#ffaa00; font-size:12px; align-self:center; }
      .ccc-input { display:block; width:100% !important; box-sizing:border-box !important;
                   height:96px; resize:vertical; color:#fff !important; background:#101010;
                   border:1px solid #00ffcc; border-radius:4px; padding:8px;
                   font-family:inherit; font-size:13px; }
      .ccc-input::placeholder { color:#888; }
      .ccc-input.ccc-drop { border-color:#ffaa00; box-shadow:0 0 6px rgba(255,170,0,0.4); }
      .ccc-send { display:block; width:100%; box-sizing:border-box; padding:9px 0;
                  background:#00ffcc; color:#0a0a0a; border:none; border-radius:4px;
                  cursor:pointer; font-weight:600; font-size:14px; }
      .ccc-send:hover { background:#33ffd6; }
      .ccc-confirm { align-self:stretch; max-width:100%; background:#241f12;
                     border:1px solid #ffaa00; border-radius:6px; padding:8px; }
      .ccc-confirm.ccc-double { border-color:#ff6666; background:#2a1414; }
      .ccc-cf-h { color:#ffaa00; font-weight:600; font-size:12px; margin-bottom:4px; }
      .ccc-confirm.ccc-double .ccc-cf-h { color:#ff6666; }
      .ccc-cf-sum { font-size:13px; margin-bottom:6px; white-space:pre-wrap; }
      .ccc-cf-code { max-height:160px; overflow:auto; background:#0c0c0c;
                     border:1px solid #333; border-radius:4px; padding:6px;
                     font-family:monospace; font-size:12px; white-space:pre; color:#cfe; }
      .ccc-cf-tbl { width:100%; font-size:12px; border-collapse:collapse; margin-top:4px; }
      .ccc-cf-tbl td, .ccc-cf-tbl th { border-bottom:1px solid #333; padding:2px 6px; text-align:left; }
      .ccc-cf-row { display:flex; gap:8px; margin-top:8px; }
      .ccc-cf-btn { flex:1; padding:7px 0; border:none; border-radius:4px;
                    cursor:pointer; font-weight:600; }
      .ccc-cf-approve { background:#00ffcc; color:#0a0a0a; }
      .ccc-cf-approve:hover { background:#33ffd6; }
      .ccc-cf-deny { background:#552222; color:#ffdddd; }
      .ccc-cf-deny:hover { background:#773333; }
      .ccc-cf-done { font-size:12px; margin-top:6px; opacity:0.85; }
    `;
    document.head.appendChild(s);
  }

  const api = game.modules.get(MODULE_ID)?.api;
  if (!api || typeof api.isConnected !== 'function' || !api.isConnected()) {
    new Dialog({
      title: L('Title'),
      content: `<div class="forge-dialog-dark"><p class="warning">${L('NotConnected')}</p></div>`,
      buttons: { ok: { label: L('Close') } },
      default: 'ok',
    }).render(true);
    return;
  }

  const content = `
    <div class="forge-dialog-dark ccc-wrap" data-ccc="wrap">
      <div class="ccc-status warn" data-ccc="status">${L('StatusNoListener')}</div>
      <div class="ccc-tabs" data-ccc="tabs"${TABS_ON ? '' : ' style="display:none"'}></div>
      <div class="ccc-logs" data-ccc="logs"></div>
      <textarea class="ccc-input" data-ccc="input" placeholder="${L('Placeholder')}"></textarea>
      <button type="button" class="ccc-send" data-ccc="send">${L('Send')}</button>
    </div>`;

  let root = null;
  const $el = (k) => root?.querySelector(`[data-ccc="${k}"]`);

  // §14 tab table, box side. Relay owns truth; claude.tabs resyncs us.
  const tabs = new Map(); /* id -> { id, title, state, log, sent } */
  let activeId = null;
  const newId = () => 't-' + Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  const logFor = (tabId) => (TABS_ON && tabs.get(tabId)?.log) || tabs.get(activeId)?.log || null;

  const renderBar = () => {
    const bar = $el('tabs');
    if (!bar) return;
    bar.textContent = '';
    for (const t of tabs.values()) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ccc-tab ccc-' + (t.state || 'idle') + (t.id === activeId ? ' ccc-active' : '');
      b.dataset.tab = t.id;
      const title = document.createElement('span');
      title.className = 'ccc-tab-t';
      title.textContent = t.title;
      title.title = t.title;
      b.appendChild(title);
      const x = document.createElement('span');
      x.className = 'ccc-tab-x';
      x.dataset.close = t.id;
      x.textContent = '×';
      x.title = L('TabClose');
      b.appendChild(x);
      bar.appendChild(b);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'ccc-tab-add';
    add.dataset.ccc = 'tabadd';
    add.textContent = '+';
    add.title = L('TabAdd');
    add.disabled = tabs.size >= TAB_MAX;
    bar.appendChild(add);
  };

  const activate = (id) => {
    if (!tabs.has(id)) return;
    activeId = id;
    for (const t of tabs.values()) t.log.hidden = t.id !== id;
    renderBar();
    const log = tabs.get(id).log;
    log.scrollTop = log.scrollHeight;
  };

  const mintTab = (id, title, state) => {
    const log = document.createElement('div');
    log.className = 'ccc-log';
    log.hidden = true;
    $el('logs')?.appendChild(log);
    const t = { id, title, state: state || 'idle', log, sent: false };
    tabs.set(id, t);
    return t;
  };

  const addTab = () => {
    if (tabs.size >= TAB_MAX) return null;
    const t = mintTab(newId(), L('TabNew'), 'idle');
    activate(t.id);
    setTimeout(() => $el('input')?.focus(), 0);
    return t;
  };

  const closeTab = (id) => {
    const t = tabs.get(id);
    if (!t) return;
    tabs.delete(id);
    t.log.remove();
    if (t.sent) { try { api.closeTab(id); } catch (e) {} } /* relay never saw a pristine tab */
    if (activeId === id) {
      const next = tabs.keys().next().value;
      if (next) activate(next); else addTab();
    } else renderBar();
  };

  const addMsg = (role, text, tabId) => {
    const log = logFor(tabId);
    if (!log) return;
    const msg = document.createElement('div');
    msg.className = 'ccc-msg ccc-' + role;
    if (role === 'user' || role === 'claude') {
      const who = document.createElement('span');
      who.className = 'ccc-who';
      who.textContent = role === 'user' ? L('You') : L('Claude');
      msg.appendChild(who);
    }
    const body = document.createElement('span');
    body.textContent = text;            // textContent: no HTML injection, newlines kept by CSS
    msg.appendChild(body);
    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
  };

  // Relay table in: new ids rebuild from transcript (reload), known ids
  // just take title/state, sent-but-missing ids were closed or reset.
  const syncTabs = (list) => {
    if (!Array.isArray(list)) return;
    const seen = new Set();
    for (const r of list) {
      if (!r?.id || (!TABS_ON && r.id !== MAIN_TAB)) continue;
      seen.add(r.id);
      let t = tabs.get(r.id);
      if (!t) {
        t = mintTab(r.id, r.title || r.id, r.state);
        for (const line of r.transcript || []) addMsg(line.role, line.text, r.id);
      }
      t.title = r.title || t.title;
      t.state = r.state || 'idle';
      t.sent = true;
    }
    for (const t of [...tabs.values()]) {
      if (seen.has(t.id)) continue;
      const pristine = !t.sent && !t.log.childElementCount;
      if (t.sent || (pristine && seen.size)) { tabs.delete(t.id); t.log.remove(); }
    }
    if (!tabs.size) addTab();
    else if (!tabs.has(activeId)) activate(tabs.keys().next().value);
    else renderBar();
  };

  const setStatus = (state) => {
    const bar = $el('status');
    if (!bar) return;
    const ready = state === 'ready';
    bar.className = 'ccc-status ' + (ready ? 'ready' : 'warn');
    bar.textContent = ready ? L('StatusReady')
      : state === 'disconnected' ? L('StatusDisconnected')
      : L('StatusNoListener');
  };

  // DESIGN §9 confirmation gate. Renders a card with the summary + the exact
  // code (eval) or HP preview (damage) and Approve/Deny. level "double"
  // (deletes) requires a distinct second approval. Decision → api.sendConfirmResult.
  // §14: the card lands in its tab; the relay flips that tab to gated.
  const renderConfirm = (p) => {
    const log = logFor(p?.tabId);
    if (!log || !p || !p.opId) return;
    if (log.querySelector(`[data-op="${p.opId}"]`)) return; /* hello re-sends live cards */
    const card = document.createElement('div');
    card.className = 'ccc-msg ccc-confirm' + (p.level === 'double' ? ' ccc-double' : '');
    card.dataset.op = p.opId;

    const h = document.createElement('div');
    h.className = 'ccc-cf-h';
    h.textContent = (p.level === 'double' ? L('ConfirmDestructive') : L('ConfirmWrite')) + ' - ' + (p.kind || 'op');
    card.appendChild(h);

    const sum = document.createElement('div');
    sum.className = 'ccc-cf-sum';
    sum.textContent = p.summary || '(no summary provided)';
    card.appendChild(sum);

    if (p.code) {
      const pre = document.createElement('pre');
      pre.className = 'ccc-cf-code';
      pre.textContent = p.code;
      card.appendChild(pre);
    }
    if (Array.isArray(p.preview) && p.preview.length) {
      const tbl = document.createElement('table');
      tbl.className = 'ccc-cf-tbl';
      const hr = document.createElement('tr');
      ['Target', 'HP', '→'].forEach((c) => { const th = document.createElement('th'); th.textContent = c; hr.appendChild(th); });
      tbl.appendChild(hr);
      for (const row of p.preview) {
        const tr = document.createElement('tr');
        [row.name, String(row.before), '→ ' + String(row.after)].forEach((v) => {
          const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
        });
        tbl.appendChild(tr);
      }
      card.appendChild(tbl);
    }

    let resolved = false;
    const finish = (approved, reason, msgKey) => {
      if (resolved) return;
      resolved = true;
      try { api.sendConfirmResult(p.opId, approved, reason); } catch (e) {}
      card.querySelector('.ccc-cf-row')?.remove();
      const done = document.createElement('div');
      done.className = 'ccc-cf-done';
      done.textContent = L(msgKey);
      card.appendChild(done);
      log.scrollTop = log.scrollHeight;
    };
    const buildRow = (okLabel, onOk, noLabel, onNo) => {
      const row = document.createElement('div');
      row.className = 'ccc-cf-row';
      const ok = document.createElement('button');
      ok.type = 'button'; ok.className = 'ccc-cf-btn ccc-cf-approve'; ok.textContent = okLabel;
      ok.addEventListener('click', onOk);
      const no = document.createElement('button');
      no.type = 'button'; no.className = 'ccc-cf-btn ccc-cf-deny'; no.textContent = noLabel;
      no.addEventListener('click', onNo);
      row.appendChild(ok); row.appendChild(no);
      return row;
    };

    card.appendChild(buildRow(
      L('Approve'),
      () => {
        if (p.level === 'double') {
          card.querySelector('.ccc-cf-row')?.remove();
          const warn = document.createElement('div');
          warn.className = 'ccc-cf-h';
          warn.textContent = L('ConfirmAgain');
          card.appendChild(warn);
          card.appendChild(buildRow(
            L('ApproveFinal'), () => finish(true, 'approved-double', 'Approved'),
            L('Cancel'), () => finish(false, 'cancelled', 'Denied'),
          ));
          log.scrollTop = log.scrollHeight;
        } else {
          finish(true, 'approved', 'Approved');
        }
      },
      L('Deny'),
      () => finish(false, 'denied', 'Denied'),
    ));

    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
  };

  // Drag-and-drop capture: dropping a document (actor, item, journal, ...)
  // from a sidebar, compendium, or open sheet inserts a @UUID reference at the
  // cursor instead of the browser's default raw-JSON text paste. Non-document
  // drags (no uuid in the payload) fall through to default behavior.
  // v12-specific surfaces: the TextEditor and fromUuidSync globals (v13 moves
  // TextEditor under foundry.applications.ux).
  const insertRef = (ta, ref) => {
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const before = ta.value.slice(0, start);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    ta.value = before + pad + ref + ' ' + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = (before + pad + ref + ' ').length;
    ta.focus();
  };
  const onDrop = (ev) => {
    let data = null;
    try { data = TextEditor.getDragEventData(ev); } catch (e) { return; }
    if (!data?.uuid) return;
    ev.preventDefault();
    const ta = $el('input');
    if (!ta) return;
    let name = null;
    try { name = fromUuidSync(data.uuid)?.name || null; } catch (e) { /* uuid alone still resolves on Claude's side */ }
    insertRef(ta, name ? `@UUID[${data.uuid}]{${name}}` : `@UUID[${data.uuid}]`);
  };

  const submit = () => {
    const ta = $el('input');
    const text = (ta?.value || '').trim();
    const t = tabs.get(activeId);
    if (!text || !t) return;
    const id = api.sendPrompt(text, t.id);
    if (!id) { addMsg('sys', L('StatusDisconnected')); setStatus('disconnected'); return; }
    if (!t.sent) { t.title = text.slice(0, TAB_TITLE_LEN); t.state = 'working'; } /* relay will agree */
    t.sent = true;
    addMsg('user', text, t.id);
    renderBar();
    ta.value = '';
    ta.focus();
  };

  // §13.3 Chain Mode progress: one reusable card - grant creates it, each
  // gate updates it, end freezes it. Cancel button rides the card while live.
  let chainCard = null;
  const onChain = (p) => {
    const log = logFor(p?.tabId);
    if (!log || !p) return;
    if (p.event === 'grant') {
      chainCard = document.createElement('div');
      chainCard.className = 'ccc-msg ccc-confirm';
      const h = document.createElement('div');
      h.className = 'ccc-cf-h';
      h.textContent = L('ChainActive');
      chainCard.appendChild(h);
      const prog = document.createElement('div');
      prog.className = 'ccc-cf-sum';
      prog.dataset.ccc = 'chainprog';
      prog.textContent = `0/${p.count} - ${p.text || ''}`;
      chainCard.appendChild(prog);
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'ccc-cf-btn ccc-cf-deny';
      cancel.textContent = L('ChainCancel');
      cancel.addEventListener('click', () => { try { api.cancelChain(p.chainId); } catch (e) {} });
      chainCard.appendChild(cancel);
      log.appendChild(chainCard);
      log.scrollTop = log.scrollHeight;
    } else if (p.event === 'gate' && chainCard) {
      const prog = chainCard.querySelector('[data-ccc="chainprog"]');
      if (prog) prog.textContent = `${p.n}/${p.count} - ${p.text || ''}`;
      log.scrollTop = log.scrollHeight;
    } else if (p.event === 'end') {
      chainCard?.querySelector('button')?.remove();
      chainCard = null;
      addMsg('sys', `${L('ChainEnded')} ${p.n}/${p.count} (${p.text || ''})`, p.tabId);
    }
  };

  // Subscribe to relay pushes once, before the dialog opens; tear down on close.
  const unsubReply = api.onReply((p) => addMsg('claude', p?.text ?? '', p?.tabId));
  const unsubStatus = api.onStatus((p) => setStatus(p?.state || 'no-listener'));
  const unsubConfirm = api.onConfirm((p) => renderConfirm(p || {}));
  const unsubChain = api.onChain ? api.onChain(onChain) : null;
  const unsubTabs = api.onTabs ? api.onTabs((p) => syncTabs(p?.tabs)) : null;
  let poll = null;
  let wasConnected = true;

  const dlg = new Dialog({
    title: L('Title'),
    content,
    buttons: { close: { label: L('Close') } },
    default: 'close',
    render: (html) => {
      root = (html && html[0]) ? html[0] : html;
      $el('send')?.addEventListener('click', submit);
      const ta = $el('input');
      ta?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submit(); }
      });
      // Tab bar: one delegated listener; close beats select.
      $el('tabs')?.addEventListener('click', (ev) => {
        const x = ev.target.closest?.('[data-close]');
        if (x) { ev.stopPropagation(); closeTab(x.dataset.close); return; }
        if (ev.target.closest?.('[data-ccc="tabadd"]')) { addTab(); return; }
        const b = ev.target.closest?.('[data-tab]');
        if (b) activate(b.dataset.tab);
      });
      if (TABS_ON) addTab(); else activate(mintTab(MAIN_TAB, L('Title'), 'idle').id);
      // Whole box is the drop zone (forgiving aim); the input highlights as
      // the landing spot. Depth counter because child enter/leave pairs bubble.
      const wrap = $el('wrap');
      let dragDepth = 0;
      const undrop = () => { dragDepth = 0; $el('input')?.classList.remove('ccc-drop'); };
      wrap?.addEventListener('dragenter', (ev) => { ev.preventDefault(); dragDepth++; $el('input')?.classList.add('ccc-drop'); });
      wrap?.addEventListener('dragleave', () => { dragDepth--; if (dragDepth <= 0) undrop(); });
      wrap?.addEventListener('dragover', (ev) => ev.preventDefault());
      wrap?.addEventListener('drop', (ev) => { undrop(); onDrop(ev); });
      setStatus(api.isConnected() ? 'no-listener' : 'disconnected');
      api.requestStatus(); /* relay answers with status + tab table + live cards */
      poll = setInterval(() => {
        const c = api.isConnected();
        if (!c) setStatus('disconnected');
        else if (!wasConnected) { api.requestStatus(); }   // reconnected: refresh
        wasConnected = c;
      }, 3000);
      setTimeout(() => $el('input')?.focus(), 50);
    },
    close: () => {
      try { unsubReply?.(); } catch (e) {}
      try { unsubStatus?.(); } catch (e) {}
      try { unsubConfirm?.(); } catch (e) {}
      try { unsubChain?.(); } catch (e) {}
      try { unsubTabs?.(); } catch (e) {}
      if (poll) { clearInterval(poll); poll = null; }
    },
  }, { width: 560, resizable: false, classes: ['ccc-dialog'] });

  dlg.render(true);
}

export const CHAT_MACRO_COMMAND =
  `(${chatBoxMain.toString()})().catch((e) => console.error('[foundry-bridge] chat macro error:', e));`;
