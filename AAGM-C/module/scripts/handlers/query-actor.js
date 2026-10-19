// Actor read, optional field paths.

export async function handleQueryActor(params) {
  const { actorId, fields } = params || {};
  if (!actorId) throw new Error('query.actor requires actorId'); // missing id throws
  const actor = game.actors.get(actorId);
  if (!actor) throw new Error(`actor not found: ${actorId}`); // unknown actor throws
  const full = actor.toObject();
  if (!fields || !fields.length) return { actorId, data: full }; // no fields returns full data
  const data = {};
  for (const path of fields) { // each path copied into data
    data[path] = foundry.utils.getProperty(full, path);
  }
  return { actorId, data };
}
