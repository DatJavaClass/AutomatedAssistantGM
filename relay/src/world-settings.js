const DEFAULTS = {
  mode: 'assistant',
  multitasking: false,
  chainOffers: false,
  chainOfferThreshold: 4,
  chainMaxLength: 20,
  mirrorEnabled: false,
  mirrorPath: '',
  mirrorContextualSort: false,
};

const MODES = new Set(['assistant', 'cogm', 'custom']);
const CHAIN_HARD_CAP = 40;

export class WorldSettings {
  constructor({ dispatcher, audit }) {
    this.audit = audit;
    this.values = { ...DEFAULTS };
    dispatcher.subscribe('settings.sync', (params) => this.update(params || {}, 'sync'));
  }

  update(raw, via = 'hello') {
    const next = { ...this.values };
    if (MODES.has(raw.mode)) next.mode = raw.mode;
    for (const key of ['multitasking', 'chainOffers', 'mirrorEnabled', 'mirrorContextualSort']) {
      if (typeof raw[key] === 'boolean') next[key] = raw[key];
    }
    if (typeof raw.mirrorPath === 'string') next.mirrorPath = raw.mirrorPath;
    next.chainOfferThreshold = clampInt(raw.chainOfferThreshold ?? next.chainOfferThreshold, 2, 99, DEFAULTS.chainOfferThreshold);
    next.chainMaxLength = clampInt(raw.chainMaxLength ?? next.chainMaxLength, 2, CHAIN_HARD_CAP, DEFAULTS.chainMaxLength);
    if (next.mode === 'assistant') Object.assign(next, { multitasking: false, chainOffers: false });
    if (next.mode === 'cogm') Object.assign(next, { multitasking: true, chainOffers: true });
    this.values = next;
    this.audit.log('settings.update', { via, ...next });
  }

  get(key) { return this.values[key]; }
  snapshot() { return { ...this.values }; }
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
