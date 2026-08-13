// World settings mirror (DESIGN §13.2). The module owns the values (Foundry
// "Configure Settings"), snapshots them in `hello`, and re-sends on change via
// the `settings.sync` notification. The relay is the ENFORCEMENT point - the
// module UI is just paint - so gate logic reads from here, never the bridge.

const DEFAULTS = {
  mode: 'assistant',            /* assistant | cogm | custom */
  multitasking: false,
  chainOffers: false,
  chainOfferThreshold: 4,
  chainMaxLength: 20,
  mirrorEnabled: false,
  mirrorPath: '',
  mirrorContextualSort: false,
};
const CHAIN_HARD_CAP = 40;      /* §13.1 ceiling on chainMaxLength */

export class WorldSettings {
  constructor({ dispatcher, audit }) {
    this.audit = audit;
    this.values = { ...DEFAULTS };
    dispatcher.subscribe('settings.sync', (p) => this.update(p || {}, 'sync'));
  }

  update(raw, via = 'hello') {
    const v = this.values;
    for (const k of Object.keys(DEFAULTS)) if (raw[k] !== undefined) v[k] = raw[k];
    v.chainOfferThreshold = clampInt(v.chainOfferThreshold, 2, 99, DEFAULTS.chainOfferThreshold);
    v.chainMaxLength = clampInt(v.chainMaxLength, 2, CHAIN_HARD_CAP, DEFAULTS.chainMaxLength);
    this.audit.log('settings.update', { via, ...v });
  }

  get(key) { return this.values[key]; }
  snapshot() { return { ...this.values }; }
}

function clampInt(n, lo, hi, fallback) {
  const i = Number.parseInt(n, 10);
  return Number.isFinite(i) ? Math.min(hi, Math.max(lo, i)) : fallback;
}
