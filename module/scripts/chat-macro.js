// Phase 2 — source for the auto-created "Open Claude Code Chat" macro.
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

  // Minimal Dark Theme fallback — enough to stay readable if the journal is gone.
  const FALLBACK_CSS = `
    .forge-dialog-dark { background:#1a1a1a; color:#e0e0e0; }
    .forge-dialog-dark .section { background:#2a2a2a; border:1px solid #00ffcc; padding:8px; border-radius:4px; }
    .forge-dialog-dark label, .forge-dialog-dark .section-title { color:#00ffcc; }
    .forge-dialog-dark .warning { color:#ffaa00; }
  `;

  await injectMacroStyles(STYLE_ID, 'Dark Theme', FALLBACK_CSS);

  // Chat-specific layout — kept out of the shared theme (style guide rule),
  // prefixed `ccc-`. Typed text is forced pure white per DatJavaClass's instruction.
  if (!document.getElementById(LAYOUT_ID)) {
    const s = document.createElement('style');
    s.id = LAYOUT_ID;
    // Vertical stack with explicit heights — flex:1 against a Foundry Dialog's
    // indefinite content height collapses, which is what squished the old box.
    s.textContent = `
      .ccc-wrap { display:flex; flex-direction:column; gap:8px; }
      .ccc-status { font-size:12px; padding:5px 8px; border-radius:3px; border:1px solid #00ffcc; }
      .ccc-status.ready { color:#00ffcc; border-color:#00ffcc; }
      .ccc-status.warn  { color:#ffaa00; border-color:#ffaa00; }
      .ccc-log { height:320px; width:100%; box-sizing:border-box; overflow-y:auto;
                 background:#141414; border:1px solid #333; border-radius:4px; padding:8px;
                 display:flex; flex-direction:column; gap:6px; }
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
    <div class="forge-dialog-dark ccc-wrap">
      <div class="ccc-status warn" data-ccc="status">${L('StatusNoListener')}</div>
      <div class="ccc-log" data-ccc="log"></div>
      <textarea class="ccc-input" data-ccc="input" placeholder="${L('Placeholder')}"></textarea>
      <button type="button" class="ccc-send" data-ccc="send">${L('Send')}</button>
    </div>`;

  let root = null;
  const $el = (k) => root?.querySelector(`[data-ccc="${k}"]`);

  const addMsg = (role, text) => {
    const log = $el('log');
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
  const renderConfirm = (p) => {
    const log = $el('log');
    if (!log || !p || !p.opId) return;
    const card = document.createElement('div');
    card.className = 'ccc-msg ccc-confirm' + (p.level === 'double' ? ' ccc-double' : '');

    const h = document.createElement('div');
    h.className = 'ccc-cf-h';
    h.textContent = (p.level === 'double' ? L('ConfirmDestructive') : L('ConfirmWrite')) + ' — ' + (p.kind || 'op');
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

  // Subscribe to relay pushes once, before the dialog opens; tear down on close.
  const unsubReply = api.onReply((p) => addMsg('claude', p?.text ?? ''));
  const unsubStatus = api.onStatus((p) => setStatus(p?.state || 'no-listener'));
  const unsubConfirm = api.onConfirm((p) => renderConfirm(p || {}));
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
      setStatus(api.isConnected() ? 'no-listener' : 'disconnected');
      api.requestStatus();
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
      if (poll) { clearInterval(poll); poll = null; }
    },
  }, { width: 560, resizable: false, classes: ['ccc-dialog'] });

  dlg.render(true);
}

export const CHAT_MACRO_COMMAND =
  `(${chatBoxMain.toString()})().catch((e) => console.error('[foundry-bridge] chat macro error:', e));`;
