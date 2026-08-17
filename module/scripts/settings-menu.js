/* Foundry settings application. */
/* Inline HTML avoids shipping templates. */

import { PRESETS, SETTING_KEYS, settingsSnapshot } from './settings-def.js';

const MODULE_ID = 'aagm-o';
const L = (k) => game.i18n.localize(`AAGM_O.SETTINGS.${k}`);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export class AagmSettingsMenu extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: 'aagm-settings',
      title: game.i18n.localize('AAGM_O.SETTINGS.MenuTitle'),
      width: 500, closeOnSubmit: true, submitOnChange: false,
    });
  }

  /* Leading whitespace breaks form binding. */
  async _renderInner() {
    const s = settingsSnapshot();
    const dis = s.mode !== 'custom' ? 'disabled' : '';
    const chk = (v) => (v ? 'checked' : '');
    const radio = (m) => `
      <label style="display:block; margin-bottom:6px;">
        <input type="radio" name="mode" value="${m}" ${s.mode === m ? 'checked' : ''}>
        <b>${L(`Mode${m}.Name`)}</b>
        <p class="notes" style="margin:2px 0 0 20px;">${L(`Mode${m}.Hint`)}</p>
      </label>`;
    return $(`<form autocomplete="off">
        <fieldset><legend>${L('ModeLegend')}</legend>
          ${radio('assistant')}${radio('cogm')}${radio('custom')}
        </fieldset>
        <fieldset data-aagmo="opts"><legend>${L('OptsLegend')}</legend>
          <label><input type="checkbox" name="multitasking" ${chk(s.multitasking)} ${dis}> ${L('Multitasking.Name')}</label>
          <p class="notes">${L('Multitasking.Hint')}</p>
          <label><input type="checkbox" name="chainOffers" ${chk(s.chainOffers)} ${dis}> ${L('ChainOffers.Name')}</label>
          <p class="notes">${L('ChainOffers.Hint')}</p>
          <label>${L('ChainThreshold.Name')}
            <input type="number" name="chainOfferThreshold" value="${s.chainOfferThreshold}" min="2" max="99" style="width:60px;" ${dis}></label>
          <label>${L('ChainMax.Name')}
            <input type="number" name="chainMaxLength" value="${s.chainMaxLength}" min="2" max="40" style="width:60px;" ${dis}></label>
        </fieldset>
        <fieldset><legend>${L('MirrorLegend')}</legend>
          <label><input type="checkbox" name="mirrorEnabled" ${chk(s.mirrorEnabled)}> ${L('MirrorEnabled.Name')}</label>
          <p class="notes">${L('MirrorEnabled.Hint')}</p>
          <label>${L('MirrorPath.Name')}
            <input type="text" name="mirrorPath" value="${esc(s.mirrorPath)}" placeholder="C:\\Users\\you\\...\\Macro Database" style="width:100%;"></label>
          <label><input type="checkbox" name="mirrorContextualSort" ${chk(s.mirrorContextualSort)}> ${L('MirrorSort.Name')}</label>
          <p class="notes">${L('MirrorSort.Hint')}</p>
        </fieldset>
        <footer style="margin-top:8px;"><button type="submit"><i class="fas fa-save"></i> ${L('Save')}</button></footer>
      </form>`);
  }

  activateListeners(html) {
    super.activateListeners(html);
    /* Seatbelt: bind submit if core missed the form */
    const form = html[0] instanceof HTMLFormElement ? html[0] : (html.find('form')[0] || html.closest('form')[0]);
    if (form && form.onsubmit == null) { this.form = form; form.onsubmit = this._onSubmit.bind(this); }
    /* Modes lock dependent options live. */
    html.find('input[name="mode"]').on('change', (ev) => {
      const mode = ev.currentTarget.value, custom = mode === 'custom';
      html.find('[data-aagmo="opts"] input').prop('disabled', !custom);
      const p = PRESETS[mode];
      if (p) for (const [k, v] of Object.entries(p)) html.find(`input[name="${k}"]`).prop('checked', v);
    });
  }

  async _updateObject(_event, formData) {
    const mode = (PRESETS[formData.mode] || formData.mode === 'custom') ? formData.mode : 'assistant';
    if (PRESETS[mode]) Object.assign(formData, PRESETS[mode]); /* presets win */
    formData.mode = mode;
    for (const k of SETTING_KEYS) {
      if (formData[k] !== undefined) await game.settings.set(MODULE_ID, k, formData[k]);
    }
    game.modules.get(MODULE_ID)?.api?.syncSettings?.(); /* relay is the enforcer */
    ui.notifications?.info(game.i18n.localize('AAGM_O.SETTINGS.Saved'));
  }
}
