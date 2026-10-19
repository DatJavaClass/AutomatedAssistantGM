/* Chat macro source, serialized via toString. */

async function chatBoxMain() {
  const MODULE_ID = 'aagm-o'; /* module id */
  const STYLE_ID = 'aagmo-chat-theme'; /* chat theme style id */
  const LAYOUT_ID = 'aagmo-chat-layout'; /* chat layout style id */
  const L = (k) => game.i18n.localize('AAGM_O.CHAT.' + k); /* localizer by key */
  const TABS_ON = game.settings.get(MODULE_ID, 'multitasking'); /* multitasking setting flag */
  const MAIN_TAB = 't-main', TAB_MAX = 5, TAB_TITLE_LEN = 24; /* main tab id, caps */

  /* Prefer journal styles over fallback CSS. */
  async function injectMacroStyles(styleId, pageName, fallbackCSS) {
    if (document.getElementById(styleId)) return; /* style present returns, else injects */
    let css = fallbackCSS || '';
    try {
      const journal = game.journal.getName('VTT Macro Styles');
      const page = journal?.pages?.getName(pageName);
      if (page) { /* page found overrides fallback css */
        const div = document.createElement('div');
        div.innerHTML = page.text?.content || '';
        const raw = div.textContent?.trim();
        if (raw) css = raw; /* text present overrides css */
      }
    } catch { /* fallback silently takes over */ }
    if (!css) return; /* no css returns, else appends */
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* Provide a minimal dark fallback. */
  const FALLBACK_CSS = `
    .forge-dialog-dark { background:#1a1a1a; color:#e0e0e0; }
    .forge-dialog-dark .section { background:#2a2a2a; border:1px solid #00ffcc; padding:8px; border-radius:4px; }
    .forge-dialog-dark label, .forge-dialog-dark .section-title { color:#00ffcc; }
    .forge-dialog-dark .warning { color:#ffaa00; }
  `;

  await injectMacroStyles(STYLE_ID, 'Dark Theme', FALLBACK_CSS);

  /* Apply the chat layout. */
  if (!document.getElementById(LAYOUT_ID)) { /* layout absent injects, else skipped */
    const s = document.createElement('style');
    s.id = LAYOUT_ID;
    /* Fixed height prevents Foundry flex collapse. */
    s.textContent = `
      .aagmo-wrap { display:flex; flex-direction:column; gap:8px; }
      .aagmo-status { font-size:12px; padding:5px 8px; border-radius:3px; border:1px solid #00ffcc; }
      .aagmo-status.ready { color:#00ffcc; border-color:#00ffcc; }
      .aagmo-status.warn  { color:#ffaa00; border-color:#ffaa00; }
      .aagmo-tabs { display:flex; align-items:stretch; gap:2px; min-height:28px; overflow-x:auto; }
      .aagmo-tab { width:auto; height:auto; line-height:1.2; flex:1 1 0; min-width:0; display:flex;
                   align-items:center; gap:4px; padding:4px 6px; background:#222; color:#bbb;
                   border:1px solid #444; border-bottom:none; border-radius:4px 4px 0 0; cursor:pointer; }
      .aagmo-tab.aagmo-active { background:#141414; color:#fff; border-color:#00ffcc; }
      .aagmo-tab::before { content:''; flex:none; width:6px; height:6px; border-radius:50%; background:#777; }
      .aagmo-tab.aagmo-working::before { background:#00ffcc; }
      .aagmo-tab.aagmo-done::before { background:#66cc66; }
      .aagmo-tab-t { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .aagmo-tab-x { opacity:0.6; padding:0 2px; flex:none; }
      .aagmo-tab-x:hover { opacity:1; color:#ff6666; }
      .aagmo-tab-add { width:auto; height:auto; line-height:1.2; flex:none; padding:4px 9px;
                       background:#222; border:1px solid #444; border-bottom:none;
                       border-radius:4px 4px 0 0; color:#00ffcc; cursor:pointer; font-weight:600; }
      .aagmo-tab-add:disabled { opacity:0.35; cursor:default; }
      .aagmo-log { height:320px; width:100%; box-sizing:border-box; overflow-y:auto;
                 background:#141414; border:1px solid #333; border-radius:4px; padding:8px;
                 display:flex; flex-direction:column; gap:6px; }
      .aagmo-log[hidden] { display:none; }
      .aagmo-msg { white-space:pre-wrap; word-break:break-word; padding:6px 8px;
                 border-radius:6px; font-size:13px; line-height:1.4; }
      .aagmo-msg .aagmo-who { display:block; font-size:11px; opacity:0.75; margin-bottom:2px; }
      .aagmo-user { background:#22323a; border-left:3px solid #00ffcc; align-self:flex-end; max-width:85%; }
      .aagmo-assistant { background:#2a2a2a; border-left:3px solid #ffaa00; align-self:flex-start; max-width:85%; }
      .aagmo-sys { color:#ffaa00; font-size:12px; align-self:center; }
      .aagmo-input { display:block; width:100% !important; box-sizing:border-box !important;
                   height:96px; resize:vertical; color:#fff !important; background:#101010;
                   border:1px solid #00ffcc; border-radius:4px; padding:8px;
                   font-family:inherit; font-size:13px; }
      .aagmo-input::placeholder { color:#888; }
      .aagmo-input.aagmo-drop { border-color:#ffaa00; box-shadow:0 0 6px rgba(255,170,0,0.4); }
      .aagmo-send { display:block; width:100%; box-sizing:border-box; padding:9px 0;
                  background:#00ffcc; color:#0a0a0a; border:none; border-radius:4px;
                  cursor:pointer; font-weight:600; font-size:14px; }
      .aagmo-send:hover { background:#33ffd6; }
      .aagmo-rollback { align-self:stretch; max-width:100%; background:#241f12;
                     border:1px solid #ffaa00; border-radius:6px; padding:8px; }
      .aagmo-cf-h { color:#ffaa00; font-weight:600; font-size:12px; margin-bottom:4px; }
      .aagmo-cf-sum { font-size:13px; margin-bottom:6px; white-space:pre-wrap; }
      .aagmo-cf-row { display:flex; gap:8px; margin-top:8px; }
      .aagmo-cf-btn { flex:1; padding:7px 0; border:none; border-radius:4px;
                    cursor:pointer; font-weight:600; }
      .aagmo-cf-action { background:#00ffcc; color:#0a0a0a; }
      .aagmo-cf-action:hover { background:#33ffd6; }
      .aagmo-cf-action:disabled { opacity:0.5; cursor:default; }
      .aagmo-rp-cap { font-size:11px; opacity:0.75; margin-bottom:4px; }
      .aagmo-rp-docs { font-size:11px; opacity:0.85; }
      .aagmo-rp-docs summary { cursor:pointer; }
      .aagmo-rp-docs ul { margin:2px 0 0 16px; padding:0; }
      .aagmo-rp-done { font-size:12px; color:#ffaa00; margin-top:6px; }
    `;
    document.head.appendChild(s);
  }

  const api = game.modules.get(MODULE_ID)?.api;
  if (!api || typeof api.isConnected !== 'function' || !api.isConnected()) { /* no api or offline warns, returns */
    new Dialog({
      title: L('Title'),
      content: `<div class="forge-dialog-dark"><p class="warning">${L('NotConnected')}</p></div>`,
      buttons: { ok: { label: L('Close') } },
      default: 'ok',
    }).render(true);
    return;
  }

  const content = `
    <div class="forge-dialog-dark aagmo-wrap" data-aagmo="wrap">
      <div class="aagmo-status warn" data-aagmo="status">${L('StatusNoListener')}</div>
      <div class="aagmo-tabs" data-aagmo="tabs"${TABS_ON ? '' : ' style="display:none"'}></div>
      <div class="aagmo-logs" data-aagmo="logs"></div>
      <textarea class="aagmo-input" data-aagmo="input" placeholder="${L('Placeholder')}"></textarea>
      <button type="button" class="aagmo-send" data-aagmo="send">${L('Send')}</button>
    </div>`;

  let root = null; /* chat root element */
  const $el = (k) => root?.querySelector(`[data-aagmo="${k}"]`); /* data hook finder */
  const tabs = new Map(); /* tab records by id */
  let activeId = null; /* active tab id */
  const newId = () => 't-' + Math.random().toString(16).slice(2, 10).padEnd(8, '0'); /* random tab id */
  const logFor = (tabId) => (TABS_ON && tabs.get(tabId)?.log) || tabs.get(activeId)?.log || null; /* log by tab id */

  const renderBar = () => {
    const bar = $el('tabs');
    if (!bar) return; /* no bar returns, else rebuilds */
    bar.textContent = '';
    for (const tab of tabs.values()) { /* each tab button added, ends at last */
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'aagmo-tab aagmo-' + tab.state + (tab.id === activeId ? ' aagmo-active' : '');
      button.dataset.tab = tab.id;
      const title = document.createElement('span');
      title.className = 'aagmo-tab-t';
      title.textContent = tab.title;
      title.title = tab.title;
      button.appendChild(title);
      const close = document.createElement('span');
      close.className = 'aagmo-tab-x';
      close.dataset.close = tab.id;
      close.textContent = '×';
      close.title = L('TabClose');
      button.appendChild(close);
      bar.appendChild(button);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'aagmo-tab-add';
    add.dataset.aagmo = 'tabadd';
    add.textContent = '+';
    add.title = L('TabAdd');
    add.disabled = tabs.size >= TAB_MAX;
    bar.appendChild(add);
  };

  const activate = (id) => {
    if (!tabs.has(id)) return; /* unknown tab returns, else activates */
    activeId = id;
    for (const tab of tabs.values()) tab.log.hidden = tab.id !== id; /* each log hidden unless active */
    renderBar();
    const log = tabs.get(id).log;
    log.scrollTop = log.scrollHeight;
  };

  const mintTab = (id, title, state = 'idle') => {
    const log = document.createElement('div');
    log.className = 'aagmo-log';
    log.hidden = true;
    $el('logs')?.appendChild(log);
    const tab = { id, title, state, log, sent: false };
    tabs.set(id, tab);
    return tab;
  };

  const addTab = () => {
    if (tabs.size >= TAB_MAX) return null; /* tab cap returns null, else adds */
    const tab = mintTab(TABS_ON ? newId() : MAIN_TAB, L('TabNew'));
    activate(tab.id);
    setTimeout(() => $el('input')?.focus(), 0);
    return tab;
  };

  const closeTab = (id) => {
    const tab = tabs.get(id);
    if (!tab) return; /* unknown tab returns, else closes */
    if (tab.sent) { /* sent tab asks relay to close */
      let delivered = false;
      try { delivered = !!api.closeTab(id); } catch {}
      if (!delivered) { addMsg('sys', L('StatusDisconnected'), id); setStatus('disconnected'); return; } /* undelivered close reports, returns */
    }
    tabs.delete(id);
    tab.log.remove();
    if (activeId === id) { /* active tab closed picks another */
      const next = tabs.keys().next().value;
      if (next) activate(next); else addTab(); /* next tab activated, else new tab */
    } else renderBar(); /* inactive tab closed rerenders bar */
  };

  const addMsg = (role, text, tabId) => {
    const log = logFor(tabId);
    if (!log) return; /* no log returns, else appends */
    const msg = document.createElement('div');
    msg.className = 'aagmo-msg aagmo-' + role;
    if (role === 'user' || role === 'assistant') { /* chat roles get speaker label */
      const who = document.createElement('span');
      who.className = 'aagmo-who';
      who.textContent = role === 'user' ? L('You') : L('Assistant');
      msg.appendChild(who);
    }
    const body = document.createElement('span');
    body.textContent = text; /* textContent: no HTML injection */
    msg.appendChild(body);
    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
  };

  const setStatus = (state, text) => {
    const bar = $el('status');
    if (!bar) return; /* no bar returns, else updates */
    const ready = state === 'ready' || state === 'working'; /* ready or working flag */
    bar.className = 'aagmo-status ' + (ready ? 'ready' : 'warn');
    bar.textContent = text || (state === 'working' ? L('StatusWorking') /* text override, else state label */
      : ready ? L('StatusReady')
      : state === 'disconnected' ? L('StatusDisconnected')
      : L('StatusNoListener'));
  };

  const div = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; }; /* div factory */
  const rpCard = (id) => [...(root?.querySelectorAll('[data-rollback]') || [])].find((c) => c.dataset.rollback === id); /* rollback card finder */

  const markRolled = (card, state) => {
    card.querySelector('.aagmo-cf-action')?.remove();
    card.querySelector('.aagmo-rp-done')?.remove();
    card.appendChild(div('aagmo-rp-done', state === 'partial' ? L('RollbackPartial') : L('RollbackApplied')));
  };

  const renderPoint = (pt) => {
    if (!pt?.id || rpCard(pt.id)) return; /* sync resend deduped, new renders */
    const log = logFor(pt.tabId);
    if (!log) return; /* no log returns, else renders */
    const card = document.createElement('div');
    card.className = 'aagmo-msg aagmo-rollback';
    card.dataset.rollback = pt.id;
    card.appendChild(div('aagmo-cf-h', `${L('RollbackPoint')} ${pt.id} (${pt.kind || 'eval'})`));
    card.appendChild(div('aagmo-cf-sum', pt.summary || 'Write'));
    if (pt.captured) card.appendChild(div('aagmo-rp-cap', pt.captured)); /* captured note shown when present */
    const docs = Array.isArray(pt.docs) ? pt.docs : [];
    if (docs.length) { /* docs present adds details list */
      const det = document.createElement('details');
      det.className = 'aagmo-rp-docs';
      const sm = document.createElement('summary');
      sm.textContent = docs[0] + (docs.length > 1 ? ` (+${docs.length - 1})` : '');
      det.appendChild(sm);
      const ul = document.createElement('ul');
      for (const d of docs) { const li = document.createElement('li'); li.textContent = d; ul.appendChild(li); } /* each doc listed, ends at last */
      det.appendChild(ul);
      card.appendChild(det);
    }
    if (!pt.state || pt.state === 'live') { /* live point gets action button */
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'aagmo-cf-btn aagmo-cf-action';
      action.textContent = L('RollbackAction');
      action.addEventListener('click', () => {
        const prompt = `/rollback ${pt.id}`;
        const promptId = api.sendPrompt(prompt, pt.tabId);
        if (!promptId) { addMsg('sys', L('StatusDisconnected'), pt.tabId); return; } /* no prompt id reports, returns */
        addMsg('user', prompt, pt.tabId);
        action.disabled = true;
      });
      card.appendChild(action);
    } else markRolled(card, pt.state); /* rolled point marked done */
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
  };

  const renderRollback = (p) => {
    if (!p) return; /* no payload returns */
    if (p.event === 'point') renderPoint(p.point); /* point event renders its card */
    else if (p.event === 'sync') for (const pt of p.points || []) renderPoint(pt); /* sync event renders each point */
    else if (p.event === 'rolled-back' && p.point?.id) { /* rolled back event marks card */
      const card = rpCard(p.point.id);
      if (card) markRolled(card, p.point.state); /* card found gets marked */
      addMsg('sys', `${p.point.id}: ${p.point.state === 'partial' ? L('RollbackPartial') : L('RollbackApplied')}`, p.point.tabId);
    }
  };

  const syncTabs = (list) => {
    if (!Array.isArray(list)) return; /* non array returns, array syncs */
    const seen = new Set();
    for (const record of list) { /* each record synced, ends at last */
      if (!record?.id || (!TABS_ON && record.id !== MAIN_TAB)) continue; /* invalid or foreign tab skipped */
      seen.add(record.id);
      let tab = tabs.get(record.id);
      if (!tab) { /* unseen tab minted with transcript */
        tab = mintTab(record.id, record.title || record.id, record.state);
        for (const line of record.transcript || []) addMsg(line.role, line.text, record.id); /* replays transcript lines in order */
      }
      tab.title = record.title || tab.title;
      tab.state = record.state || 'idle';
      tab.sent = true;
    }
    for (const tab of [...tabs.values()]) { /* each tab pruned, ends at last */
      if (seen.has(tab.id)) continue; /* listed tab kept, next */
      const pristine = !tab.sent && !tab.log.childElementCount;
      if (tab.sent || (pristine && seen.size)) { tabs.delete(tab.id); tab.log.remove(); } /* stale or pristine tab removed */
    }
    if (!tabs.size) addTab(); /* no tabs adds one */
    else if (!tabs.has(activeId)) activate(tabs.keys().next().value); /* active gone picks first tab */
    else renderBar(); /* otherwise only rerenders bar */
  };

  /* Insert dropped document references. */
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
    try { data = TextEditor.getDragEventData(ev); } catch { return; }
    if (!data?.uuid) return; /* no uuid returns, else handles drop */
    ev.preventDefault();
    const ta = $el('input');
    if (!ta) return; /* no input returns, else inserts */
    let name = null;
    try { name = fromUuidSync(data.uuid)?.name || null; } catch {}
    insertRef(ta, name ? `@UUID[${data.uuid}]{${name}}` : `@UUID[${data.uuid}]`);
  };

  const submit = () => {
    const ta = $el('input');
    const text = (ta?.value || '').trim();
    const tab = tabs.get(activeId);
    if (!text || !tab) return; /* empty or no tab returns */
    if (TABS_ON && text.toLowerCase() === '/close') { ta.value = ''; closeTab(tab.id); return; } /* close command closes tab, returns */
    const interrupt = tab.sent && tab.state === 'working';
    const id = api.sendPrompt(text, tab.id);
    if (!id) { addMsg('sys', L('StatusDisconnected'), tab.id); setStatus('disconnected'); return; } /* send failed reports, returns */
    if (!tab.sent) { tab.title = text.slice(0, TAB_TITLE_LEN); tab.state = 'working'; } /* first send titles tab */
    tab.sent = true;
    addMsg('user', text, tab.id);
    if (interrupt) setStatus('working', L('Interrupt')); /* mid work send flags interrupt */
    renderBar();
    ta.value = '';
    ta.focus();
  };

  /* Subscribe until the dialog closes. */
  const unsubReply = api.onReply((p) => addMsg('assistant', p?.text ?? '', p?.tabId)); /* reply unsubscriber */
  const unsubStatus = api.onStatus((p) => setStatus(p?.state || 'no-listener', p?.text)); /* status unsubscriber */
  const unsubMode = api.onMode?.((p) => { /* mode unsubscriber */
    const external = p?.mode === 'external';
    addMsg('sys', external ? L('ModeExternal') : L('ModeInternal'), activeId);
    setStatus(external ? 'external' : 'ready', external ? L('ModeExternal') : L('ModeInternal'));
  });
  const unsubRollback = api.onRollback?.((p) => renderRollback(p || {})); /* rollback unsubscriber */
  const unsubTabs = api.onTabs?.((p) => syncTabs(p?.tabs)); /* tabs unsubscriber */
  let poll = null, wasConnected = true; /* poll handle, link flag */

  const dlg = new Dialog({ /* chat dialog */
    title: L('Title'),
    content,
    buttons: { close: { label: L('Close') } },
    default: 'close',
    render: (html) => {
      root = (html && html[0]) ? html[0] : html;
      $el('send')?.addEventListener('click', submit);
      const ta = $el('input');
      ta?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submit(); } /* plain Enter submits */
      });
      $el('tabs')?.addEventListener('click', (ev) => {
        const close = ev.target.closest?.('[data-close]');
        if (close) { ev.stopPropagation(); closeTab(close.dataset.close); return; } /* close clicked closes, returns */
        if (ev.target.closest?.('[data-aagmo="tabadd"]')) { addTab(); return; } /* add clicked adds tab, returns */
        const tab = ev.target.closest?.('[data-tab]');
        if (tab) activate(tab.dataset.tab); /* tab clicked activates it */
      });
      if (TABS_ON) addTab(); else activate(mintTab(MAIN_TAB, L('Title')).id); /* multitasking adds tab, else main */
      const wrap = $el('wrap');
      let dragDepth = 0;
      const undrop = () => { dragDepth = 0; $el('input')?.classList.remove('aagmo-drop'); };
      wrap?.addEventListener('dragenter', (ev) => {
        ev.preventDefault();
        dragDepth++;
        $el('input')?.classList.add('aagmo-drop');
      });
      wrap?.addEventListener('dragleave', () => {
        dragDepth--;
        if (dragDepth <= 0) undrop(); /* depth zero clears drop highlight */
      });
      wrap?.addEventListener('dragover', (ev) => ev.preventDefault());
      wrap?.addEventListener('drop', (ev) => {
        undrop();
        onDrop(ev);
      });
      setStatus(api.isConnected() ? 'no-listener' : 'disconnected');
      api.requestStatus();
      poll = setInterval(() => {
        const c = api.isConnected();
        if (!c) setStatus('disconnected'); /* offline marks status disconnected */
        else if (!wasConnected) { api.requestStatus(); } /* back online refreshes status */
        wasConnected = c;
      }, 3000);
      setTimeout(() => $el('input')?.focus(), 50);
    },
    close: () => {
      try { unsubReply?.(); } catch {}
      try { unsubStatus?.(); } catch {}
      try { unsubMode?.(); } catch {}
      try { unsubRollback?.(); } catch {}
      try { unsubTabs?.(); } catch {}
      if (poll) { clearInterval(poll); poll = null; } /* poll active gets cleared */
    },
  }, { width: 560, resizable: false, classes: ['aagmo-dialog'] });

  dlg.render(true);
}

export const CHAT_MACRO_COMMAND =
  `(${chatBoxMain.toString()})().catch((e) => console.error('[aagm-o] chat macro error:', e));`;
