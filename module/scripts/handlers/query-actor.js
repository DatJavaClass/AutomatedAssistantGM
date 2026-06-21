// query.actor handler — returns actor data, optionally narrowed to specific
// dot-paths via the `fields` parameter.

export async function handleQueryActor(params) {
  const { actorId, fields } = params || {};
  if (!actorId) throw new Error('query.actor requires actorId');
  const actor = game.actors.get(actorId);
  if (!actor) throw new Error(`actor not found: ${actorId}`);
  const full = actor.toObject();
  if (!fields || !fields.length) return { actorId, data: full };
  const data = {};
  for (const path of fields) {
    data[path] = foundry.utils.getProperty(full, path);
  }
  return { actorId, data };
}
