/* Read user status. */

export async function handleQueryUser(params) {
  const { userId } = params || {};
  if (userId) { // id given returns one user
    const u = game.users.get(userId);
    if (!u) throw new Error(`user not found: ${userId}`); // user missing throws
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
