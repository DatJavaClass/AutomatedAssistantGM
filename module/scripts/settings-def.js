const MODULE_ID = 'aagm-o';

export const SETTING_KEYS = [
  'mode', 'multitasking', 'chainOffers', 'chainOfferThreshold', 'chainMaxLength',
  'mirrorEnabled', 'mirrorPath', 'mirrorContextualSort',
];

export const PRESETS = {
  assistant: { multitasking: false, chainOffers: false },
  cogm: { multitasking: true, chainOffers: true },
};

const DEFS = {
  mode: { type: String, default: 'assistant' },
  multitasking: { type: Boolean, default: false },
  chainOffers: { type: Boolean, default: false },
  chainOfferThreshold: { type: Number, default: 4 },
  chainMaxLength: { type: Number, default: 20 },
  mirrorEnabled: { type: Boolean, default: false },
  mirrorPath: { type: String, default: '' },
  mirrorContextualSort: { type: Boolean, default: false },
};

export function registerModeSettings() {
  for (const [key, def] of Object.entries(DEFS)) {
    game.settings.register(MODULE_ID, key, {
      scope: 'world',
      config: false,
      type: def.type,
      default: def.default,
      onChange: () => game.modules.get(MODULE_ID)?.api?.syncSettings?.(),
    });
  }
}

export function settingsSnapshot() {
  const settings = {};
  for (const key of SETTING_KEYS) settings[key] = game.settings.get(MODULE_ID, key);
  return settings;
}
