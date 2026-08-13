// query.macro handler — return a macro's source plus author/scope/type.
// Accepts either macroId or name (name resolves to the first match).

export async function handleQueryMacro(params) {
  const { macroId, name } = params || {};
  let macro = null;
  if (macroId) macro = game.macros.get(macroId);
  else if (name) macro = game.macros.getName(name);
  else throw new Error('query.macro requires macroId or name');
  if (!macro) throw new Error(`macro not found: ${macroId || name}`);

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
