const MODULE_ID = 'aagm-k';

export const SETTING_KEYS = [
  'mode', 'multitasking',
  'mirrorEnabled', 'mirrorPath', 'mirrorContextualSort',
];

export const PRESETS = {
  assistant: { multitasking: false },
  cogm: { multitasking: true },
};

const DEFS = {
  mode: { type: String, default: 'assistant' },
  multitasking: { type: Boolean, default: false },
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
