/* Read journal pages. */

export async function handleQueryJournal(params) {
  const { journalId, name, pageId, pageName } = params || {};
  let entry = null;
  if (journalId) entry = game.journal.get(journalId); // id lookup first
  else if (name) entry = game.journal.getName(name); // name lookup second
  else throw new Error('query.journal requires journalId or name'); // neither throws
  if (!entry) throw new Error(`journal not found: ${journalId || name}`); // unknown journal throws

  const allPages = [...entry.pages.values()];
  let pages = allPages;
  if (pageId) pages = allPages.filter((p) => p.id === pageId); // page id filters pages
  else if (pageName) pages = allPages.filter((p) => p.name === pageName); // page name filters pages

  return {
    journalId: entry.id,
    name: entry.name,
    pageCount: allPages.length,
    pages: pages.map((p) => ({ // one row per journal page
      id: p.id,
      name: p.name,
      type: p.type,
      content: p.text?.content ?? p.src ?? null,
    })),
  };
}
