// World settings mirror, relay enforces.

const DEFAULTS = {
  mode: 'assistant', /* assistant | cogm | custom */
  multitasking: false,
  chainOffers: false,
  chainOfferThreshold: 4,
  chainMaxLength: 20,
  mirrorEnabled: false,
  mirrorPath: '',
  mirrorContextualSort: false,
  writePolicy: 'rollback', /* rollback | confirm (2.0, §15.2) */
};
const CHAIN_HARD_CAP = 40; /* chainMaxLength ceiling */

export class WorldSettings {
  constructor({ dispatcher, audit }) {
    this.audit = audit;
    this.values = { ...DEFAULTS };
    dispatcher.subscribe('settings.sync', (p) => this.update(p || {}, 'sync'));
  }

  update(raw, via = 'hello') {
    const v = this.values; /* live settings */
    for (const k of Object.keys(DEFAULTS)) if (raw[k] !== undefined) v[k] = raw[k]; // each key, copies when present
    v.chainOfferThreshold = clampInt(v.chainOfferThreshold, 2, 99, DEFAULTS.chainOfferThreshold);
    v.chainMaxLength = clampInt(v.chainMaxLength, 2, CHAIN_HARD_CAP, DEFAULTS.chainMaxLength);
    if (v.writePolicy !== 'confirm') v.writePolicy = 'rollback'; // not confirm falls to rollback
    this.audit.log('settings.update', { via, ...v });
  }

  get(key) { return this.values[key]; }
  snapshot() { return { ...this.values }; }
}

function clampInt(n, lo, hi, fallback) {
  const i = Number.parseInt(n, 10); /* parsed int */
  return Number.isFinite(i) ? Math.min(hi, Math.max(lo, i)) : fallback;
}
