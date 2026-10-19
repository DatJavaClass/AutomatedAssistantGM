const MODULE_ID = 'aagm-o'; // module id

export const SETTING_KEYS = [ // persisted setting keys
  'mode', 'multitasking',
  'mirrorEnabled', 'mirrorPath', 'mirrorContextualSort',
];

export const PRESETS = { // mode presets
  assistant: { multitasking: false },
  cogm: { multitasking: true },
};

const DEFS = { // setting definitions
  mode: { type: String, default: 'assistant' },
  multitasking: { type: Boolean, default: false },
  mirrorEnabled: { type: Boolean, default: false },
  mirrorPath: { type: String, default: '' },
  mirrorContextualSort: { type: Boolean, default: false },
};

export function registerModeSettings() {
  for (const [key, def] of Object.entries(DEFS)) { // each setting registered, ends at last
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
  for (const key of SETTING_KEYS) settings[key] = game.settings.get(MODULE_ID, key); // each key read, ends at last
  return settings;
}
