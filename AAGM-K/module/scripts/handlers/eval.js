/* Capped GM-client evaluator. */

const CAPS = { maxDepth: 8, maxArray: 500, maxString: 25_000, maxKeys: 300 };

export async function handleEval({ code, awaitResult, captureConsole } = {}, ctx = {}) {
  if (typeof code !== 'string' || !code.trim()) { // invalid code throws, valid continues
    const e = new Error('eval: `code` must be a non-empty string');
    e.code = -32602;
    throw e;
  }

  /* Capture console output when requested. */
  const capture = !!captureConsole;
  const lines = [];
  let unsub = null;
  if (capture && ctx.logTap?.subscribe) { // capture on subscribes to log
    unsub = ctx.logTap.subscribe(null, (entry) => {
      if (lines.length < 500) { // under cap stores line
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
    /* Isolate execution scope. */
    runner = new Function('"use strict"; return (async () => {\n' + code + '\n})();');
  } catch (err) {
    try { unsub?.(); } catch {}
    if (capture) return withConsole({ ok: false, thrown: { message: `syntax error: ${err.message}` } }); // capture returns result, else throws
    const e = new Error(`eval: syntax error: ${err.message}`);
    e.code = -33002;
    throw e;
  }

  try {
    let result = await runner();
    /* Resolve returned promises by default. */
    if (awaitResult !== false && result && typeof result.then === 'function') { // thenable awaited, else kept
      result = await result;
    }
    return withConsole({ ok: true, valueType: classify(result), value: serialize(result, CAPS) });
  } catch (err) {
    if (capture) { // capture returns failure, else throws
      return withConsole({
        ok: false,
        thrown: { message: String(err?.message || err), stack: (err?.stack || '').slice(0, 4000) },
      });
    }
    const e = new Error(`eval: execution threw: ${err?.message || String(err)}`);
    e.code = -33002;
    e.data = { stack: (err?.stack || '').slice(0, 4000) };
    throw e;
  } finally {
    try { unsub?.(); } catch {}
  }
}

function classify(v) {
  if (v === null) return 'null'; // null named directly
  if (Array.isArray(v)) return 'array'; // arrays named directly
  const t = typeof v;
  if (t !== 'object') return t; // primitives return typeof
  return v?.constructor?.name || 'object';
}

/* Serialize with explicit caps. */
function serialize(value, caps) {
  const seen = new WeakSet();
  const { maxDepth, maxArray, maxString, maxKeys } = caps;

  function walk(v, depth) {
    if (v === null) return null; // null passes through
    const t = typeof v;
    if (t === 'number' || t === 'boolean') return v; // number and boolean pass through
    if (t === 'undefined') return '[undefined]'; // undefined becomes marker
    if (t === 'bigint') return `${v}n`; // bigint gets n suffix
    if (t === 'symbol') return v.toString(); // symbol stringified
    if (t === 'function') return `[Function: ${v.name || 'anonymous'}]`; // function becomes named marker
    if (t === 'string') { // long strings truncated with count
      return v.length > maxString ? `${v.slice(0, maxString)}…[+${v.length - maxString} chars]` : v;
    }
    if (v instanceof Date) return v.toISOString(); // dates become ISO strings
    if (v instanceof RegExp) return v.toString(); // regex becomes source string
    if (v instanceof Error) return { __error: v.name, message: v.message, stack: (v.stack || '').slice(0, 2000) }; // errors keep name, message, stack
    if (depth >= maxDepth) return `[max depth: ${v?.constructor?.name || typeof v}]`; // depth cap returns marker
    if (seen.has(v)) return '[Circular]'; // cycle returns marker
    seen.add(v);
    try {
      if (typeof v.toObject === 'function' && v.documentName) { // documents serialized via toObject
        let obj;
        try { obj = v.toObject(false); } catch { obj = { id: v.id, name: v.name }; }
        const out = walk(obj, depth + 1);
        if (out && typeof out === 'object' && !Array.isArray(out)) { // plain object gets doc tags
          out.__doc = v.documentName;
          if (v.uuid) out.__uuid = v.uuid; // uuid tag added when present
        }
        return out;
      }
      if (v instanceof Set) return walk([...v], depth); // sets become arrays
      if (v instanceof Map) return walk([...v.entries()], depth); // maps become entry arrays
      /* Serialize Foundry collections. */
      if (!Array.isArray(v) && typeof v.values === 'function' && typeof v.size === 'number') { // collections become value arrays
        return walk([...v.values()], depth);
      }
      if (Array.isArray(v)) { // arrays capped then walked
        const out = v.slice(0, maxArray).map((e) => walk(e, depth + 1));
        if (v.length > maxArray) out.push(`…[+${v.length - maxArray} more of ${v.length}]`); // over cap appends overflow note
        return out;
      }
      const keys = Object.keys(v);
      const out = {};
      let n = 0;
      for (const k of keys) { // each key, cap breaks loop
        if (n >= maxKeys) { out.__truncatedKeys = keys.length - maxKeys; break; } // cap reached records count, exits
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
