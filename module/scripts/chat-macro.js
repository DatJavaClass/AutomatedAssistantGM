/* "Open AAGM-O Chat" macro source, serialized via .toString().
   Self-contained: runtime globals + module api only. */

async function chatBoxMain() {
  const MODULE_ID = 'aagm-o';
  const STYLE_ID = 'aagmo-chat-theme';
  const LAYOUT_ID = 'aagmo-chat-layout';
  const L = (k) => game.i18n.localize('AAGM_O.CHAT.' + k);

  /* Prefer journal styles over fallback CSS. */
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
    } catch { /* fallback silently takes over */ }
    if (!css) return;
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
  if (!document.getElementById(LAYOUT_ID)) {
    const s = document.createElement('style');
    s.id = LAYOUT_ID;
    /* Fixed height prevents Foundry flex collapse. */
    s.textContent = `
      .aagmo-wrap { display:flex; flex-direction:column; gap:8px; }
      .aagmo-status { font-size:12px; padding:5px 8px; border-radius:3px; border:1px solid #00ffcc; }
      .aagmo-status.ready { color:#00ffcc; border-color:#00ffcc; }
      .aagmo-status.warn  { color:#ffaa00; border-color:#ffaa00; }
      .aagmo-log { height:320px; width:100%; box-sizing:border-box; overflow-y:auto;
                 background:#141414; border:1px solid #333; border-radius:4px; padding:8px;
                 display:flex; flex-direction:column; gap:6px; }
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
      .aagmo-confirm { align-self:stretch; max-width:100%; background:#241f12;
                     border:1px solid #ffaa00; border-radius:6px; padding:8px; }
      .aagmo-confirm.aagmo-double { border-color:#ff6666; background:#2a1414; }
      .aagmo-cf-h { color:#ffaa00; font-weight:600; font-size:12px; margin-bottom:4px; }
      .aagmo-confirm.aagmo-double .aagmo-cf-h { color:#ff6666; }
      .aagmo-cf-sum { font-size:13px; margin-bottom:6px; white-space:pre-wrap; }
      .aagmo-cf-code { max-height:160px; overflow:auto; background:#0c0c0c;
                     border:1px solid #333; border-radius:4px; padding:6px;
                     font-family:monospace; font-size:12px; white-space:pre; color:#cfe; }
      .aagmo-cf-tbl { width:100%; font-size:12px; border-collapse:collapse; margin-top:4px; }
      .aagmo-cf-tbl td, .aagmo-cf-tbl th { border-bottom:1px solid #333; padding:2px 6px; text-align:left; }
      .aagmo-cf-row { display:flex; gap:8px; margin-top:8px; }
      .aagmo-cf-btn { flex:1; padding:7px 0; border:none; border-radius:4px;
                    cursor:pointer; font-weight:600; }
      .aagmo-cf-approve { background:#00ffcc; color:#0a0a0a; }
      .aagmo-cf-approve:hover { background:#33ffd6; }
      .aagmo-cf-deny { background:#552222; color:#ffdddd; }
      .aagmo-cf-deny:hover { background:#773333; }
      .aagmo-cf-done { font-size:12px; margin-top:6px; opacity:0.85; }
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
    <div class="forge-dialog-dark aagmo-wrap" data-aagmo="wrap">
      <div class="aagmo-status warn" data-aagmo="status">${L('StatusNoListener')}</div>
      <div class="aagmo-log" data-aagmo="log"></div>
      <textarea class="aagmo-input" data-aagmo="input" placeholder="${L('Placeholder')}"></textarea>
      <button type="button" class="aagmo-send" data-aagmo="send">${L('Send')}</button>
    </div>`;

  let root = null;
  const $el = (k) => root?.querySelector(`[data-aagmo="${k}"]`);

  const addMsg = (role, text) => {
    const log = $el('log');
    if (!log) return;
    const msg = document.createElement('div');
    msg.className = 'aagmo-msg aagmo-' + role;
    if (role === 'user' || role === 'assistant') {
      const who = document.createElement('span');
      who.className = 'aagmo-who';
      who.textContent = role === 'user' ? L('You') : L('Assistant');
      msg.appendChild(who);
    }
    const body = document.createElement('span');
    body.textContent = text; // textContent: no HTML injection, newlines kept by CSS
    msg.appendChild(body);
    log.appendChild(msg);
    log.scrollTop = log.scrollHeight;
  };

  const setStatus = (state, text) => {
    const bar = $el('status');
    if (!bar) return;
    const ready = state === 'ready' || state === 'working';
    bar.className = 'aagmo-status ' + (ready ? 'ready' : 'warn');
    bar.textContent = text || (state === 'working' ? L('StatusWorking')
      : ready ? L('StatusReady')
      : state === 'disconnected' ? L('StatusDisconnected')
      : L('StatusNoListener'));
  };

  /* Double gates require repeated approval. */
  const renderConfirm = (p) => {
    const log = $el('log');
    if (!log || !p || !p.opId) return;
    const card = document.createElement('div');
    card.className = 'aagmo-msg aagmo-confirm' + (p.level === 'double' ? ' aagmo-double' : '');

    const h = document.createElement('div');
    h.className = 'aagmo-cf-h';
    h.textContent = (p.level === 'double' ? L('ConfirmDestructive') : L('ConfirmWrite')) + ' - ' + (p.kind || 'op');
    card.appendChild(h);

    const sum = document.createElement('div');
    sum.className = 'aagmo-cf-sum';
    sum.textContent = p.summary || '(no summary provided)';
    card.appendChild(sum);

    if (p.code) {
      const pre = document.createElement('pre');
      pre.className = 'aagmo-cf-code';
      pre.textContent = p.code;
      card.appendChild(pre);
    }
    if (Array.isArray(p.preview) && p.preview.length) {
      const tbl = document.createElement('table');
      tbl.className = 'aagmo-cf-tbl';
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
      try { api.sendConfirmResult(p.opId, approved, reason); } catch {}
      card.querySelector('.aagmo-cf-row')?.remove();
      const done = document.createElement('div');
      done.className = 'aagmo-cf-done';
      done.textContent = L(msgKey);
      card.appendChild(done);
      log.scrollTop = log.scrollHeight;
    };
    const buildRow = (okLabel, onOk, noLabel, onNo) => {
      const row = document.createElement('div');
      row.className = 'aagmo-cf-row';
      const ok = document.createElement('button');
      ok.type = 'button'; ok.className = 'aagmo-cf-btn aagmo-cf-approve'; ok.textContent = okLabel;
      ok.addEventListener('click', onOk);
      const no = document.createElement('button');
      no.type = 'button'; no.className = 'aagmo-cf-btn aagmo-cf-deny'; no.textContent = noLabel;
      no.addEventListener('click', onNo);
      row.appendChild(ok); row.appendChild(no);
      return row;
    };

    card.appendChild(buildRow(
      L('Approve'),
      () => {
        if (p.level === 'double') {
          card.querySelector('.aagmo-cf-row')?.remove();
          const warn = document.createElement('div');
          warn.className = 'aagmo-cf-h';
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
    if (!data?.uuid) return;
    ev.preventDefault();
    const ta = $el('input');
    if (!ta) return;
    let name = null;
    try { name = fromUuidSync(data.uuid)?.name || null; } catch {}
    insertRef(ta, name ? `@UUID[${data.uuid}]{${name}}` : `@UUID[${data.uuid}]`);
  };

  const submit = () => {
    const ta = $el('input');
    const text = (ta?.value || '').trim();
    if (!text) return;
    const id = api.sendPrompt(text);
    if (!id) { addMsg('sys', L('StatusDisconnected')); setStatus('disconnected'); return; }
    addMsg('user', text);
    ta.value = '';
    ta.focus();
  };

  let chainCard = null;
  const onChain = (params) => {
    const log = $el('log');
    if (!log || !params) return;
    if (params.event === 'grant') {
      chainCard = document.createElement('div');
      chainCard.className = 'aagmo-msg aagmo-confirm';
      const header = document.createElement('div');
      header.className = 'aagmo-cf-h';
      header.textContent = L('ChainActive');
      chainCard.appendChild(header);
      const progress = document.createElement('div');
      progress.className = 'aagmo-cf-sum';
      progress.dataset.aagmo = 'chain-progress';
      progress.textContent = `chain 0/${params.count}: ${params.text || ''}`;
      chainCard.appendChild(progress);
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'aagmo-cf-btn aagmo-cf-deny';
      cancel.textContent = L('ChainCancel');
      cancel.addEventListener('click', () => {
        try { api.cancelChain(params.chainId); } catch {}
      });
      chainCard.appendChild(cancel);
      log.appendChild(chainCard);
      log.scrollTop = log.scrollHeight;
      return;
    }
    if (params.event === 'gate' && chainCard) {
      const progress = chainCard.querySelector('[data-aagmo="chain-progress"]');
      if (progress) progress.textContent = `chain ${params.n}/${params.count}: ${params.text || ''}`;
      log.scrollTop = log.scrollHeight;
      return;
    }
    if (params.event === 'end') {
      chainCard?.querySelector('button')?.remove();
      chainCard = null;
      addMsg('sys', `${L('ChainEnded')} ${params.n}/${params.count} (${params.text || ''})`);
    }
  };

  /* Subscribe until the dialog closes. */
  const unsubReply = api.onReply((p) => addMsg('assistant', p?.text ?? ''));
  const unsubStatus = api.onStatus((p) => setStatus(p?.state || 'no-listener', p?.text));
  const unsubConfirm = api.onConfirm((p) => renderConfirm(p || {}));
  const unsubChain = api.onChain?.(onChain);
  let poll = null, wasConnected = true;

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
        if (dragDepth <= 0) undrop();
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
        if (!c) setStatus('disconnected');
        else if (!wasConnected) { api.requestStatus(); } // reconnected: refresh
        wasConnected = c;
      }, 3000);
      setTimeout(() => $el('input')?.focus(), 50);
    },
    close: () => {
      try { unsubReply?.(); } catch {}
      try { unsubStatus?.(); } catch {}
      try { unsubConfirm?.(); } catch {}
      try { unsubChain?.(); } catch {}
      if (poll) { clearInterval(poll); poll = null; }
    },
  }, { width: 560, resizable: false, classes: ['aagmo-dialog'] });

  dlg.render(true);
}

export const CHAT_MACRO_COMMAND =
  `(${chatBoxMain.toString()})().catch((e) => console.error('[aagm-o] chat macro error:', e));`;
