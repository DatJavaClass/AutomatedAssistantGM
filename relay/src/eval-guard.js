/* Eval classifier. Gates remain authoritative. */

const DB_JOURNAL_DENY = [
  /yB5klzKycb6bTbcy/, // NPC Register (+ Mail/Mailbox Index page)
  /getName\(\s*["'`]\s*NPC Register\s*["'`]\s*\)/i,
  /getName\(\s*["'`]\s*(?:Mail(?:box)? Index)\s*["'`]\s*\)/i,
  /\brunManaged\b/, // RUN's managed-page flag
  /REPLACE_WITH_RESCUE_LOG_JOURNAL_ID/,
  /getName\(\s*["'`]\s*ItemPile Rescue Log\s*["'`]\s*\)/i,
  /aagm-o-loot-rescue/,
  /qT0K8p3N4jMuPcP9/,
  /getName\(\s*["'`]\s*SkillList\s*["'`]\s*\)/i,
  /zV2mxKvnDWcGqi9F/,
  /getName\(\s*["'`]\s*World Travel Log:/i,
];

/* Deletes require double confirmation. */
const DESTRUCTIVE = [
  /\bdelete(?:Documents|EmbeddedDocuments)?\s*\(/,
  /\.\s*delete\s*\(/,
  /\b(?:Actor|Item|Scene|JournalEntry|JournalEntryPage|Macro|RollTable|Playlist|PlaylistSound|Folder|Token|TokenDocument|ActiveEffect|Combat|Combatant|User|Cards|Card|Wall|Tile|Drawing|MeasuredTemplate|Note)\s*\.\s*delete/,
];

/* Other writes require confirmation. */
const MUTATING = [
  /\b(?:create|update)(?:Documents|EmbeddedDocuments)?\s*\(/,
  /\.\s*(?:create|update)\s*\(/,
  /\b(?:Actor|Item|Scene|JournalEntry|JournalEntryPage|Macro|RollTable|Playlist|PlaylistSound|Folder|Token|TokenDocument|ActiveEffect|Combat|Combatant|ChatMessage|User|Cards|Card|AmbientLight|AmbientSound|Wall|Tile|Drawing|MeasuredTemplate|Note)\s*\.\s*(?:create|update)/,
  /\.\s*(?:set|unset)Flag\s*\(/,
  /\.\s*updateSource\s*\(/,
  /game\s*\.\s*settings\s*\.\s*set\s*\(/,
  /\.\s*(?:applyDelta|rollDamage|toggleEffect|toggleStatusEffect|toggleActiveEffect|addStatusEffect)\s*\(/,
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

/* Higher values win. */
export const SEVERITY = { read: 0, mutating: 1, destructive: 2, 'db-journal': 3 };
