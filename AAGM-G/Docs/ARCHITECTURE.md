# AAGM-G Architecture

## Current scope

AAGM-G 2.0 connects one authenticated Foundry GM browser session to Grok. Foundry holds no API key. Both servers bind only to loopback. Writes do not wait on an approval card. Each write runs at once and leaves a rollback point of the documents it touched. A new prompt while work is running interrupts the next action. /int (the default) means the Foundry chat is driving. /ext means Grok outside Foundry is driving.

Who owns policy? The relay. It enforces settings, listener ownership, interrupts, rollback points, and Macro Mirror filesystem access.

The `gm` capability set supports reads, log capture, rollback backed JavaScript, serialized damage, loot rescue, chat, settings-aware operation, and mirrored macro backup and restore.

## Component map

```text
Grok, in Foundry or outside it
                  |
        Streamable HTTP MCP
     http://127.0.0.1:7891/mcp
                  |
          Local Node.js relay
 policy, interrupts, rollback, log, tabs, mirror
                  |
          JSON-RPC WebSocket
        ws://127.0.0.1:7890
                  |
        Foundry module in GM tab
 handlers, tabbed chat, rollback recorder and cards
                  |
          Foundry VTT world
```

## Foundry module

`module/scripts/bridge.js` registers settings, provisions the **Open AAGM-G Chat** and **AAGM-G Loot Watchdog** macros, connects the relay, dispatches handlers, and exposes the chat API. Player clients do not connect.

`module/scripts/settings-def.js` registers mode, multitasking, and the Macro Mirror values. `module/scripts/settings-menu.js` is the only module Application class and provides Assistant, Co-GM, and Custom modes. The module publishes settings in `hello` and `settings.sync`. The relay validates and enforces them.

`module/scripts/chat-macro.js`:

- Sends prompts and renders replies as text.
- Shows up to five task tabs when multitasking is enabled. The relay owns
  their titles, states, and last 40 transcript lines; reopening the box
  rebuilds them from the relay.
- Accepts Foundry document drops as `@UUID` references.
- Shows listener status and whether the session is /int or /ext.
- Shows a rollback card after each write: what was captured (counts per op)
  and the first documents, with a Rollback button while the point is live.
- A message sent while a tab is working is an interrupt.

The handler boundary contains:

| Handler | Purpose |
|---|---|
| `ping` | World and session liveness |
| `query.*` | Actor, scene, macro, journal, and user reads |
| `logs.*` | Filtered console forwarding |
| `eval` | Capped JavaScript execution |
| `damage` | Serialized damage, lethal flagged not gated |
| `loot.*` | Constrained rescue queue reads and restores |
| `mirror.*` | Macro reads and rollback backed restore |
| `rollback.apply` | Restores one point's entries, newest first |

`module/scripts/rollback-recorder.js` installs Foundry document hooks on
`ready`. A request carrying `params.rp` runs inside `runRecorded`, one
recording at a time on a promise chain. `preUpdate` keeps the before state of
each updated document (earliest state wins), `preCreate` plus `create` keep
the uuids of created documents (tagged through `options._aagmRp`), and
`preDelete` keeps the full data of deleted ones with `parentUuid` and `pack`.
Documents on the eval guard deny list (by id, by name, or holding a
`runManaged` page) are never recorded. The result carries `rollback.entries`;
a thrown handler carries them in the JSON-RPC error data.

The Loot Watchdog requires Item Piles and a deployed Rescue Log journal UUID. Its source ships with `REPLACE_WITH_RESCUE_LOG_JOURNAL_ID` until deployment supplies the real ID.

## Relay

`relay/index.js` composes these policy components:

| Component | Responsibility |
|---|---|
| `ws-server.js` | Loopback WebSocket, hello validation, capabilities |
| `dispatcher.js` | Requests, responses, and notifications |
| `mcp-server.js` | Public MCP tools, interrupt check, rollback writes |
| `prompt-queue.js` | Chat queue, /int and /ext, interrupt flags |
| `tabs.js` | Per-task state and transcript table |
| `world-settings.js` | Validated relay-owned posture cache |
| `rollback-store.js` | Rollback points, index, and rollback chain |
| `audit.js` | Stdout line plus the dated markdown log |
| `mirror.js` | Scoped backup, rotation, and restore reads |
| `write-queue.js` | One serialized lane for all writes |
| `eval-guard.js` | Read, mutation, delete, side effect, journal classification |

The listener generates one `listenerId` and reuses it. A competing listener receives JSON-RPC `-33005`, the GM receives a toast, and the slot releases on terminate or 45 seconds of quiet.

## Safety model

### Local transport

Both servers hard-fail non-loopback bind configuration. The WebSocket server also rejects non-loopback peers.

### Relay-owned posture

The module is the settings surface. The relay is the authority. Assistant Mode forces multitasking off. Co-GM forces it on. Custom accepts the individual value.

### Serialized writes

Eval writes, damage, mirror restores, rollbacks, and loot restore share one relay queue, and the module recorder runs them one at a time, so two points cannot interleave.

### Rollback points

Reads run immediately. For every supported write, the relay opens a point id
(`rp-` plus six hex digits) and sends the write with `params.rp = { id }`; the
module runs it inside the recorder. The point holds the documents the write
touched, not the world. The tool result includes `rollbackPoint` with `id`,
`captured`, and `docs`. A failed write is not undone automatically: documents
touched before the failure still become a point, and the error names it.
Chat messages, socket emits, hook calls, and sheet activation are refused
because a rollback point cannot undo them.

A point is `{ id, ts, summary, tabId, kind, entries, state }`, one JSON file
per point in `Rollback Points/<date>/`. The relay keeps an index of up to 200
points and reloads today's on start. `/rollback` or `foundry_rollback` rolls
back to before a point: it and every later live point are undone newest
first, one `rollback.apply` request per point with a 300 second timeout, one
rollback at a time. Updates are rewritten from their record (`_id`, `_stats`,
`type`, and embedded collections stripped; a Token with `actorLink` true
never gets `delta`), created documents are deleted, and deleted ones are
recreated with `keepId`. A rollback never deletes a document the point did
not create. Each point ends `rolled-back` or, when any entry failed,
`partial`. A bridge error stops the chain.

Redo: each `rollback.apply` is itself recorded, and what the rollback changed
becomes a new live point of kind `redo`. Rolling it back redoes the work.

Protected database journals, including the Loot Watchdog Rescue Log, never
enter a point and are never restored. Rolling back a loot restore removes the
recreated item; the Rescue Log keeps its record. Rollback points cover
documents only: files, and writes made in another window, are not covered.

### Interrupt

A prompt that arrives while its tab is working, while a tool is in flight, or while the session is external is marked `interrupt`. The next Foundry tool returns `{ interrupted: true, prompts }` and does not do the old work. A tool that has already started still finishes. `foundry_tail_logs` checks during its wait and returns early.

### /int and /ext

`/int` is the default. The Foundry chat drives Grok through `foundry_get_prompts`. `/ext` means the GM is talking to a Grok outside Foundry. The inside listener's next poll returns `{ hold: true }` and should stop. Prompts already queued at the switch are parked; `/int` puts them back at the front of the queue and wakes the listener. Messages typed in the box after the switch stay queued and ride the next outside tool call. `foundry_set_interaction_mode` is the same switch from MCP.

### HP handling

`foundry_apply_damage` plans against live HP, then commits with `rp` like any write. Targets are written in sequence. Lethal outcomes apply at once behind the point; the result flags `lethal` and the point label says so. The point is how you undo it.

### Macro Mirror

The configured root must already exist. The mirror resolves it before use, skips links, and verifies each destination remains inside that root. Backup rotation overwrites `<Name>.js.bkp` with the prior primary and never deletes a file. Restore is a rollback backed write.

### Agentic multitasking

When enabled, Grok may assign one background agent per tab while the main listener keeps polling. Each agent replies and calls tools with its own `tabId`. All writes still use the serialized lane. If a tool returns `interrupted: true`, that agent stops and does the new prompt.

If Grok is not running background agents, the same setting remains valid and the listener serves tabs synchronously. Closing a tab drops queued work. It cannot stop a tool call that has already started.

## Protocol additions

The `hello` payload includes the world settings snapshot. Later changes use `settings.sync`. Relay notifications use the `aagm.*` namespace, including prompt, reply, status, mode, rollback, listener refusal, and `aagm.tabs`. `tabId` travels on prompts, replies, and rollback events. Closing a tab sends `aagm.prompt` with `/close`. The queue delivers a `close:true` prompt plus a once-drained `closedTabs` list. `aagm.status.request` returns the full tab table and resyncs the rollback cards.

`foundry_ping` returns Foundry liveness, the assistant `mode`, `interactionMode` (`internal` or `external`), `parked` (prompts held by `/ext`), and the current log path.

## Log

Each relay start writes one markdown file under `Logs/`. The name is the month, the day, and the start time, for example `September 24 14.05.06.007.md`. Every audit event is a heading with the local time and a JSON block. `/log` in the chat box tails the current file. `foundry_session_logs` and `foundry_read_session_log` read them from MCP.

## Compatibility notes

- Foundry 12, verified at 12.343
- Pathfinder 1e 11.11
- Node.js 22 or newer
- Plain JavaScript ES modules
- No bundler or build step

Live Foundry verification is still required for Dialog rendering, settings lock states, Item Piles hooks, and document creation APIs.
