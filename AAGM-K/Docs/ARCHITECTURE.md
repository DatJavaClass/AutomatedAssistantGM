# AAGM-K Architecture

## Current scope

AAGM-K connects one authenticated Foundry GM browser session to a local Kimi client. Foundry holds no API key. Both servers bind only to loopback.

Who owns policy? The relay. It enforces settings, listener ownership, interaction mode, rollback persistence, write serialization, and Macro Mirror filesystem access.

The `gm` capability set supports reads, log capture, rollback backed JavaScript, serialized damage, loot rescue, chat, interaction modes, session logs, and mirrored macro backup and restore.

## Component map

```text
Kimi Code CLI
                  |
        Streamable HTTP MCP
     http://127.0.0.1:7899/mcp
                  |
          Local Node.js relay
 policy, rollback, write queue, tabs, modes, mirror
                  |
          JSON-RPC WebSocket
        ws://127.0.0.1:7898
                  |
        Foundry module in GM tab
 handlers, tabbed chat, settings, rollback recorder
                  |
          Foundry VTT world
```

## Foundry module

`module/scripts/bridge.js` registers settings, provisions the **Open AAGM-K Chat** and **AAGM-K Loot Watchdog** macros, connects the relay, dispatches handlers, and exposes the chat API. Player clients do not connect.

`module/scripts/settings-def.js` registers five world-scoped values. `module/scripts/settings-menu.js` is the only module Application class and provides Assistant, Co-GM, and Custom modes. The module publishes settings in `hello` and `settings.sync`. The relay validates and enforces them.

`module/scripts/chat-macro.js`:

- Sends prompts and renders replies as text.
- Shows up to five task tabs when multitasking is enabled. The relay owns
  their titles, states, and last 40 transcript lines; reopening the box
  rebuilds them from the relay.
- Accepts Foundry document drops as `@UUID` references.
- Shows listener, interaction mode, rollback, and background work status.
  Each rollback point card shows what was captured (counts per op) and the
  first documents, with a Rollback button while the point is live.
- Rebuilds tab state after a reload from relay notifications.

The handler boundary contains:

| Handler | Purpose |
|---|---|
| `ping` | World and session liveness |
| `query.*` | Actor, scene, macro, journal, and user reads |
| `logs.*` | Filtered console forwarding |
| `eval` | Capped JavaScript execution |
| `damage` | Serialized damage and HP plan |
| `loot.*` | Constrained rescue queue reads and restores |
| `mirror.*` | Macro reads and rollback backed restore application |
| `rollback.apply` | Restores one point's entries, newest first |

`module/scripts/rollback-recorder.js` installs Foundry document hooks on
`ready`. A request carrying `params.rp` runs inside `runRecorded`, one
recording at a time on a promise chain. `preUpdate` keeps the before state of
each updated document (earliest state wins), `preCreate` plus `create` keep
the uuids of created documents (tagged through `options._aagmRp`), and
`preDelete` keeps the full data of deleted ones with `parentUuid` and `pack`.
Documents on the eval guard deny list are never recorded. The result carries
`rollback.entries`; a thrown handler carries them in the JSON-RPC error data.

The Loot Watchdog requires Item Piles and a deployed Rescue Log journal UUID. Its source ships with `REPLACE_WITH_RESCUE_LOG_JOURNAL_ID` until deployment supplies the real ID.

## Relay

`relay/index.js` composes these policy components:

| Component | Responsibility |
|---|---|
| `ws-server.js` | Loopback WebSocket, hello validation, capabilities |
| `dispatcher.js` | Requests, responses, and relay notifications |
| `mcp-server.js` | Public MCP tools, rollback, and interaction modes |
| `prompt-queue.js` | Chat queue and 45-second listener lease |
| `tabs.js` | Per-task state and transcript table |
| `world-settings.js` | Validated relay-owned posture cache |
| `rollback-store.js` | Rollback points, index, and rollback chain |
| `mirror.js` | Scoped backup, rotation, and restore reads |
| `write-queue.js` | One serialized lane for all writes |
| `audit.js` | Markdown session audit logs |
| `eval-guard.js` | Read, mutation, delete, and journal classification |

The listener generates one `listenerId` and reuses it. A competing listener receives JSON-RPC `-33005`, the GM receives a toast, and the slot releases on terminate or 45 seconds of quiet.

## Safety model

### Local transport

Both servers hard-fail non-loopback bind configuration. The WebSocket server also rejects non-loopback peers.

### Relay-owned posture

The module is the settings surface. The relay is the authority. Assistant Mode
forces multitasking off. Co-GM forces it on. Custom accepts its own value.
Interaction mode is separate: it begins as `internal`, `/int` or
`foundry_set_interaction_mode` selects internal dispatch, and `/ext` selects
`external` work while cancelling queued internal prompts and suspending
internal subagent replies and writes. External MCP work omits an internal tab ID
and remains available.

### Rollback backed writes

Confirmation gates and Chain Mode are retired. Reads execute immediately.
For every supported Foundry write, the relay opens a point id (`rp-` plus six
hex digits) and sends the write with `params.rp = { id }` through its write
lane; the module runs it inside the recorder chain. The point holds the
documents the write touched, not the world. Concurrent workers therefore
cannot overlap world changes.

Supported writes are document or world setting evals, damage, macro restore,
and constrained Loot Watchdog restoration. Side effects that a rollback point
cannot reverse are refused. Successful calls return the point with `captured`
and `docs`. A failed write is not undone automatically: when the module
reports documents touched before the failure, they still become a point and
the error message names it.

A point is `{ id, ts, summary, tabId, kind, entries, state }`, one JSON file
per point in root `Rollback Points/<date>/`. The relay keeps an index of up to
200 points and reloads today's on start. `foundry_rollback_points` lists them
newest first. `foundry_rollback` rolls back to before a point: it and every
later live point are undone newest first, one `rollback.apply` request per
point with a 300 second timeout, one rollback at a time. Updates are rewritten
from their record (`_id`, `_stats`, `type`, and embedded collections
stripped; a linked token never gets `delta`), created documents are deleted,
and deleted ones are recreated with `keepId`. A rollback never deletes a
document the point did not create. Each point ends `rolled-back` or, when any
entry failed, `partial`. A bridge error stops the chain. In Foundry chat, the
card button and `/rollback` use the same tool, and `aagm.status.request`
resyncs the cards.

Redo: each `rollback.apply` is itself recorded, and what the rollback changed
becomes a new live point of kind `redo`. Rolling it back redoes the work.

Protected database journals, including the Loot Watchdog Rescue Log, never
enter a point and are never restored. Rolling back a loot restore removes the
recreated item; the Rescue Log keeps its record. Rollback points cover
documents only: files, and writes made in another window, are not covered.

### HP handling

`foundry_apply_damage` plans against live HP and applies the requested positive
amount through the serialized write lane. Damage consumes temporary HP before
ordinary HP. It does not adjudicate DR or resistances. The commit runs as a
recorded write, so its point holds each actor it touched. Lethal outcomes apply
at once behind that point and are flagged in the summary and the result.

### Macro Mirror

The configured root must already exist. The mirror resolves it before use,
skips links, and verifies each destination remains inside that root. Backup
rotation overwrites `<Name>.js.bkp` with the prior primary and never deletes a
file. Each restore has a persisted rollback point.

### Internal dispatch and interrupts

In internal mode, a capable Kimi client starts one background coder subagent
for each permitted working tab and immediately returns to long polling. This
remains mandatory in single task internal mode: one subagent handles the
active tab while the listener continues polling. The listener owns
`foundry_get_prompts` and the `tabId` to `agentId` map.

A follow up sent to a working tab is returned as an `interrupt:true` prompt.
The listener forwards it immediately to that tab's subagent. It does not wait
for the earlier task to finish. If no subagent tools exist, the listener serves work
synchronously and calls `foundry_get_interrupts` at safe checkpoints. That call
removes returned interrupts from the ordinary queue, preventing duplicate work.

Closing a tab stops its subagent and drops queued work, though a subagent
already mid call may finish one more tool call before the stop lands. Without
a way to stop it, already running synchronous work cannot be interrupted.

## Protocol additions

The `hello` payload includes the world settings snapshot. Later changes use
`settings.sync`. Relay notifications use the `aagm.*` namespace, including
prompt, reply, status, interaction mode, rollback, listener refusal, and
`aagm.tabs` messages. `tabId` travels on prompts, replies, rollback notices, and
write requests. Closing a tab sends `aagm.prompt` with `/close`; the queue
delivers a `close:true` prompt plus a once drained `closedTabs` list to the
listener. `aagm.status.request` returns the full tab table after a Foundry
reload.

`foundry_ping` returns Foundry liveness, the full relay enforced `settings`
snapshot, the current `interactionMode`, and the active session log path.
`foundry_get_prompts` returns prompts, tabs, closed tabs, termination state,
and interaction mode. `foundry_get_interrupts` checks one working tab without
blocking. `foundry_set_interaction_mode` switches internal and external
dispatch.

`foundry_session_logs` lists Markdown audit files and
`foundry_read_session_log` reads one. Session logs are live in root `Logs` and
use the filename form `Month day HH.MM.SS.md`. A new file begins with each
relay run and immediately appends prompts, replies, mode changes, MCP calls,
bridge commands and results, writes, rollback points, errors, and lifecycle
events.

## Compatibility notes

- Foundry 12, verified at 12.343
- Pathfinder 1e 11.11
- Node.js 22 or newer
- Plain JavaScript ES modules
- No bundler or build step

Live Foundry verification is still required for Dialog rendering, settings lock states, Item Piles hooks, and document creation APIs.
