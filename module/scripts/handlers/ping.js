/* Report bridge liveness. */

export async function handlePing() {
  return {
    pong: true,
    serverTime: new Date().toISOString(),
    foundryServerTime: game.time?.serverTime ?? null,
    worldTime: game.time?.worldTime ?? null,
    worldId: game.world?.id ?? null,
    userId: game.user?.id ?? null,
  };
}
