// Classifies eval code: read, write, destructive, db-journal.

const DB_JOURNAL_DENY = [
  /yB5klzKycb6bTbcy/,                                   // NPC Register (+ Mail/Mailbox Index page)
  /getName\(\s*["'`]\s*NPC Register\s*["'`]\s*\)/i,
  /getName\(\s*["'`]\s*(?:Mail(?:box)? Index)\s*["'`]\s*\)/i,
  /\brunManaged\b/,                                     // RUN's managed-page flag
  // ItemPile Rescue Log: never touch via eval
  /sbO4oAzBIcAN9b0E/,
  /getName\(\s*["'`]\s*ItemPile Rescue Log\s*["'`]\s*\)/i,
  /claude-loot-rescue/,
  // SkillList: macro owns it, eval stays out
  /qT0K8p3N4jMuPcP9/,
  /getName\(\s*["'`]\s*SkillList\s*["'`]\s*\)/i,
  // World Travel Log family: Journey/Wilds macros own it
  /zV2mxKvnDWcGqi9F/,
  /getName\(\s*["'`]\s*World Travel Log:/i,
];

// Deletes - the most destructive class, always double-confirm.
const DESTRUCTIVE = [
  /\bdelete(?:Documents|EmbeddedDocuments)?\s*\(/,
  /\.\s*delete\s*\(/,
  /\b(?:Actor|Item|Scene|JournalEntry|JournalEntryPage|Macro|RollTable|Playlist|PlaylistSound|Folder|Token|TokenDocument|ActiveEffect|Combat|Combatant|User|Cards|Card|Wall|Tile|Drawing|MeasuredTemplate|Note)\s*\.\s*delete/,
];

// Everything else that changes state - single confirm.
const MUTATING = [
  /\b(?:create|update)(?:Documents|EmbeddedDocuments)?\s*\(/,
  /\.\s*(?:create|update)\s*\(/,
  /\b(?:Actor|Item|Scene|JournalEntry|JournalEntryPage|Macro|RollTable|Playlist|PlaylistSound|Folder|Token|TokenDocument|ActiveEffect|Combat|Combatant|ChatMessage|User|Cards|Card|AmbientLight|AmbientSound|Wall|Tile|Drawing|MeasuredTemplate|Note)\s*\.\s*(?:create|update)/,
  /\.\s*(?:set|unset)Flag\s*\(/,
  /\.\s*updateSource\s*\(/,
  /game\s*\.\s*settings\s*\.\s*set\s*\(/,
  /\.\s*(?:applyDelta|rollDamage|toggleEffect|toggleStatusEffect|toggleActiveEffect|addStatusEffect)\s*\(/,
  // HP writes matched; bare attributes.hp reads are not
  /\.\s*(?:applyDamage|modifyTokenAttribute|kill)\s*\(/,
  /\.\s*(?:hp|hitPoints|currentHP)\b[\s\S]{0,24}=[^=]/,
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
  if ((m = firstMatch(c, DESTRUCTIVE)))     return { category: 'destructive', ...m };
  if ((m = firstMatch(c, MUTATING)))        return { category: 'mutating', ...m };
  return { category: 'read' };
}

// Severity ordering: relay takes the stricter verdict
export const SEVERITY = { read: 0, mutating: 1, destructive: 2, 'db-journal': 3 };
