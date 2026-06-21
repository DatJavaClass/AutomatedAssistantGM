// Source for the auto-created "Claude Macro Workshop" macro — a separate
// window from the chat box (own blast radius), reusing the bridge module's
// api/relay/loop/protocol. Serialized via Function.prototype.toString() like
// chat-macro.js; must stay self-contained (runtime globals + the module api
// only). CSS prefix `cmw-` is reserved for this macro (ms-/dw-/ccc- taken).
//
// Layout: a wide IDE-ish window. Top: status + Save target/name + Save button.
// Middle: the Refactor Box (line-number gutter + editable code area, user AND
// Claude editable). Bottom: Text Entry (ask Claude to load/refine/debug) +
// Claude Dialog Box (replies & confirmation cards). "Load macro X" = ask in
// the entry; Claude reads it and pushes it here via foundry_workshop_set.
// Save duplicates the target as "<name>.old" (single rolling backup) then
// overwrites the original to preserve its id/linkages — user-initiated, so
// NOT routed through the §9 gate (the click is the authorization).

async function workshopMain() {
  const MODULE_ID = 'foundry-bridge';
  const STYLE_ID = 'cmw-workshop-theme';
  const LAYOUT_ID = 'cmw-workshop-layout';
  const PROTECTED = ['Open Claude Code Chat', 'Claude Macro Workshop'];
  const L = (k) => game.i18n.localize('FOUNDRY_BRIDGE.WORKSHOP.' + k);

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
    } catch (e) { /* fallback takes over */ }
    if (!css) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = css;
    document.head.appendChild(style);
  }

  const FALLBACK_CSS = `
    .forge-dialog-dark { background:#1a1a1a; color:#e0e0e0; }
    .forge-dialog-dark .section { background:#2a2a2a; border:1px solid #00ffcc; padding:8px; border-radius:4px; }
    .forge-dialog-dark label, .forge-dialog-dark .section-title { color:#00ffcc; }
    .forge-dialog-dark .warning { color:#ffaa00; }
  `;
  await injectMacroStyles(STYLE_ID, 'Dark Theme', FALLBACK_CSS);

  if (!document.getElementById(LAYOUT_ID)) {
    const s = document.createElement('style');
    s.id = LAYOUT_ID;
    s.textContent = `
      .cmw-wrap { display:flex; flex-direction:column; gap:8px; height:100%; }
      .cmw-bar { display:flex; gap:8px; align-items:center; font-size:12px; }
      .cmw-bar .cmw-tgt { flex:1 1 auto; color:#00ffcc; }
      .cmw-name { width:200px; box-sizing:border-box; color:#fff !important;
                  background:#101010; border:1px solid #00ffcc; border-radius:4px; padding:4px; }
      .cmw-name::placeholder { color:#888; }
      .cmw-save { padding:6px 16px; background:#00ffcc; color:#0a0a0a; border:none;
                  border-radius:4px; cursor:pointer; font-weight:600; }
      .cmw-save:hover { background:#33ffd6; }
      .cmw-status { font-size:11px; opacity:0.8; }
      .cmw-edit { display:flex; flex:1 1 auto; min-height:300px; border:1px solid #333;
                  border-radius:4px; overflow:hidden; background:#0c0c0c; }
      .cmw-gutter { flex:0 0 auto; text-align:right; padding:8px 6px; color:#666;
                    background:#111; font-family:monospace; font-size:13px; line-height:1.5;
                    white-space:pre; overflow:hidden; user-select:none; }
      .cmw-code { flex:1 1 auto; resize:none; border:none; outline:none;
                  background:#0c0c0c; color:#cfe !important; font-family:monospace;
                  font-size:13px; line-height:1.5; padding:8px; white-space:pre;
                  overflow:auto; box-sizing:border-box; }
      .cmw-bottom { display:flex; gap:8px; flex:0 0 auto; height:200px; }
      .cmw-col { flex:1 1 0; display:flex; flex-direction:column; gap:4px; min-width:0; }
      .cmw-col label { font-size:11px; color:#00ffcc; }
      .cmw-input { flex:1 1 auto; resize:none; box-sizing:border-box; color:#fff !important;
                   background:#101010; border:1px solid #00ffcc; border-radius:4px;
                   padding:6px; font-family:inherit; font-size:13px; }
      .cmw-input::placeholder { color:#888; }
      .cmw-send { flex:0 0 auto; padding:6px 0; background:#00ffcc; color:#0a0a0a;
                  border:none; border-radius:4px; cursor:pointer; font-weight:600; }
      .cmw-log { flex:1 1 auto; overflow-y:auto; background:#141414; border:1px solid #333;
                 border-radius:4px; padding:6px; display:flex; flex-direction:column; gap:5px; }
      .cmw-msg { white-space:pre-wrap; word-break:break-word; font-size:12px;
                 padding:5px 7px; border-radius:5px; line-height:1.4; }
      .cmw-user   { background:#22323a; border-left:3px solid #00ffcc; }
      .cmw-claude { background:#2a2a2a; border-left:3px solid #ffaa00; }
      .cmw-sys    { color:#ffaa00; font-size:11px; }
      .cmw-cf { background:#241f12; border:1px solid #ffaa00; border-radius:5px; padding:6px; }
      .cmw-cf.cmw-dbl { border-color:#ff6666; background:#2a1414; }
      .cmw-cf-h { color:#ffaa00; font-weight:600; font-size:11px; margin-bottom:3px; }
      .cmw-cf.cmw-dbl .cmw-cf-h { color:#ff6666; }
      .cmw-cf-code { max-height:120px; overflow:auto; background:#0c0c0c; border:1px solid #333;
                     border-radius:3px; padding:5px; font-family:monospace; font-size:11px;
                     white-space:pre; color:#cfe; }
      .cmw-cf-row { display:flex; gap:6px; margin-top:6px; }
      .cmw-cf-btn { flex:1; padding:5px 0; border:none; border-radius:4px; cursor:pointer; font-weight:600; font-size:12px; }
      .cmw-cf-ok { background:#00ffcc; color:#0a0a0a; }
      .cmw-cf-no { background:#552222; color:#ffdddd; }
      .cmw-cf-done { font-size:11px; opacity:0.85; margin-top:5px; }
    `;
    document.head.appendChild(s);
  }

  const api = game.modules.get(MODULE_ID)?.api;
  if (!api || typeof api.isConnected !== 'function' || !api.isConnected()) {
    new Dialog({
      title: L('Title'),
      content: `<div class="forge-dialog-dark"><p class="warning">${L('NotConnected')}</p></div>`,
      buttons: { ok: { label: L('Close') } }, default: 'ok',
    }).render(true);
    return;
  }

  const content = `
    <div class="forge-dialog-dark cmw-wrap">
      <div class="cmw-bar">
        <span class="cmw-tgt" data-cmw="tgt">${L('NoMacro')}</span>
        <input type="text" class="cmw-name" data-cmw="name" placeholder="${L('NamePlaceholder')}"/>
        <button type="button" class="cmw-save" data-cmw="save">${L('Save')}</button>
      </div>
      <div class="cmw-status" data-cmw="status"></div>
      <div class="cmw-edit">
        <div class="cmw-gutter" data-cmw="gutter">1</div>
        <textarea class="cmw-code" data-cmw="code" spellcheck="false" placeholder="${L('EditorPlaceholder')}"></textarea>
      </div>
      <div class="cmw-bottom">
        <div class="cmw-col">
          <label>${L('AskLabel')}</label>
          <textarea class="cmw-input" data-cmw="input" placeholder="${L('AskPlaceholder')}"></textarea>
          <button type="button" class="cmw-send" data-cmw="send">${L('Send')}</button>
        </div>
        <div class="cmw-col">
          <label>${L('DialogLabel')}</label>
          <div class="cmw-log" data-cmw="log"></div>
        </div>
      </div>
    </div>`;

  let root = null;
  const $el = (k) => root?.querySelector(`[data-cmw="${k}"]`);
  const target = { macroId: null, macroName: null };

  const setStatus = (txt) => { const s = $el('status'); if (s) s.textContent = txt || ''; };
  const setTargetLabel = () => {
    const t = $el('tgt');
    if (!t) return;
    t.textContent = target.macroId ? L('Editing') + ' ' + (target.macroName || target.macroId)
      : target.macroName ? L('NewNamed') + ' ' + target.macroName : L('NoMacro');
  };
  const refreshGutter = () => {
    const code = $el('code'); const g = $el('gutter');
    if (!code || !g) return;
    const n = code.value.split('\n').length;
    let out = '';
    for (let i = 1; i <= n; i++) out += i + '\n';
    g.textContent = out;
    g.scrollTop = code.scrollTop;
  };
  const setEditor = (text, macroId, macroName) => {
    const code = $el('code');
    target.macroId = macroId || null;
    target.macroName = macroName || null;
    if (code) code.value = String(text ?? '');
    const nm = $el('name'); if (nm) nm.value = macroName || '';
    setTargetLabel();
    refreshGutter();
    setStatus(macroId ? L('Loaded') + ' ' + (macroName || macroId) : (text ? L('PushedNew') : ''));
  };

  const addMsg = (role, text) => {
    const log = $el('log');
    if (!log) return;
    const m = document.createElement('div');
    m.className = 'cmw-msg cmw-' + role;
    m.textContent = text;
    log.appendChild(m);
    log.scrollTop = log.scrollHeight;
  };

  // Compact §9 confirm card (writes Claude initiates from here are still gated;
  // Save is NOT — that's the user's button below).
  const renderConfirm = (p) => {
    const log = $el('log');
    if (!log || !p || !p.opId) return;
    const card = document.createElement('div');
    card.className = 'cmw-msg cmw-cf' + (p.level === 'double' ? ' cmw-dbl' : '');
    const h = document.createElement('div');
    h.className = 'cmw-cf-h';
    h.textContent = (p.level === 'double' ? L('CfDestructive') : L('CfWrite')) + ' — ' + (p.kind || 'op');
    card.appendChild(h);
    const sum = document.createElement('div');
    sum.textContent = p.summary || '(no summary)';
    card.appendChild(sum);
    if (p.code) { const pre = document.createElement('pre'); pre.className = 'cmw-cf-code'; pre.textContent = p.code; card.appendChild(pre); }
    let done = false;
    const finish = (ok, reason, key) => {
      if (done) return; done = true;
      try { api.sendConfirmResult(p.opId, ok, reason); } catch (e) {}
      card.querySelector('.cmw-cf-row')?.remove();
      const d = document.createElement('div'); d.className = 'cmw-cf-done'; d.textContent = L(key); card.appendChild(d);
      log.scrollTop = log.scrollHeight;
    };
    const mkrow = (okL, onOk, noL, onNo) => {
      const r = document.createElement('div'); r.className = 'cmw-cf-row';
      const b1 = document.createElement('button'); b1.type = 'button'; b1.className = 'cmw-cf-btn cmw-cf-ok'; b1.textContent = okL; b1.addEventListener('click', onOk);
      const b2 = document.createElement('button'); b2.type = 'button'; b2.className = 'cmw-cf-btn cmw-cf-no'; b2.textContent = noL; b2.addEventListener('click', onNo);
      r.appendChild(b1); r.appendChild(b2); return r;
    };
    card.appendChild(mkrow(
      L('Approve'),
      () => {
        if (p.level === 'double') {
          card.querySelector('.cmw-cf-row')?.remove();
          const w = document.createElement('div'); w.className = 'cmw-cf-h'; w.textContent = L('CfAgain'); card.appendChild(w);
          card.appendChild(mkrow(L('ApproveFinal'), () => finish(true, 'approved-double', 'Approved'), L('Cancel'), () => finish(false, 'cancelled', 'Denied')));
          log.scrollTop = log.scrollHeight;
        } else { finish(true, 'approved', 'Approved'); }
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
    if (!api.sendPrompt(text)) { addMsg('sys', L('Disconnected')); return; }
    addMsg('user', text);
    ta.value = '';
    ta.focus();
  };

  const doSave = async () => {
    const code = $el('code');
    const content = code ? code.value : '';
    if (!content.trim()) { ui.notifications?.warn(L('EmptySave')); return; }
    const nameField = ($el('name')?.value || '').trim();
    let macro = target.macroId ? game.macros.get(target.macroId)
      : (target.macroName ? game.macros.getName(target.macroName) : (nameField ? game.macros.getName(nameField) : null));
    const intendedName = macro?.name || target.macroName || nameField;
    if (!intendedName) { ui.notifications?.warn(L('NeedName')); return; }
    if (PROTECTED.includes(intendedName)) { ui.notifications?.error(L('ProtectedRefuse')); return; }
    try {
      if (macro) {
        if (macro.getFlag?.(MODULE_ID, 'autoMacro') || PROTECTED.includes(macro.name)) {
          ui.notifications?.error(L('ManagedRefuse'));
          return;
        }
        const oldName = macro.name + '.old';
        const prior = game.macros.getName(oldName);
        if (prior) await prior.delete();                 // single rolling backup
        const data = macro.toObject();
        delete data._id;
        data.name = oldName;
        if (data.flags) delete data.flags[MODULE_ID];
        await Macro.create(data);
        await macro.update({ command: content });
        target.macroId = macro.id; target.macroName = macro.name;
        setTargetLabel();
        ui.notifications?.info(L('Saved') + ' ' + macro.name + ' → ' + oldName);
        addMsg('sys', L('Saved') + ' ' + macro.name + ' (backup: ' + oldName + ')');
      } else {
        const created = await Macro.create({
          name: intendedName, type: 'script', scope: 'global',
          img: 'icons/svg/book.svg', command: content,
        });
        target.macroId = created.id; target.macroName = created.name;
        setTargetLabel();
        ui.notifications?.info(L('Created') + ' ' + intendedName);
        addMsg('sys', L('Created') + ' ' + intendedName);
      }
    } catch (err) {
      console.error('[foundry-bridge] Workshop save failed:', err);
      ui.notifications?.error(L('SaveFailed') + ' ' + (err?.message || err));
    }
  };

  const unsubReply = api.onReply((p) => addMsg('claude', p?.text ?? ''));
  const unsubStatus = api.onStatus((p) => setStatus(p?.state === 'ready' ? L('Ready') : L('NoListener')));
  const unsubConfirm = api.onConfirm((p) => renderConfirm(p || {}));
  const unsubRefactor = api.onRefactorSet((p) => setEditor(p?.content ?? '', p?.macroId, p?.macroName));

  const W = Math.min(Math.round((window.innerWidth || 1600) * 0.95), 2000);
  const H = Math.min(Math.round((window.innerHeight || 900) * 0.9), 1000);

  const dlg = new Dialog({
    title: L('Title'),
    content,
    buttons: { close: { label: L('Close') } },
    default: 'close',
    render: (html) => {
      root = (html && html[0]) ? html[0] : html;
      const code = $el('code');
      code?.addEventListener('input', refreshGutter);
      code?.addEventListener('scroll', () => { const g = $el('gutter'); if (g) g.scrollTop = code.scrollTop; });
      code?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Tab') {
          ev.preventDefault();
          const s = code.selectionStart, e = code.selectionEnd;
          code.value = code.value.slice(0, s) + '  ' + code.value.slice(e);
          code.selectionStart = code.selectionEnd = s + 2;
          refreshGutter();
        }
      });
      $el('send')?.addEventListener('click', submit);
      $el('input')?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submit(); }
      });
      $el('save')?.addEventListener('click', doSave);
      // If Claude pushed code before the window was open, pull it now.
      try {
        const last = api.getLastRefactor?.();
        if (last && last.content) setEditor(last.content, last.macroId, last.macroName);
      } catch (e) {}
      // Live provider so Claude reads the box's GROUND TRUTH (user edits), not a cache.
      api.setRefactorProvider?.(() => ({
        open: true,
        content: $el('code')?.value ?? '',
        macroId: target.macroId,
        macroName: target.macroName,
      }));
      refreshGutter();
      setStatus(api.isConnected() ? '' : L('Disconnected'));
      api.requestStatus?.();
      setTimeout(() => $el('input')?.focus(), 50);
    },
    close: () => {
      try { unsubReply?.(); } catch (e) {}
      try { unsubStatus?.(); } catch (e) {}
      try { unsubConfirm?.(); } catch (e) {}
      try { unsubRefactor?.(); } catch (e) {}
      try { api.setRefactorProvider?.(null); } catch (e) {}
    },
  }, { width: W, height: H, resizable: true, classes: ['cmw-dialog'] });

  dlg.render(true);
}

export const WORKSHOP_MACRO_COMMAND =
  `(${workshopMain.toString()})().catch((e) => console.error('[foundry-bridge] workshop macro error:', e));`;
