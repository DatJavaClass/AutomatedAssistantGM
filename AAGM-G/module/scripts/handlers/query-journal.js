/* Read journal pages. */

import { isProtectedJournal } from '../rollback-recorder.js';

export async function handleQueryJournal(params) {
  const { journalId, name, pageId, pageName } = params || {};
  let entry = null;
  if (journalId) entry = game.journal.get(journalId); // id given looks up by id
  else if (name) entry = game.journal.getName(name); // name given looks up by name
  else throw new Error('query.journal requires journalId or name'); // neither given throws
  if (!entry) throw new Error(`journal not found: ${journalId || name}`); // journal missing throws
  if (isProtectedJournal(entry)) { // protected journal returns blocked
    return { blocked: true, reason: 'Refused: protected database journal. Use a sheet, compendium, or sidebar.' };
  }

  const allPages = [...entry.pages.values()];
  let pages = allPages;
  if (pageId) pages = allPages.filter((p) => p.id === pageId); // pageId filters by id
  else if (pageName) pages = allPages.filter((p) => p.name === pageName); // pageName filters by name

  return {
    journalId: entry.id,
    name: entry.name,
    pageCount: allPages.length,
    pages: pages.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      content: p.text?.content ?? p.src ?? null,
    })),
  };
}
