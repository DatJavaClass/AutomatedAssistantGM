# Foundry–Claude Bridge: Design Document

**Status:** Beta workstream (module 0.7.0). The Claude Macro Workshop was removed 2026-08-09 (defunct); HP writes now route through the §9 confirmation gate instead of a hard block. Live state-of-build: `PHASE1_STATUS.md`.
**Last updated:** 2026-05-17
**Author:** DatJavaClass

---

## 1. Purpose

A bridge that lets Claude (in two different surfaces — Claude Code and Claude Chat) interact with a running Foundry VTT v12 instance, hosted on Forge, running a Pathfinder 1e world. The bridge serves two distinct use cases:

- **Debug channel** — Claude Code helps author and debug macros by reading state, executing JS in the Foundry client context, and streaming logs back. Used during development.
- **AAGM channel** — Claude Chat acts as an Automated Assistant Game Master during live sessions, performing curated game-state actions (move tokens, advance time, trigger weather, post chat as a distinct persona). Used during play.

Both channels share architecture but are physically and logically isolated from each other.

## 2. Constraints and prior decisions

These are pre-decided. The implementer should treat them as fixed:

- **Forge hosting.** No filesystem access on the server side. No world scripts. The bridge cannot live on the Foundry server itself — it must live on the client side as a module, plus a local relay process on DatJavaClass's machine.
- **No shared-secret auth.** Authorization is bound to active Foundry sessions. If you're logged in, the bridge works. If you're not, it doesn't. This is the security model.
- **Two browsers, two accounts.** DatJavaClass's GM account runs in **Firefox**. The AAGM account runs in **Chrome**. The browsers act as a physical isolation boundary between the two channels — they share no cookies, storage, or process state.
- **Claude for Chrome is the AAGM fallback.** Because the AAGM lives in Chrome, Claude Chat can use the Claude for Chrome extension to drive Foundry's UI directly when the bridge is unavailable. This is a proven capability — it has been used before.
- **Sandbox scene exists.** The scene at UUID `Scene.<your-sandbox-scene-id>` is the test/debug environment. Macros already detect this scene and enable debug behavior. The bridge should respect this convention.
- **Journal-as-database pattern is established.** State that needs to persist between sessions or be read by macros lives in journal entries. The bridge's audit log will follow this pattern.
- **System Journal "VTT Macro Styles" is sacred.** Don't touch it. The bridge does not need to load styles — it has no GUI.

## 3. Architecture overview

```
┌─────────────────────────┐         ┌─────────────────────────┐
│  FIREFOX (DatJavaClass / GM)  │         │  CHROME (AAGM persona)  │
│                         │         │                         │
│  Foundry tab            │         │  Foundry tab            │
│  └─ Bridge module       │         │  └─ Bridge module       │
│     └─ WebSocket ──┐    │         │     └─ WebSocket ──┐    │
└────────────────────│────┘         └────────────────────│────┘
                     │                                    │
                     │   localhost only                   │
                     ▼                                    ▼
              ┌──────────────────────────────────────────────┐
              │              LOCAL RELAY (Node.js)           │
              │                                              │
              │  - Accepts WS connections from bridge        │
              │  - Identifies session by hello message       │
              │  - Applies capability set per session        │
              │  - Exposes MCP server endpoints              │
              │  - Writes audit log                          │
              └──────────────────────────────────────────────┘
                     ▲                                    ▲
                     │ MCP (debug tools)                  │ MCP (AAGM tools)
                     │                                    │
              ┌──────────────┐                     ┌──────────────┐
              │ Claude Code  │                     │ Claude Chat  │
              │  (debug)     │                     │   (AAGM)     │
              └──────────────┘                     └──────────────┘

                                                   Fallback: Claude for Chrome → Chrome → Foundry UI
```

Three components:

1. **Bridge module** — A Foundry v12 module installed on the Forge instance via manifest URL. Runs in the Foundry client (browser). Opens an outbound WebSocket to the local relay. Exposes a command dispatcher.
2. **Local relay** — A Node.js process running on DatJavaClass's machine. Accepts WebSocket connections from the bridge module(s). Exposes MCP server endpoints to Claude Code and Claude Chat. Routes commands. Logs everything.
3. **Configuration** — A small config file on the relay specifying which Foundry user names map to which capability sets.

## 4. Channel model

### 4.1 The two channels

| | **Debug channel** | **AAGM channel** |
|---|---|---|
| Browser | Firefox | Chrome (dedicated profile recommended) |
| Foundry account | DatJavaClass (GM) | AAGM (separate user account) |
| Claude surface | Claude Code | Claude Chat (with Claude for Chrome fallback) |
| Capability set | `debug` | `aagm` |
| Primary use | Macro authoring & troubleshooting | Live session automation |
| Eval permitted? | **Yes** | **No** |
| Audit logging? | Optional (debug noise) | **Required** (every command) |
| Confirmation gates? | None | Required for destructive/PC-affecting actions |

### 4.2 Why the asymmetry

The debug channel is operated by DatJavaClass in real time and is short-lived (you fix a thing, you stop). Arbitrary `eval` is acceptable because the human is in the loop on every command.

The AAGM channel is operated by an autonomous agent during a live session. Arbitrary `eval` would be an unbounded knife. Instead, AAGM gets a curated set of high-level operations whose failure modes are understood. If AAGM needs a new capability, we add a handler — we do not give it a way to invent capabilities at runtime.

### 4.3 Fallback path (AAGM only)

If the bridge is unavailable mid-session:

1. Claude Chat detects bridge failure (timeout, no response, explicit error).
2. Claude Chat falls back to driving the AAGM's Chrome browser via the Claude for Chrome extension.
3. Operations are slower and clumsier (DOM clicks, UI navigation) but Foundry is fully usable.
4. When the bridge recovers, Claude Chat returns to the fast path.

The debug channel has no equivalent fallback — Firefox does not have Claude for Chrome, and that is fine. Debug is not time-critical.

## 5. Authorization model

Authorization is implicit in WebSocket connection state:

- **The bridge module opens the WS connection from inside Foundry.** It can only do so if a Foundry session exists.
- **The connection lives only as long as the Foundry tab is open and the session is valid.** Close the tab, log out, or let the session expire — connection drops.
- **The relay applies a capability set based on which Foundry user the bridge is running as.** Sent in a `hello` message at connection time.
- **No tokens, no passwords, no shared secrets.** The session itself is the credential.

### 5.1 Capability sets

Defined in the relay's config file. A capability set is a list of allowed handler names.

**`debug` set** (initial):
- `ping`
- `query.actor`
- `query.scene`
- `query.macro`
- `query.journal`
- `query.user`
- `logs.subscribe` / `logs.unsubscribe`
- `eval` (gated by additional confirmation in the relay; full power)

**`aagm` set** (initial — will grow):
- `ping`
- All `query.*` from debug
- `token.move`
- `token.update` (limited fields)
- `time.advance`
- `chat.post` (as the AAGM user)
- `weather.set`
- `audit.log` (the AAGM logs its own actions)

If a connection requests a handler outside its capability set, the relay refuses with `error.capability_denied` and logs the attempt.

### 5.2 The relay binds to localhost only

`127.0.0.1` only. No external network exposure. Combined with session-bound auth, this means an attacker would need (a) shell access to DatJavaClass's machine, (b) DatJavaClass logged into Foundry, and (c) the Foundry tab open. At that point they have bigger problems than the bridge.

## 6. Message protocol

JSON-RPC 2.0 over WebSocket. Standard, well-supported, request/response correlation built in.

### 6.1 Connection handshake

Bridge → Relay (immediately on connection open):

```json
{
  "jsonrpc": "2.0",
  "method": "hello",
  "params": {
    "userId": "abc123",
    "userName": "DatJavaClass",
    "isGM": true,
    "worldId": "myworld",
    "foundryVersion": "12.343",
    "moduleVersion": "0.1.0"
  },
  "id": "hello-1"
}
```

Relay → Bridge:

```json
{
  "jsonrpc": "2.0",
  "result": {
    "capabilitySet": "debug",
    "auditLogging": false,
    "sessionId": "relay-issued-uuid"
  },
  "id": "hello-1"
}
```

If no capability set matches the user, the relay closes the connection with code `4001`.

### 6.2 Command shape

Claude (via MCP) → Relay → Bridge:

```json
{
  "jsonrpc": "2.0",
  "method": "query.actor",
  "params": {
    "actorId": "xyz789",
    "fields": ["name", "system.attributes.hp", "flags"]
  },
  "id": "cmd-42"
}
```

Bridge → Relay → Claude:

```json
{
  "jsonrpc": "2.0",
  "result": {
    "actorId": "xyz789",
    "data": { "name": "Aldric", "system": { "attributes": { "hp": { "value": 42 } } }, "flags": {} }
  },
  "id": "cmd-42"
}
```

### 6.3 Errors

Standard JSON-RPC error format with custom error codes:

| Code | Meaning |
|---|---|
| `-32600` | Invalid Request (malformed JSON-RPC) |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |
| `-33001` | Capability denied |
| `-33002` | Foundry execution error (handler ran but threw) |
| `-33003` | Session not authorized |
| `-33004` | Eval explicitly disabled for this capability set |
| `-33005` | Listener slot occupied (a chat-loop listener is already active; see §13.2) |

### 6.4 Streaming (logs)

`logs.subscribe` is a long-running operation. Implement as a notification stream — the bridge sends `logs.entry` notifications (no `id` field) until the client sends `logs.unsubscribe`.

```json
{
  "jsonrpc": "2.0",
  "method": "logs.entry",
  "params": {
    "level": "warn",
    "timestamp": "2026-05-06T15:23:01.234Z",
    "source": "macro:DraftMetaScroll",
    "message": "Style journal read failed: ..."
  }
}
```

### 6.5 Foundry → Claude Code chat channel (Phase 2)

The channels above are Claude-initiated (Claude calls a tool; Foundry answers).
Phase 2 adds the reverse direction for the **debug** channel only: an in-Foundry
chat box where DatJavaClass types to Claude Code and sees replies inline.

Mechanism — a relay-buffered queue drained by a polling Claude Code `/loop`.
Nothing can push a prompt into a running Claude Code session (MCP is
Claude-initiated), so Claude Code polls and the relay holds messages until it
does. Four new JSON-RPC notifications (no `id`, fire-and-forget):

| Notification | Direction | Purpose |
|---|---|---|
| `claude.prompt` `{promptId,text}` | module → relay | DatJavaClass sent a chat message. Queued. `/exit` `/stop` `/quit` are terminators (not enqueued). |
| `claude.hello` `{}` | module → relay | Box opened/reconnected; requests current status. |
| `claude.reply` `{promptId?,text}` | relay → module | Claude Code's reply; rendered in the box. |
| `claude.status` `{state}` | relay → module | `ready` (a `/loop` is polling) or `no-listener`. `disconnected` is derived box-side from the WS state. |

Two MCP tools expose the queue to Claude Code: `foundry_get_prompts` and
`foundry_send_reply` `{text,promptId?}`. The loop ends when `terminate` is
true — set by an `/exit`-class word **or** the local `relay/.loop-stop` kill
file (a terminator that works even if the box↔relay link is down).

`foundry_get_prompts` **long-polls**: it blocks server-side until a prompt or
terminate arrives, or ~25s elapses, then returns (empty on timeout). The loop
calls it back-to-back with no client-side pacing — the server provides the
cadence. A queued prompt or `/exit` wakes any in-flight call immediately;
`.loop-stop` is also caught by the 10s sweep so it ends a mid-poll idle loop.

**Latency model.** Queue transit is localhost WS + in-memory — sub-millisecond;
network is never the bottleneck. End-to-end delay = *pickup* + *compose*.
Long-polling drives pickup to ≈0 when active. Compose (Claude actually doing
the task; scales with reply length) is irreducible model work. The ~25s
timeout bounds the failure case: if anything stalls, the call returns and the
loop retries within one cycle — nothing hangs. A single loop serializes:
replies are produced one at a time; `foundry_get_prompts` drains *all* queued
prompts at once so a burst is picked up together.

## 7. Initial handler set (Phase 1)

Build these first. Both channels need them; `debug` gets all of them, `aagm` gets the read-only ones.

### `ping`
- Params: none
- Result: `{ "pong": true, "serverTime": "<iso>" }`
- Purpose: liveness check

### `query.actor`
- Params: `{ actorId: string, fields?: string[] }`
- Result: actor data, optionally filtered to requested fields
- Purpose: inspect actor state for debugging

### `query.scene`
- Params: `{ sceneId?: string }` (defaults to active scene)
- Result: scene metadata, token list (id/name/position only — not full token data unless requested), wall count, lighting state
- Purpose: understand the current play context

### `query.macro`
- Params: `{ macroId?: string, name?: string }`
- Result: macro source code, author, scope, type
- Purpose: read the actual current source of a macro DatJavaClass is editing

### `query.journal`
- Params: `{ journalId?: string, name?: string, pageId?: string, pageName?: string }`
- Result: journal page content (HTML/text)
- Purpose: read journal-database content directly

### `query.user`
- Params: `{ userId?: string }` (defaults to all users)
- Result: list of users, online status, character ownership
- Purpose: know who's at the table

### `logs.subscribe` / `logs.unsubscribe`
- Params (subscribe): `{ levels?: string[], filter?: string }` (regex filter on message)
- Params (unsubscribe): none
- Result: streaming `logs.entry` notifications until unsubscribed
- Purpose: see console output from the Foundry client in real time
- **Implementation note:** The bridge module wraps `console.log/warn/error/info` and intercepts emitted UI errors. Wrapping should be reversible (store originals, restore on module disable).

### `eval` (debug only)
- Params: `{ code: string, awaitResult?: boolean }`
- Result: serialized return value (or thrown error)
- Purpose: run arbitrary JS in the Foundry client context for debugging
- **Implementation note:** Use `(new Function(...))()` not raw `eval` to avoid scope leaks. Wrap in try/catch. Serialize result with a depth limit and circular-reference guard. If `awaitResult` is true, await the return if it's a Promise.

**Activated 2026-05-17 — read-scoped.** `eval` is built (`module/scripts/handlers/eval.js`, full power per the note above) and exposed as `foundry_eval`. This stage is **reads only**: `relay/src/eval-guard.js` classifies each eval at the relay and *refuses* mutating/destructive code (create/update/delete, setFlag, settings.set, applyDamage, ChatMessage.create, Hooks.call, direct field assignment, …) before it reaches Foundry — it never executes. This is defense-in-depth, **not a sandbox** (arbitrary JS can't be proven read-only); the hard boundary is that no write path is exposed. Every eval is audited (`eval.in` / `eval.blocked`). The DESIGN §9 **double-confirmation gate** for deletes / "kill actor" is the deliverable of the next (Co-GM writes) stage — full power + always-double-confirm-destructive is the standing requirement for that stage.

**Write / Co-GM stage activated 2026-05-17 (module 0.4.0).** eval-guard now *classifies* rather than blanket-refuses: `read` runs immediately; `mutating` → §9 gate single-confirm; `destructive` (deletes) → §9 gate **double**-confirm; `db-journal` and `hp` are hard-refused. The relay takes the stricter of Claude's declared `intent` and the classifier. The §9 gate lives in `dispatcher.js` (`requestConfirmation`/`resolveConfirmation`); the proposal (summary + exact code, or damage preview) is rendered as an Approve/Deny card in the chat box; no open box ⇒ auto-deny; ~120 s ⇒ auto-deny. HP changes go **only** through `foundry_apply_damage` (`handlers/damage.js`), which enforces an **absolute ≥1 HP floor — Claude may never reduce any actor below 1 HP; lethal is human-only, not even double-confirm** — atomically (all-or-nothing, no partial writes, race-checked at commit). **No sandbox special-casing** (DatJavaClass, 2026-05-17): writes execute identically on every scene; the boundary is the gate + floor, not the scene. Next sub-stage: movement/pathfinding choreography via the installed `routinglib`.

**HP model revised 2026-08-09 (module 0.7.0, DatJavaClass).** The hard-refused `hp` eval category and the absolute ≥1 HP floor above are replaced by the §9 confirmation gate — the old block cut both ways, preventing healing, setting NPC/monster HP, and even plain HP reads. Now: HP writes via `foundry_eval` are ordinary gated writes (single confirm; deletes still double); HP reads are reads. `foundry_apply_damage` remains the damage primitive and routes every application through the gate — all targets staying ≥1 HP is a single confirm, ANY target landing below 1 HP escalates to a **double confirm**, with the live before→after preview shown either way. Commit is atomic and carries `allowLethal` (what the gate approved); a plan→approve→commit race that would exceed the approval refuses without writing and must re-plan at the double-confirm tier. `db-journal` stays hard-refused. The Claude Macro Workshop (`claude.refactor.*`, `foundry_workshop_*`, `ide-macro.js`) was removed the same day as defunct.

**Topology (decided 2026-05-17).** The debug channel runs as **the GM's own account** — the earlier "Claude gets its own login" idea is abandoned. GMs run several Foundry windows; one dedicated window holds the Claude Code Chatbox and is the only one with the bridge module **enabled**. All other GM windows keep it **disabled** — the relay closes a duplicate GM `userId` with `4002` (constraint §6.1 / decision #4). `eval` in that one window sees the entire GM world (world data is shared across the user's sessions).

## 8. Audit logging

For the AAGM channel only (debug logging is opt-in noise).

Every command received by the relay for an `aagm`-capability connection is appended to a journal page named `AAGM Audit Log` in the Foundry world. Format: one line per command, JSON-encoded, timestamp first.

```
2026-05-06T20:15:03Z {"method":"token.move","params":{"tokenId":"...","x":1200,"y":800},"result":"ok"}
2026-05-06T20:15:14Z {"method":"chat.post","params":{"content":"The goblins shift uneasily..."},"result":"ok"}
```

The audit log is written by the AAGM bridge (which has write access to journals as a Foundry user). The relay sends the audit entry as a regular `audit.log` command back to the bridge, which appends to the journal page.

This means: **the audit log is itself in Foundry**, visible to DatJavaClass in the Journal sidebar, queryable via the bridge, and persists with the world.

## 9. Confirmation gates (AAGM only)

Some AAGM operations require explicit confirmation before executing. The pattern:

1. Claude Chat sends the command.
2. The bridge receives it, posts a confirmation prompt to the GM whisper channel: "AAGM wants to delete actor X. [Approve] [Deny]"
3. Bridge waits for the GM (DatJavaClass in Firefox) to click one of the buttons.
4. Bridge reports back to Claude Chat with the decision.

Operations requiring confirmation:
- Anything that deletes documents (actors, items, scenes, journals)
- Any update to a PC-owned token, actor, or character sheet
- Sending chat messages that are not whispers (public posts under the AAGM identity)
- Scene transitions that move PC tokens

Operations *not* requiring confirmation:
- Moving NPC tokens
- Advancing time
- Setting weather
- Whispered chat
- Reading any state

## 10. Build phases

### Phase 1 — Debug bridge, read-only
- Bridge module skeleton (manifest, init hook, settings)
- WebSocket client in module
- Local relay process
- MCP server (debug tools only)
- Handlers: `ping`, all `query.*`, `logs.subscribe`
- **No eval yet.** Prove the pipe works first.

### Phase 2 — Debug bridge, full
- Add `eval` handler with proper sandboxing
- Add result serialization with depth limits
- **Foundry → Claude Code chat channel** (§6.5): auto-created "Open Claude Code
  Chat" macro, relay prompt queue, `foundry_get_prompts` / `foundry_send_reply`,
  polling-loop responder with `/exit` + `.loop-stop` terminators.
- **GUI is permitted from Phase 2.** The Phase 1 no-GUI rule was scoped to
  Phase 1. The chat box is a Dialog created via a module-spawned macro (the
  macro-corpus pattern) — the module itself still ships no Application class.

### Phase 3 — AAGM bridge, read-only + low-risk writes
- Second capability set in relay config
- Handlers: `token.move` (NPC only), `time.advance`, `weather.set`, `chat.post` (whisper only), `audit.log`
- Audit log journal page bootstrapped automatically

### Phase 4 — AAGM bridge, full
- Confirmation gate UI in module
- Public chat posting
- PC-affecting operations (with gates)
- Claude for Chrome integration documented as the official fallback

## 11. Open questions

These are not blockers — flag them as decisions to make during implementation:

1. **Bridge module distribution.** Manifest URL pointing to a GitHub release? Local file install via Forge's "Bazaar Lite" upload? Confirm Forge accepts custom module installs.
2. **Module reload behavior.** When DatJavaClass edits the module's code locally and pushes a new version, does Foundry hot-reload, or does the browser tab need a refresh? (Almost certainly the latter.)
3. **WebSocket reconnection.** If the relay restarts, the module should reconnect with exponential backoff. Define max retry interval.
4. **Multiple Firefox tabs.** What if DatJavaClass accidentally opens two GM tabs? Both bridges connect. Decide: refuse second connection, or accept and let both work. Probably refuse — log a warning.
5. **Foundry v13 forward compatibility.** Not now, but note any v12-specific API uses so the migration is bounded.

## 12. Out of scope (for now)

Listed here so they don't creep in:

- Player-facing bridges (no AI assistance for players, only for the GM)
- Cross-instance bridges (one Foundry world per relay)
- Voice input
- Rules engine integration (the AAGM does not enforce rules; it manipulates state)
- Anything that requires server-side Forge access

## 13. Settings & modes (spec 2026-08-13)

Born from the 2026-08-13 duplicate-listener incident and the agentic design
session that followed it. Preset names and the Chain Mode ceiling are locked
decisions (#8 / #9 in `CLAUDE.md`); this section is the build spec. Nothing
here weakens §9 - every write still gates; these settings only change batching
and parallelism around the gate.

### 13.1 Surface

Module settings in Foundry's Configure Settings, **world-scoped, GM-only**.
The preset trio with locked-until-Custom options needs dynamic enable/disable,
so the module registers a settings submenu (`game.settings.registerMenu`)
opening one small form. This is the sanctioned, scoped exception to the
"no Application classes in the module" rule (DatJavaClass, 2026-08-13):
exactly one settings form, nothing else. Every control is backed by a plain
`game.settings.register` entry so values are readable without the form.

Menu layout:

```
AAGM-C Settings
├─ Mode (pick one)
│   (•) Assistant Mode   "AAGM assists at your table; every change is
│                         individually confirmed."            [default]
│   ( ) Co-GM Mode       "AAGM works alongside you: multitasking and
│                         Chain Mode offers. Assumes an experienced GM."
│   ( ) Custom           "Unlock the individual options below."
├─ Options (greyed/locked unless Custom)
│   [ ] Agentic multitasking
│   [ ] Chain Mode offers
│        Chain offer threshold [ 4 ]   (min 2)
│        Max chain length      [ 20 ]  (hard cap 40)
└─ Macro Mirror (always editable, independent of Mode)
    [ ] Macros Mirrored Locally?
         Local directory [__________________________]
         [ ] Use Contextual sorting? (Experimental)
```

Settings keys (namespace = module id; all world-scoped):

| Key | Type | Default | Locked by presets |
|---|---|---|---|
| `mode` | string | `assistant` | - (`assistant` / `cogm` / `custom`) |
| `multitasking` | bool | `false` | yes |
| `chainOffers` | bool | `false` | yes |
| `chainOfferThreshold` | number | `4` | yes |
| `chainMaxLength` | number | `20` | yes |
| `mirrorEnabled` | bool | `false` | no |
| `mirrorPath` | string | `""` | no |
| `mirrorContextualSort` | bool | `false` | no |

Preset bundles: **Assistant** = multitasking off, chainOffers off.
**Co-GM** = multitasking on, chainOffers on. Selecting a preset overwrites
the bundled values; selecting Custom unlocks them starting from their current
values. All labels/hints via i18n keys `FOUNDRY_BRIDGE.SETTINGS.*`.

### 13.2 Enforcement: module is surface, relay is law

Settings ride the WS: included in the module `hello` and re-sent on any
change (`settings.sync` notification). The relay caches them and its gate
logic consults the cache - a module-side hack can repaint the menu but cannot
change what the relay enforces. The `foundry_ping` response gains a `mode`
summary so the loop session reads the world's posture at startup without a
new tool. Changes apply from the next gate/poll; no restart needed.

**Single-listener lock (always on; not a setting).** The relay's MCP
transport is stateless (per-request server, no session ids), so the lock keys
on a `listenerId` string: a REQUIRED `foundry_get_prompts` param the loop
generates once at startup and reuses every poll. First id claims the slot; a
poll with a different id while the slot is live is refused with `-33005
listener-occupied` (§6.3) and the GM sees a "second instance refused" toast.
The slot frees on terminate or listener timeout (45s quiet). The `/aagm`
skill treats `-33005` as: report briefly and exit - never retry under a new
id. This makes the 2026-08-13 split-brain structurally impossible. Named
multi-listener support is reserved future work and would be a Custom-only
unlock if it ever lands.

### 13.3 Chain Mode

Ceiling per `CLAUDE.md` decision #8 - permanent, never to be widened.
Mechanics:

1. **Eligibility** is computed by the relay classifier per gate (stricter-of
   rule), never by the task's description. A batch is chain-eligible iff
   every planned gate classifies single-auth.
2. **Offer.** When Claude has `chainOfferThreshold`-or-more eligible gates
   for one homogeneous task, it may offer: "N gates coming up: <manifest
   summary>. Run in Chain Mode? [Yes] [No]". Never assumed; a declined offer
   is not re-asked for that batch.
3. **Contract.** The offer carries a manifest: `{chainId, count (<=
   chainMaxLength, hard cap 40), summary}` (e.g. "create 10 items in
   compendium X"). GM approval records the grant relay-side. One chain at a
   time - a second offer while one is live is refused.
4. **Execution.** Each gated call must reference the `chainId`. The relay
   mechanically enforces single-auth category, remaining count, and TTL; the
   *target scope* is the manifest text the GM approved, held honest by each
   gate's mandatory summary rendering live in the box next to the [Cancel
   Chain] button ("chain 4/10: <summary>"). Matching gates auto-approve.
5. **Chain death** - any of these, immediately, all remaining gates revert
   to manual confirmation: an off-manifest gate; any gate escalating to
   double-auth/destructive mid-chain (backs the standing rule that only the
   user authorizes destructive changes); any error, `{refused}`, or
   `{blocked}`; count exhausted; TTL expiry (10 minutes from grant); GM
   cancel.
6. **Audit.** One `chain.grant` event; every gate logged with its `chainId`;
   `chain.end` with reason.

Assistant Mode never offers chains. Its bulk-relief is different and often
better: one gated write whose confirmation dialog lists every change it will
make - one gate, full disclosure. Chain Mode exists for batches that
genuinely cannot merge into one write (verify-read cycles between writes,
bulk-bound chunking).

### 13.4 Agentic multitasking

When `multitasking` is on, the loop session may run background subagents for
heavy read/design work (forges, audits, builds) while it keeps polling the
box. Rules: subagents read freely; **all gated writes funnel through the
main loop, serially** - confirmations never interleave, and no two workers
touch the same document. One conversational identity: subagents never speak
in the box; the box instead carries a status line while work runs ("1
background task: Cantankerous Skull"). When off (Assistant default), work is
synchronous.

### 13.5 Macro Mirror

A **protection** feature - the macro database is player-reachable - not an
editing surface, and explicitly not a Macro Workshop revival. Independent of
the Mode presets (available to every persona).

- `mirrorPath` is a directory on the relay machine (the world stores the
  string; Claude validates existence at use time and reports if missing).
- Commands are conversational via the box: **"back up all the macros"**
  (full sweep, world → local), **"back up macro X"**, **"restore macro X"**.
- **Backup**: macro command text → `<Name>.js` (filesystem-sanitized) with a
  three-line header comment (macro UUID, Foundry folder path, img) for
  restore fidelity. Reads are ungated.
- **Rotation**: a new backup demotes the existing file to `<Name>.js.bkp`;
  the previous `.bkp` is replaced (exactly one prior generation is kept).
  The mirror **never deletes** a file.
- **Restore**: a gated write - update the existing world macro, or recreate
  it from the header if it vanished. Bulk restore is a canonical Chain Mode
  batch when eligible.
- **Contextual sorting** (`mirrorContextualSort`, labeled Experimental):
  normalize both sides (strip leading non-alphanumeric symbols such as
  "✓ ", casefold, trim), place the macro in the local folder whose
  normalized name matches its Foundry folder; no confident match → create
  the literal (sanitized) Foundry folder name, never guess. The Experimental
  label is the documented answer to "why didn't 'Apple' match 'Banana'".
- **Write scope**: enabling the mirror is the sole, scoped exception to the
  read-only macro-corpus rule - Claude writes only under `mirrorPath`, and
  only mirror output.

### 13.6 Build order

Suggested sequence, each step independently shippable and testable:

1. **Single-listener lock + settings sync** (`-33005`, `settings.sync`,
   `mode` in ping) - smallest change, kills the worst live failure mode.
2. **Settings surface** (submenu form, presets, locked-until-Custom, i18n).
3. **Macro Mirror** (backup / rotation / restore; contextual sorting last,
   behind its own flag).
4. **Chain Mode** (manifest, grant, per-gate check, death conditions, audit).
5. **Agentic multitasking** (subagent delegation rules in the `/aagm` skill,
   serialized-write funnel, box status line).

---

*End of design doc.*
