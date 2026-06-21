// eval handler (DESIGN §7) — runs JS in the GM client context so Claude Code
// can inspect anything the GM sees: actors, items, scenes, tiles, compendia,
// folders, macros, playlists, tables, settings.
//
// This handler is full power by design (it's the debug channel, human-in-loop
// per DESIGN §4.2). The READ-ONLY discipline for this stage is enforced
// upstream: the relay's eval-guard refuses mutating/destructive code before it
// ever reaches here. Don't add a second, weaker guard in here — keep the gate
// in one auditable place.
//
// `code` is treated as an async function body: use `return` to produce a
// value and `await` freely (compendium reads are async). Result is serialized
// with depth/size caps + a circular guard so a stray `return game.actors`
// can't dump megabytes into the chat.

const CAPS = { maxDepth: 8, maxArray: 500, maxString: 25_000, maxKeys: 300 };

export async function handleEval({ code, awaitResult, captureConsole } = {}, ctx = {}) {
  if (typeof code !== 'string' || !code.trim()) {
    const e = new Error('eval: `code` must be a non-empty string');
    e.code = -32602;
    throw e;
  }

  // Console-capture mode (Feature 1): collect everything this execution prints
  // or throws and return it WITH the result instead of throwing, so a debug
  // snippet's logs/errors survive even when it fails. Stateless — each call is
  // independent. Reuses the existing LogTap; capped so a noisy loop can't flood.
  const capture = !!captureConsole;
  const lines = [];
  let unsub = null;
  if (capture && ctx.logTap?.subscribe) {
    unsub = ctx.logTap.subscribe(null, (entry) => {
      if (lines.length < 500) {
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
    // (new Function(...))() — not raw eval — so user code can't see or clobber
    // this handler's scope. Wrapped in an async IIFE for return + await.
    runner = new Function('"use strict"; return (async () => {\n' + code + '\n})();');
  } catch (err) {
    try { unsub?.(); } catch (e) {}
    if (capture) return withConsole({ ok: false, thrown: { message: `syntax error — ${err.message}` } });
    const e = new Error(`eval: syntax error — ${err.message}`);
    e.code = -33002;
    throw e;
  }

  try {
    let result = await runner();
    // awaitResult (default true): if the returned value is itself a thenable
    // (e.g. `return pack.getDocuments()` un-awaited), resolve it too.
    if (awaitResult !== false && result && typeof result.then === 'function') {
      result = await result;
    }
    return withConsole({ ok: true, valueType: classify(result), value: serialize(result, CAPS) });
  } catch (err) {
    if (capture) {
      return withConsole({
        ok: false,
        thrown: { message: String(err?.message || err), stack: (err?.stack || '').slice(0, 4000) },
      });
    }
    const e = new Error(`eval: execution threw — ${err?.message || String(err)}`);
    e.code = -33002;
    e.data = { stack: (err?.stack || '').slice(0, 4000) };
    throw e;
  } finally {
    try { unsub?.(); } catch (e) {}
  }
}

function classify(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t !== 'object') return t;
  return v?.constructor?.name || 'object';
}

// Recursive, depth-limited, circular-safe. Foundry Documents collapse via
// toObject(); Collections/Maps/Sets become arrays. Truncations are marked so
// Claude knows to re-query more narrowly instead of trusting a clipped blob.
function serialize(value, caps) {
  const seen = new WeakSet();
  const { maxDepth, maxArray, maxString, maxKeys } = caps;

  function walk(v, depth) {
    if (v === null) return null;
    const t = typeof v;
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'undefined') return '[undefined]';
    if (t === 'bigint') return `${v}n`;
    if (t === 'symbol') return v.toString();
    if (t === 'function') return `[Function: ${v.name || 'anonymous'}]`;
    if (t === 'string') {
      return v.length > maxString ? `${v.slice(0, maxString)}…[+${v.length - maxString} chars]` : v;
    }
    if (v instanceof Date) return v.toISOString();
    if (v instanceof RegExp) return v.toString();
    if (v instanceof Error) return { __error: v.name, message: v.message, stack: (v.stack || '').slice(0, 2000) };
    if (depth >= maxDepth) return `[max depth: ${v?.constructor?.name || typeof v}]`;
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    try {
      if (typeof v.toObject === 'function' && v.documentName) {
        let obj;
        try { obj = v.toObject(false); } catch { obj = { id: v.id, name: v.name }; }
        const out = walk(obj, depth + 1);
        if (out && typeof out === 'object' && !Array.isArray(out)) {
          out.__doc = v.documentName;
          if (v.uuid) out.__uuid = v.uuid;
        }
        return out;
      }
      if (v instanceof Set) return walk([...v], depth);
      if (v instanceof Map) return walk([...v.entries()], depth);
      // Foundry Collection / EmbeddedCollection (Map-like, iterable values)
      if (!Array.isArray(v) && typeof v.values === 'function' && typeof v.size === 'number') {
        return walk([...v.values()], depth);
      }
      if (Array.isArray(v)) {
        const out = v.slice(0, maxArray).map((e) => walk(e, depth + 1));
        if (v.length > maxArray) out.push(`…[+${v.length - maxArray} more of ${v.length}]`);
        return out;
      }
      const keys = Object.keys(v);
      const out = {};
      let n = 0;
      for (const k of keys) {
        if (n >= maxKeys) { out.__truncatedKeys = keys.length - maxKeys; break; }
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
