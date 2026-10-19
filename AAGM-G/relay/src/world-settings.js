const DEFAULTS = {
  mode: 'assistant',
  multitasking: false,
  mirrorEnabled: false,
  mirrorPath: '',
  mirrorContextualSort: false,
};

const MODES = new Set(['assistant', 'cogm', 'custom']);

export class WorldSettings {
  constructor({ dispatcher, audit }) {
    this.audit = audit;
    this.values = { ...DEFAULTS };
    dispatcher.subscribe('settings.sync', (params) => this.update(params || {}, 'sync'));
  }

  update(raw, via = 'hello') {
    const next = { ...this.values };
    if (MODES.has(raw.mode)) next.mode = raw.mode; // valid mode accepted
    for (const key of ['multitasking', 'mirrorEnabled', 'mirrorContextualSort']) { // each boolean key copied
      if (typeof raw[key] === 'boolean') next[key] = raw[key]; // boolean value copied
    }
    if (typeof raw.mirrorPath === 'string') next.mirrorPath = raw.mirrorPath; // string path copied
    if (next.mode === 'assistant') next.multitasking = false; // assistant forces multitasking off
    if (next.mode === 'cogm') next.multitasking = true; // cogm forces multitasking on
    this.values = next;
    this.audit.log('settings.update', { via, ...next });
  }

  get(key) { return this.values[key]; }
  snapshot() { return { ...this.values }; }
}
