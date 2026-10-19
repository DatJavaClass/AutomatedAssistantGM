/* Read actor data. */

export async function handleQueryActor(params) {
  const { actorId, fields } = params || {};
  if (!actorId) throw new Error('query.actor requires actorId'); // no actorId throws
  const actor = game.actors.get(actorId);
  if (!actor) throw new Error(`actor not found: ${actorId}`); // actor missing throws
  const full = actor.toObject();
  if (!fields || !fields.length) return { actorId, data: full }; // no fields returns full data
  const data = {};
  for (const path of fields) { // each path read, ends after last
    data[path] = foundry.utils.getProperty(full, path);
  }
  return { actorId, data };
}
