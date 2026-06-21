// Classifier for foundry_eval. The relay routes by category:
//   db-journal  → hard refuse (macro backing stores; never, even read-only)
//   hp          → hard refuse (HP only ever moves through foundry_apply_damage,
//                 which enforces the absolute ≥1 HP floor — lethal is human-only)
//   destructive → write path, DOUBLE confirm (deletes)
//   mutating    → write path, SINGLE confirm (create/update/flags/etc.)
//   read        → execute immediately
//
// Heuristic, NOT a sandbox. Defense-in-depth only: arbitrary JS can dodge
// regex. The real guarantees are (a) the ≥1 HP floor lives in the damage
// handler on live data, not here, and (b) every write goes through the
// human confirmation gate. Misclassification escalates confirmation (the
// relay takes the stricter of this verdict and Claude's declared intent),
// it never silently runs a write.

const DB_JOURNAL_DENY = [
  /yB5klzKycb6bTbcy/,                                   // NPC Register (+ Mail/Mailbox Index page)
  /getName\(\s*["'`]\s*NPC Register\s*["'`]\s*\)/i,
  /getName\(\s*["'`]\s*(?:Mail(?:box)? Index)\s*["'`]\s*\)/i,
  /\brunManaged\b/,                                     // RUN's managed-page flag
];

// HP / "kill" reach-arounds. Damage must go through the constrained primitive.
const HP_WRITE = [
  /\.\s*applyDamage\s*\(/,
  /\.\s*modifyTokenAttribute\s*\(/,
  /\.\s*kill\s*\(/,
  /attributes\s*\.\s*hp\b/,                             // any reference into system.attributes.hp in writeable code
  /\.\s*(?:hp|hitPoints|currentHP)\b[\s\S]{0,24}=[^=]/,
];

// Deletes — the most destructive class, always double-confirm.
const DESTRUCTIVE = [
  /\bdelete(?:Documents|EmbeddedDocuments)?\s*\(/,
  /\.\s*delete\s*\(/,
  /\b(?:Actor|Item|Scene|JournalEntry|JournalEntryPage|Macro|RollTable|Playlist|PlaylistSound|Folder|Token|TokenDocument|ActiveEffect|Combat|Combatant|User|Cards|Card|Wall|Tile|Drawing|MeasuredTemplate|Note)\s*\.\s*delete/,
];

// Everything else that changes state — single confirm.
const MUTATING = [
  /\b(?:create|update)(?:Documents|EmbeddedDocuments)?\s*\(/,
  /\.\s*(?:create|update)\s*\(/,
  /\b(?:Actor|Item|Scene|JournalEntry|JournalEntryPage|Macro|RollTable|Playlist|PlaylistSound|Folder|Token|TokenDocument|ActiveEffect|Combat|Combatant|ChatMessage|User|Cards|Card|AmbientLight|AmbientSound|Wall|Tile|Drawing|MeasuredTemplate|Note)\s*\.\s*(?:create|update)/,
  /\.\s*(?:set|unset)Flag\s*\(/,
  /\.\s*updateSource\s*\(/,
  /game\s*\.\s*settings\s*\.\s*set\s*\(/,
  /\.\s*(?:applyDelta|rollDamage|toggleEffect|toggleStatusEffect|toggleActiveEffect|addStatusEffect)\s*\(/,
  /\bChatMessage\s*\.\s*create\s*\(/,
  /\bHooks\s*\.\s*(?:call|callAll)\s*\(/,
  /\bgame\s*\.\s*socket\s*\.\s*emit\s*\(/,
  /\.\s*(?:activate|view)\s*\(\s*\)/,
  /fromUuid[\s\S]{0,120}\.\s*(?:update|delete|create)\s*\(/,
  /\.\s*system\s*=[^=]/,
];

function firstMatch(code, list) {
  for (const re of list) {
    const m = re.exec(code);
    if (m) return { pattern: re.source, match: m[0].slice(0, 80) };
  }
  return null;
}

export function classifyEval(code) {
  const c = String(code ?? '');
  let m;
  if ((m = firstMatch(c, DB_JOURNAL_DENY))) return { category: 'db-journal', ...m };
  if ((m = firstMatch(c, HP_WRITE)))        return { category: 'hp', ...m };
  if ((m = firstMatch(c, DESTRUCTIVE)))     return { category: 'destructive', ...m };
  if ((m = firstMatch(c, MUTATING)))        return { category: 'mutating', ...m };
  return { category: 'read' };
}

// Severity ordering so the relay can take the stricter of (verdict, declared
// intent). Higher = stricter.
export const SEVERITY = { read: 0, mutating: 1, destructive: 2, hp: 3, 'db-journal': 3 };
