// query.scene handler — scene metadata + lightweight token list. Defaults to
// the active scene if no sceneId is given.

export async function handleQueryScene(params) {
  const { sceneId } = params || {};
  const scene = sceneId ? game.scenes.get(sceneId) : game.scenes.active;
  if (!scene) throw new Error(`scene not found: ${sceneId || '<active>'}`);

  const tokens = scene.tokens?.map((t) => ({
    id: t.id,
    name: t.name,
    x: t.x,
    y: t.y,
    actorId: t.actorId,
    hidden: t.hidden,
    disposition: t.disposition,
  })) || [];

  return {
    sceneId: scene.id,
    name: scene.name,
    active: scene.active,
    width: scene.width,
    height: scene.height,
    grid: scene.grid?.size ?? scene.grid,
    background: scene.background?.src || null,
    tokenCount: tokens.length,
    tokens,
    wallCount: scene.walls?.size ?? 0,
    lightingDarkness: scene.darkness,
  };
}
