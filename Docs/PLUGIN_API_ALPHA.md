# AAGM Plug-in API - ALPHA

> **Status: ALPHA.** This documents the contract the shipped plug-ins
> (Claude Item Forge, Claude Foe Forge) are built on. It is stable enough to
> build against today, but names and surfaces may still shift before beta.

## How a plug-in fits

```
You (chat box) -> Claude (Code loop) -> relay (MCP + confirmation gate)
                                     -> foundry-bridge module (GM client)
                                     -> YOUR MACRO
```

A plug-in is a **world Script macro**. It never touches the relay or the
module: the bridge is the transport, your macro is the endpoint. The operator
pastes it into their world; Claude invokes it through the bridge's gated
`eval`, and every mutating call renders an **Approve/Deny card** in the chat
box before it runs. You get the whole Foundry API on the GM client; the
operator keeps the veto.

## The contract

**Naming + invocation.** Exact-name Script macro. Claude calls it in ONE
gated eval, with intent declared:

```js
// what Claude sends through foundry_eval (intent: "write")
return await game.macros.getName("Your Plugin").execute({ ...args });
```

**Input.** One `scope` object. Three conventional shapes:

| call | gate | must be |
|---|---|---|
| bare run (hotbar click, no args) | none | safe: diagnostic, seed, self-repair. Never a domain write. |
| `{ action: "..." }` read modes | none (read eval) | report state, return data, write nothing |
| payload modes | Approve/Deny | validate first, one logical operation, then write |

**Output.** Always return an object.

```js
{ ok: true,  uuid, name, ...result, warnings: [] }        // success
{ ok: false, error: "human-readable reason", ...flags }   // refusal
```

Put machine-readable flags beside the prose (`duplicate: true`,
`existing: uuid`, `iconless: [...]`) so Claude can react without parsing your
sentences. Escape-hatch args (`allowDuplicate: true` and kin) exist so a
HUMAN can override; a well-briefed Claude never passes them on its own.

**First line of every plug-in:**

```js
if (!game.user.isGM) return ui.notifications.warn("Your Plugin is a GM tool.");
```

## Rules the transport imposes

- **One operation per approval.** Each gated eval is one Approve/Deny card.
  Do not batch many writes into one eval: approved evals are killed at the
  relay timeout (~120s). Chunk large jobs, or run them with
  `Promise.allSettled` inside the window, and design so a killed batch can
  simply re-run.
- **Refusal makes retries idempotent.** Check for a same-name / same-key
  twin and refuse with `{ duplicate: true, existing }` before creating.
  A retried request must never double-create.
- **Never trust the eval's own return to prove a write.** Gated mutations
  apply out-of-band; the eval's return is computed from a pre-write snapshot.
  Read your created document back inside the macro before reporting `ok`,
  return its `uuid`, and expect Claude to verify with a separate read anyway.
- **Hard limits that are not yours to lift.** HP changes go only through
  `foundry_apply_damage` (absolute >=1 HP floor; lethal is human-only).
  Journals used as macro datastores are refused to eval outright. The
  confirmation gate cannot be bypassed. Do not design a plug-in that needs
  any of these; it will be refused at the relay.

## Config pattern (optional)

If your plug-in needs operator-editable settings, use a **config journal**:
seed it on first bare run, let humans edit it like any journal, and have the
macro re-parse it on every invocation. Code reads it, never writes it after
seeding. Give Claude a read mode (`{ action: "config" }`) that returns the
parsed result, so it never has to touch the journal itself. See the Foe
Forge's "Claude Foe Forge Config" journal for a worked example, including a
parser that survives ProseMirror re-saves.

## Minimal skeleton

```js
if (!game.user.isGM) return ui.notifications.warn("My Plugin is a GM tool.");
const req = (typeof scope === "object" && scope) ? scope : {};
const fail = (error, extra = {}) => {
  ui.notifications.warn(`My Plugin: ${error}`);
  return { ok: false, error, ...extra };
};

// Read mode: ungated, reports state, writes nothing.
if (req.action === "status") return { ok: true, actors: game.actors.size };

// Bare run: human diagnostic only.
if (!req.payload) {
  ui.notifications.info("My Plugin: ready. Invoke with { payload } to write.");
  return { ok: true, diagnostic: true };
}

// Validate BEFORE writing; refuse with machine-readable flags.
if (typeof req.payload.name !== "string" || !req.payload.name.trim())
  return fail("payload.name must be a non-empty string.");
const twin = game.actors.getName(req.payload.name);
if (twin && !req.allowDuplicate)
  return fail(`"${req.payload.name}" already exists.`, { duplicate: true, existing: twin.uuid });

// Write, then read back before claiming success.
const doc = await Actor.create({ name: req.payload.name, type: "npc" });
if (!doc || !game.actors.get(doc.id)) return fail("Create did not land.");
return { ok: true, uuid: doc.uuid, name: doc.name, warnings: [] };
```

## Ship a brief for Claude

The macro is half the plug-in; the other half is a short usage brief the
operator gives their Claude (loop instructions, project skill, or just a
paste into the chat). Cover: what the plug-in does, the payload shape, that
invocation is one gated eval with declared `intent: "write"` and a summary,
what each refusal flag means, and that success is confirmed by a separate
read on the returned uuid. The Item Forge and Foe Forge sections in the
README are the worked examples of this whole pattern, endpoint and brief
both.
