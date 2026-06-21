// logs.subscribe / logs.unsubscribe handlers. Once subscribed, the bridge
// emits `logs.entry` notifications (no id) until unsubscribed. Only one
// subscription per bridge connection in Phase 1; calling subscribe again
// replaces the existing one.

let activeUnsub = null;

export async function handleLogsSubscribe(params, ctx) {
  if (!ctx.logTap) throw new Error('log tap not installed');
  if (activeUnsub) {
    activeUnsub();
    activeUnsub = null;
  }
  const levels = Array.isArray(params?.levels) && params.levels.length ? new Set(params.levels) : null;
  let filterRe = null;
  if (params?.filter) {
    try { filterRe = new RegExp(params.filter); }
    catch (err) { throw new Error(`invalid filter regex: ${err.message}`); }
  }

  const filterFn = (entry) => {
    if (levels && !levels.has(entry.level)) return false;
    if (filterRe && !filterRe.test(entry.message)) return false;
    return true;
  };

  activeUnsub = ctx.logTap.subscribe(filterFn, (entry) => {
    ctx.send({ jsonrpc: '2.0', method: 'logs.entry', params: entry });
  });

  return { ok: true };
}

export async function handleLogsUnsubscribe() {
  if (activeUnsub) {
    activeUnsub();
    activeUnsub = null;
  }
  return { ok: true };
}
