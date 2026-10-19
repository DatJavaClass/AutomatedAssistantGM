// Eval handler: async body, capped serializer.

const CAPS = { maxDepth: 8, maxArray: 500, maxString: 25_000, maxKeys: 300 };

export async function handleEval({ code, awaitResult, captureConsole } = {}, ctx = {}) {
  if (typeof code !== 'string' || !code.trim()) { // blank code throws -32602
    const e = new Error('eval: `code` must be a non-empty string');
    e.code = -32602;
    throw e;
  }

  // Console capture: logs/errors survive failure instead of throwing
  const capture = !!captureConsole;
  const lines = [];
  let unsub = null;
  if (capture && ctx.logTap?.subscribe) { // capture on subscribes tap
    unsub = ctx.logTap.subscribe(null, (entry) => {
      if (lines.length < 500) { // cap 500 lines, extras dropped
        lines.push({
          level: entry.level,
          ts: entry.timestamp,
          source: entry.source,
          msg: String(entry.message ?? '').slice(0, 4000),
        });
      }
    });
  }
  const withConsole = (extra) => (capture ? { ...extra, console: lines } : extra);

  let runner;
  try {
    // new Function isolates scope; not raw eval
    runner = new Function('"use strict"; return (async () => {\n' + code + '\n})();');
  } catch (err) {
    try { unsub?.(); } catch (e) {}
    if (capture) return withConsole({ ok: false, thrown: { message: `syntax error - ${err.message}` } }); // capture returns syntax error object
    const e = new Error(`eval: syntax error - ${err.message}`);
    e.code = -33002;
    throw e;
  }

  try {
    let result = await runner();
    // awaitResult (default true) also awaits a returned thenable
    // (e.g. `return pack.getDocuments()` un-awaited), resolve it too.
    if (awaitResult !== false && result && typeof result.then === 'function') { // thenable result awaited once more
      result = await result;
    }
    return withConsole({ ok: true, valueType: classify(result), value: serialize(result, CAPS) });
  } catch (err) {
    if (capture) { // capture returns thrown object
      return withConsole({
        ok: false,
        thrown: { message: String(err?.message || err), stack: (err?.stack || '').slice(0, 4000) },
      });
    }
    const e = new Error(`eval: execution threw - ${err?.message || String(err)}`);
    e.code = -33002;
    e.data = { stack: (err?.stack || '').slice(0, 4000) };
    throw e;
  } finally {
    try { unsub?.(); } catch (e) {}
  }
}

function classify(v) {
  if (v === null) return 'null'; // null named null
  if (Array.isArray(v)) return 'array'; // array named array
  const t = typeof v;
  if (t !== 'object') return t; // primitive returns typeof
  return v?.constructor?.name || 'object';
}

// Truncated results are marked so Claude re-queries narrower
function serialize(value, caps) {
  const seen = new WeakSet();
  const { maxDepth, maxArray, maxString, maxKeys } = caps;

  function walk(v, depth) {
    if (v === null) return null; // null passes through
    const t = typeof v;
    if (t === 'number' || t === 'boolean') return v; // number, boolean pass through
    if (t === 'undefined') return '[undefined]'; // undefined becomes marker string
    if (t === 'bigint') return `${v}n`; // bigint gets n suffix
    if (t === 'symbol') return v.toString(); // symbol becomes its text
    if (t === 'function') return `[Function: ${v.name || 'anonymous'}]`; // function becomes name tag
    if (t === 'string') { // over cap truncated with count
      return v.length > maxString ? `${v.slice(0, maxString)}…[+${v.length - maxString} chars]` : v;
    }
    if (v instanceof Date) return v.toISOString(); // date becomes ISO string
    if (v instanceof RegExp) return v.toString(); // regex becomes source text
    if (v instanceof Error) return { __error: v.name, message: v.message, stack: (v.stack || '').slice(0, 2000) }; // error becomes name, message, stack
    if (depth >= maxDepth) return `[max depth: ${v?.constructor?.name || typeof v}]`; // too deep returns depth marker
    if (seen.has(v)) return '[Circular]'; // cycle returns circular marker
    seen.add(v);
    try {
      if (typeof v.toObject === 'function' && v.documentName) { // document serialized via toObject
        let obj;
        try { obj = v.toObject(false); } catch { obj = { id: v.id, name: v.name }; }
        const out = walk(obj, depth + 1);
        if (out && typeof out === 'object' && !Array.isArray(out)) { // plain object gains doc tags
          out.__doc = v.documentName;
          if (v.uuid) out.__uuid = v.uuid; // uuid tag added when present
        }
        return out;
      }
      if (v instanceof Set) return walk([...v], depth); // set walks as array
      if (v instanceof Map) return walk([...v.entries()], depth); // map walks entry pairs
      // Foundry Collection / EmbeddedCollection (Map-like, iterable values)
      if (!Array.isArray(v) && typeof v.values === 'function' && typeof v.size === 'number') { // map like collection walks values
        return walk([...v.values()], depth);
      }
      if (Array.isArray(v)) { // array capped at maxArray
        const out = v.slice(0, maxArray).map((e) => walk(e, depth + 1));
        if (v.length > maxArray) out.push(`…[+${v.length - maxArray} more of ${v.length}]`); // overflow note appended
        return out;
      }
      const keys = Object.keys(v);
      const out = {};
      let n = 0;
      for (const k of keys) { // each key walked until cap
        if (n >= maxKeys) { out.__truncatedKeys = keys.length - maxKeys; break; } // key cap marks truncation, exits loop
        try { out[k] = walk(v[k], depth + 1); } catch (e) { out[k] = `[getter threw: ${e?.message || e}]`; }
        n++;
      }
      return out;
    } finally {
      seen.delete(v);
    }
  }

  return walk(value, 0);
}
