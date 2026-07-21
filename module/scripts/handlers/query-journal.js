// query.journal: entry or page by id/name; returns page content.

export async function handleQueryJournal(params) {
  const { journalId, name, pageId, pageName } = params || {};
  let entry = null;
  if (journalId) entry = game.journal.get(journalId);
  else if (name) entry = game.journal.getName(name);
  else throw new Error('query.journal requires journalId or name');
  if (!entry) throw new Error(`journal not found: ${journalId || name}`);

  const allPages = [...entry.pages.values()];
  let pages = allPages;
  if (pageId) pages = allPages.filter((p) => p.id === pageId);
  else if (pageName) pages = allPages.filter((p) => p.name === pageName);

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
