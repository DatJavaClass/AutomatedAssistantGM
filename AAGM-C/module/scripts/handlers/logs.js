// Console log subscribe and unsubscribe.

let activeUnsub = null;

export async function handleLogsSubscribe(params, ctx) {
  if (!ctx.logTap) throw new Error('log tap not installed'); // no tap throws
  if (activeUnsub) { // old subscription dropped first
    activeUnsub();
    activeUnsub = null;
  }
  const levels = Array.isArray(params?.levels) && params.levels.length ? new Set(params.levels) : null;
  let filterRe = null;
  if (params?.filter) { // filter compiled, bad regex throws
    try { filterRe = new RegExp(params.filter); }
    catch (err) { throw new Error(`invalid filter regex: ${err.message}`); }
  }

  const filterFn = (entry) => {
    if (levels && !levels.has(entry.level)) return false; // level mismatch rejected
    if (filterRe && !filterRe.test(entry.message)) return false; // regex miss rejected
    return true;
  };

  activeUnsub = ctx.logTap.subscribe(filterFn, (entry) => {
    ctx.send({ jsonrpc: '2.0', method: 'logs.entry', params: entry });
  });

  return { ok: true };
}

export async function handleLogsUnsubscribe() {
  if (activeUnsub) { // active subscription dropped
    activeUnsub();
    activeUnsub = null;
  }
  return { ok: true };
}
