# AAGM Plug-in API 1.0

> **Status: specification, 2026-09-24.** This is the contract every member of the AAGM family (AAGM-C, AAGM-O, AAGM-G, AAGM-K) implements for plug-ins. The `foundry_plugin` tool described here ships with each member's next release; until a member ships it, its plug-ins are reachable through that member's eval tool exactly as the [alpha contract](AAGM-C/Docs/PLUGIN_API_ALPHA.md) describes. Nothing in this document depends on the hosting service: the plug-in lives in the world as a macro, the checks live in the relay on the GM's machine.

## 1. What a plug-in is

A plug-in is a **world Script macro** with an exact name. It never touches the relay or the module. The bridge is the transport; the macro is the endpoint. It runs on the GM client with the whole Foundry API available, and every write it makes is captured by the member's Rollback Point before it lands, so the GM can undo it from the chat box.

A plug-in is **self describing**. Run with no arguments it does not act; it returns its manifest. That one rule is what makes the API formal: the relay learns what a plug-in accepts and what it is allowed to write from the plug-in itself, not from a document, and refuses calls that do not match.

## 2. The manifest

A bare run (`macro.execute()` with no scope) returns:

```js
{
  api: "aagm-plugin/1.0",     // this contract
  name: "Claude Item Forge",  // exact macro name
  version: "1.4.0",           // the plug-in's own version
  description: "Builds a pf1 item from a spec and files it into a compendium.",
  args: {                     // JSON Schema, draft 2020-12, for the scope object
    type: "object",
    required: ["item", "pack"],
    properties: {
      item: { type: "object" },
      pack: { type: "string", pattern: "^[a-z0-9-]+\\.[a-z0-9-]+$" }
    },
    additionalProperties: false
  },
  writes: ["Item"],           // document types the plug-in may create, update or delete
  modes: ["run", "read"]      // optional; "read" = a read only mode exists
}
```

Rules:

- `api` is required and must start with `aagm-plugin/1.`. A bare run that returns anything else is not a plug-in; the relay refuses `foundry_plugin` for it.
- `args` is a JSON Schema. The relay validates the caller's scope against it before anything reaches Foundry. `additionalProperties: false` is strongly recommended.
- `writes` is the allow list. If the Rollback Point for a call captures a document type that is not listed, the call is rolled back at once and reported as `{ ok:false, error:"wrote outside declared scope: Actor" }`. An empty list means read only.
- A bare run must be side effect free. It may read the world to fill defaults; it must not create, update or delete anything.

## 3. The call

Members expose one tool:

```
foundry_plugin { name, args, tabId? }
```

The relay:

1. Reads the manifest through one read eval on the first call for that name in the session and caches it (`refresh:true` on the call re-reads it).
2. Validates `args` against `manifest.args`. A failure returns `{ ok:false, error, schemaPath }` and touches nothing.
3. Opens a Rollback Point labeled `<name>: <one line from args>` and runs, in one recorded eval:
   ```js
   return await game.macros.getName(name).execute(args);
   ```
4. Checks the point's captured document types against `writes`. Out of scope means an immediate rollback of that point and an error result.
5. Returns the plug-in's result with `rollbackPoint: { id, captured }` attached.

Under a member's legacy confirm policy the same call renders that member's Approve/Deny card instead of a point; the manifest checks still run first.

## 4. The result

A plug-in returns one object:

| Field | Type | Meaning |
|---|---|---|
| `ok` | boolean | required |
| `error` | string | required when `ok` is false, plain English, shown to the GM |
| `uuid` or `uuids` | string or array | what was created or changed, when there is such a thing |
| anything else | | plug-in specific, kept small (the relay caps result size) |

Throwing is allowed; the relay turns a throw into `{ ok:false, error }` and the point still holds whatever was captured before the throw, so it can be rolled back.

## 5. Read mode

A plug-in that reports `modes: ["run", "read"]` accepts `{ mode:"read", ...args }` and returns state without writing. Members route read mode calls through their read path (no point, no card). A read mode that writes anything is a contract violation; the recorder will catch it as an out of scope write.

## 6. Naming and versioning

- Exact macro names, unique in the world. Members match by name only.
- `version` follows the plug-in's own scheme. A manifest change that adds a required argument or a new `writes` entry is a major change; say so in the plug-in's own notes.
- The four shipped plug-ins in [`AAGM-C/plugins/`](AAGM-C/plugins) are the reference implementations. Their names carry "Claude" for history; they run unchanged under every member.

## 7. What the API does not do

- It does not sandbox the macro. A plug-in has the GM client's full power; the manifest limits what the relay lets through and what the rollback keeps, not what JavaScript can do. Install plug-ins you have read.
- It does not reach files. Uploads to the host, module side effects outside documents, and edits made in another window are outside the Rollback Point.
- It does not replace eval. A GM who wants raw eval keeps it; the member's write policy decides whether raw writes are allowed at all.

## 8. Writing one

```js
// Minimal plug-in: rename an actor.
const MANIFEST = {
  api: "aagm-plugin/1.0", name: "Rename Actor", version: "1.0.0",
  description: "Renames one actor by uuid.",
  args: { type: "object", required: ["uuid", "name"],
          properties: { uuid: { type: "string" }, name: { type: "string", minLength: 1 } },
          additionalProperties: false },
  writes: ["Actor"], modes: ["run"]
};
if (!scope || !Object.keys(scope).length) return MANIFEST; // bare run
const actor = await fromUuid(scope.uuid);
if (!actor || actor.documentName !== "Actor") return { ok: false, error: "not an actor uuid" };
await actor.update({ name: scope.name });
return { ok: true, uuid: actor.uuid };
```

Paste it as a world Script macro named exactly `Rename Actor`, call `foundry_plugin { name:"Rename Actor", args:{ uuid, name } }`, roll it back from the box if you change your mind.

## 9. Conformance

A member claims 1.0 conformance when its `foundry_plugin` tool does steps 1 to 5 of section 3, refuses non manifests, validates against `args`, enforces `writes` through its Rollback Point, and documents the tool in its README. Members list their conformance version in their README's tool section.
