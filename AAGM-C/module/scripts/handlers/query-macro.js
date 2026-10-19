// Macro source and metadata read.

export async function handleQueryMacro(params) {
  const { macroId, name } = params || {};
  let macro = null;
  if (macroId) macro = game.macros.get(macroId); // id lookup first
  else if (name) macro = game.macros.getName(name); // name lookup second
  else throw new Error('query.macro requires macroId or name'); // neither given throws
  if (!macro) throw new Error(`macro not found: ${macroId || name}`); // unknown macro throws

  return {
    macroId: macro.id,
    name: macro.name,
    type: macro.type,
    scope: macro.scope,
    author: macro.author?.id ?? null,
    authorName: macro.author?.name ?? null,
    img: macro.img,
    command: macro.command,
  };
}
