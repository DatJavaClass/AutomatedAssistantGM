// ping handler — liveness check. Returns server time so the caller can verify
// it's the Foundry tab (not a stale relay or some intermediate cache) that
// answered.

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
