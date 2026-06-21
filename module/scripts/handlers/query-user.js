// query.user handler — list users (or one user). Returns online status and
// character ownership.

export async function handleQueryUser(params) {
  const { userId } = params || {};
  if (userId) {
    const u = game.users.get(userId);
    if (!u) throw new Error(`user not found: ${userId}`);
    return { user: serialize(u) };
  }
  return { users: game.users.map(serialize) };
}

function serialize(u) {
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    isGM: u.isGM,
    active: u.active,
    characterId: u.character?.id ?? null,
    characterName: u.character?.name ?? null,
    color: u.color,
  };
}
