/* Capped GM-client evaluator. */

const CAPS = { maxDepth: 8, maxArray: 500, maxString: 25_000, maxKeys: 300 };

export async function handleEval({ code, awaitResult, captureConsole } = {}, ctx = {}) {
  if (typeof code !== 'string' || !code.trim()) { // blank code throws, valid continues
    const e = new Error('eval: `code` must be a non-empty string');
    e.code = -32602;
    throw e;
  }

  /* Capture console output when requested. */
  const capture = !!captureConsole;
  const lines = [];
  let unsub = null;
  if (capture && ctx.logTap?.subscribe) { // capture and tap subscribe, else none
    unsub = ctx.logTap.subscribe(null, (entry) => {
      if (lines.length < 500) { // under 500 lines stored, else dropped
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
    try { unsub?.(); } catch {} // syntax failure cleanup first
    if (capture) return withConsole({ ok: false, thrown: { message: `syntax error: ${err.message}` } }); // capture returns result, else throws
    const e = new Error(`eval: syntax error: ${err.message}`);
    e.code = -33002;
    throw e;
  }

  try {
    let result = await runner();
    /* Resolve returned promises by default. */
    if (awaitResult !== false && result && typeof result.then === 'function') { // thenable awaited unless disabled
      result = await result;
    }
    return withConsole({ ok: true, valueType: classify(result), value: serialize(result, CAPS) });
  } catch (err) {
    if (capture) { // capture returns thrown, else throws
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
  if (v === null) return 'null'; // null named null
  if (Array.isArray(v)) return 'array'; // array named array
  const t = typeof v;
  if (t !== 'object') return t; // non object returns typeof
  return v?.constructor?.name || 'object';
}

/* Serialize with explicit caps. */
function serialize(value, caps) {
  const seen = new WeakSet();
  const { maxDepth, maxArray, maxString, maxKeys } = caps;

  function walk(v, depth) {
    if (v === null) return null; // null passes through
    const t = typeof v;
    if (t === 'number' || t === 'boolean') return v; // number or boolean passes through
    if (t === 'undefined') return '[undefined]'; // undefined marker
    if (t === 'bigint') return `${v}n`; // bigint suffixed n
    if (t === 'symbol') return v.toString(); // symbol stringified
    if (t === 'function') return `[Function: ${v.name || 'anonymous'}]`; // function labelled by name
    if (t === 'string') { // string truncated past cap
      return v.length > maxString ? `${v.slice(0, maxString)}…[+${v.length - maxString} chars]` : v;
    }
    if (v instanceof Date) return v.toISOString(); // date as ISO
    if (v instanceof RegExp) return v.toString(); // regex as source
    if (v instanceof Error) return { __error: v.name, message: v.message, stack: (v.stack || '').slice(0, 2000) }; // error as plain summary
    if (depth >= maxDepth) return `[max depth: ${v?.constructor?.name || typeof v}]`; // depth cap returns marker
    if (seen.has(v)) return '[Circular]'; // repeat reference marked circular
    seen.add(v);
    try {
      if (typeof v.toObject === 'function' && v.documentName) { // document converted via toObject
        let obj;
        try { obj = v.toObject(false); } catch { obj = { id: v.id, name: v.name }; } // toObject failure falls back to id, name
        const out = walk(obj, depth + 1);
        if (out && typeof out === 'object' && !Array.isArray(out)) { // plain object tagged with document
          out.__doc = v.documentName;
          if (v.uuid) out.__uuid = v.uuid; // uuid added when present
        }
        return out;
      }
      if (v instanceof Set) return walk([...v], depth); // set becomes array
      if (v instanceof Map) return walk([...v.entries()], depth); // map becomes entry array
      /* Serialize Foundry collections. */
      if (!Array.isArray(v) && typeof v.values === 'function' && typeof v.size === 'number') { // foundry collection becomes values
        return walk([...v.values()], depth);
      }
      if (Array.isArray(v)) { // array capped at maxArray
        const out = v.slice(0, maxArray).map((e) => walk(e, depth + 1));
        if (v.length > maxArray) out.push(`…[+${v.length - maxArray} more of ${v.length}]`); // overflow appends count marker
        return out;
      }
      const keys = Object.keys(v);
      const out = {};
      let n = 0;
      for (const k of keys) { // each key, key cap breaks
        if (n >= maxKeys) { out.__truncatedKeys = keys.length - maxKeys; break; } // key cap stops loop
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
