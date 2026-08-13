// Shared §13.1 settings definitions - registered by bridge.js, edited by the
// settings menu, snapshotted into `hello` / settings.sync for the relay.
// Preset names are locked (CLAUDE.md #9); the relay enforces, this is paint.

const MODULE_ID = 'foundry-bridge';

export const SETTING_KEYS = [
  'mode', 'multitasking', 'chainOffers', 'chainOfferThreshold', 'chainMaxLength',
  'mirrorEnabled', 'mirrorPath', 'mirrorContextualSort',
];

/* Assistant/Co-GM bundle values; Custom leaves stored values untouched. */
export const PRESETS = {
  assistant: { multitasking: false, chainOffers: false },
  cogm:      { multitasking: true,  chainOffers: true  },
};

const DEFS = {
  mode:                 { type: String,  default: 'assistant' },
  multitasking:         { type: Boolean, default: false },
  chainOffers:          { type: Boolean, default: false },
  chainOfferThreshold:  { type: Number,  default: 4 },
  chainMaxLength:       { type: Number,  default: 20 },
  mirrorEnabled:        { type: Boolean, default: false },
  mirrorPath:           { type: String,  default: '' },
  mirrorContextualSort: { type: Boolean, default: false },
};

// config:false - the submenu form is the only editing surface.
export function registerModeSettings() {
  for (const [key, def] of Object.entries(DEFS)) {
    game.settings.register(MODULE_ID, key, {
      scope: 'world', config: false, type: def.type, default: def.default,
    });
  }
}

export function settingsSnapshot() {
  const out = {};
  for (const k of SETTING_KEYS) out[k] = game.settings.get(MODULE_ID, k);
  return out;
}
