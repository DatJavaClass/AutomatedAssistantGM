function folderPath(folder) {
  const parts = [], seen = new Set();
  let current = folder;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(current.name);
    current = current.folder || null;
  }
  return parts.join('/');
}

export async function handleMirrorList({ name } = {}) {
  if (!game.user?.isGM) throw new Error('Macro Mirror is GM-only');
  const wanted = String(name || '').trim().toLocaleLowerCase();
  const macros = Array.from(game.macros || []).filter((macro) => !wanted || macro.name.toLocaleLowerCase() === wanted);
  return {
    macros: macros.map((macro) => ({
      uuid: macro.uuid,
      name: macro.name,
      command: macro.command || '',
      folderPath: folderPath(macro.folder),
      img: macro.img || '',
    })),
  };
}

export async function handleMirrorRestore({ record } = {}) {
  if (!game.user?.isGM) throw new Error('Macro Mirror is GM-only');
  if (!record || typeof record.command !== 'string') throw new Error('invalid mirror record');
  const folder = await ensureFolder(record.folderPath);
  let macro = null;
  try { macro = await fromUuid(record.uuid); } catch {}
  if (macro?.documentName === 'Macro') {
    await macro.update({ command: record.command, img: record.img || macro.img, folder: folder?.id || null });
    return { restored: true, created: false, uuid: macro.uuid, name: macro.name };
  }
  macro = await Macro.create({
    name: record.name,
    type: 'script',
    scope: 'global',
    command: record.command,
    img: record.img || 'icons/svg/dice-target.svg',
    folder: folder?.id || null,
  });
  return { restored: true, created: true, uuid: macro.uuid, name: macro.name };
}

async function ensureFolder(path) {
  const parts = String(path || '').split('/').map((part) => part.trim()).filter(Boolean);
  let parent = null;
  for (const name of parts) {
    let folder = game.folders.find((candidate) =>
      candidate.type === 'Macro'
      && candidate.name === name
      && (candidate.folder?.id || candidate.folder || null) === (parent?.id || null));
    if (!folder) folder = await Folder.create({ name, type: 'Macro', folder: parent?.id || null });
    parent = folder;
  }
  return parent;
}
