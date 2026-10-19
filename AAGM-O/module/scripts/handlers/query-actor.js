/* Read actor data. */

export async function handleQueryActor(params) {
  const { actorId, fields } = params || {};
  if (!actorId) throw new Error('query.actor requires actorId'); // no id throws, id continues
  const actor = game.actors.get(actorId);
  if (!actor) throw new Error(`actor not found: ${actorId}`); // unknown actor throws
  const full = actor.toObject();
  if (!fields || !fields.length) return { actorId, data: full }; // no fields returns full actor
  const data = {};
  for (const path of fields) { // each field read, ends at last
    data[path] = foundry.utils.getProperty(full, path);
  }
  return { actorId, data };
}
