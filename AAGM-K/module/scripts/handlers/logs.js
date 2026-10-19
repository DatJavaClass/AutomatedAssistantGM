/* Single replaceable log subscription. */

let activeUnsub = null;

export async function handleLogsSubscribe(params, ctx) {
  if (!ctx.logTap) throw new Error('log tap not installed'); // missing tap throws
  if (activeUnsub) { // prior subscription dropped first
    activeUnsub();
    activeUnsub = null;
  }
  const levels = Array.isArray(params?.levels) && params.levels.length ? new Set(params.levels) : null;
  let filterRe = null;
  if (params?.filter) { // filter given compiles regex
    try { filterRe = new RegExp(params.filter); }
    catch (err) { throw new Error(`invalid filter regex: ${err.message}`); }
  }

  const filterFn = (entry) => {
    if (levels && !levels.has(entry.level)) return false; // unlisted level dropped
    if (filterRe && !filterRe.test(entry.message)) return false; // unmatched message dropped
    return true;
  };

  activeUnsub = ctx.logTap.subscribe(filterFn, (entry) => {
    ctx.send({ jsonrpc: '2.0', method: 'logs.entry', params: entry });
  });

  return { ok: true };
}

export async function handleLogsUnsubscribe() {
  if (activeUnsub) { // active subscription cleared
    activeUnsub();
    activeUnsub = null;
  }
  return { ok: true };
}
