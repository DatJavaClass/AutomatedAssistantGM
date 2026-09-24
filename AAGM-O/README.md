# AAGM-O

**Automated Assistant Game Master - OpenAI**

AAGM-O puts Codex or ChatGPT behind your Foundry GM screen. Locally.

Version 2.0 replaces confirmation gates with rollback points and adds prompt interrupts, internal and external work modes, and complete local session logs.

Two loopback ports. One GM tab. Zero OpenAI keys in Foundry.

The module connects a running Foundry world to an OpenAI client through a localhost-only Model Context Protocol relay. Model access, authentication, and tool selection stay inside Codex or the ChatGPT desktop app. AAGM-O is the OpenAI sibling of AAGM-C, not a plug-in for it.

Test target:

- Foundry VTT 12, build 343
- Pathfinder 1e 11.11
- Node.js 22 or newer

## How it works

Two pieces. That is it.

- **Foundry module:** Runs in one GM browser tab, connects to the relay over WebSocket, and executes a controlled handler set.
- **Relay:** Runs on the same computer, exposes Streamable HTTP MCP to the OpenAI client, routes JSON-RPC messages, persists rollback points, and serializes writes.

The relay binds only to loopback addresses. No cloud service can reach it directly.

See [Architecture](Docs/ARCHITECTURE.md) for the full data flow and [Migration Inventory](Docs/MIGRATION.md) for the original-version reconstruction record.

## Safety boundaries

The safety boundary is persistence and scope. Reads run immediately. Every
supported Foundry write runs at once while the module records the before state
of the documents the write touched, through Foundry document hooks.

- Document and world setting evals, damage, macro restore, and Loot Watchdog
  restoration each create a rollback point holding the documents the write
  touched: updates keep their before state, creates keep their id, deletes keep
  their full data.
- `foundry_rollback` rolls back to before a selected point, or the newest live
  one by default: that point and every later live point are undone newest
  first. Documents the points did not touch are left alone.
- Rolling back records what it changed as a new `redo` point, so rolling that
  point back redoes the work.
- A failed write is not undone automatically. The documents it touched before
  failing still land in a point, and the error names that point.
- The relay and the module both serialize writes, so concurrent workers cannot
  overlap world changes.
- Side effects that a rollback point cannot reverse are refused.
- Protected database journals are blocked.
- Evaluated results are depth and size capped.
- The relay and WebSocket server refuse non localhost binding.
- One listener owns the chat queue at a time.
- Macro Mirror never deletes files or writes outside its configured root.
- Protected database journals never enter a rollback point and are never
  restored.
- Session audit logs and rollback points remain local to the repository root.

Rollback points cover documents only: files, and writes made in another window,
are not covered. A rollback is not a database transaction. Each document is
restored and reported on its own; a point where any document failed is marked
`partial`, never success.

These controls are load bearing. Bypass them and the bridge stops being the
bridge.

## Development installation

### 1. Install the Foundry module

Copy the contents of `module/` into a Foundry module folder named `aagm-o`:

```text
FoundryVTT/Data/modules/aagm-o/
  module.json
  lang/
  scripts/
```

Enable **AAGM-O: Automated Assistant Game Master - OpenAI** in the target world.

### 2. Install the relay

```powershell
cd relay
npm install
```

Open `relay/config.json`. Replace `<YOUR_GM_USER_ID>` with the result of `game.user.id` from the Foundry browser console. Keep the capability set as `gm`.

Loot Watchdog also requires the Item Piles module and a Rescue Log journal. Before deployment, replace every `REPLACE_WITH_RESCUE_LOG_JOURNAL_ID` occurrence with that journal's ID. The placeholder appears in the watchdog macro, its handlers, and the relay denylist.

### 3. Register MCP

Codex CLI:

```powershell
codex mcp add aagm-o --url http://127.0.0.1:7889/mcp
codex mcp list
```

ChatGPT desktop:

1. Open **Settings > MCP servers**.
2. Add a **Streamable HTTP** server.
3. Name it `aagm-o`.
4. Use `http://127.0.0.1:7889/mcp`.
5. Save, then restart the client.

ChatGPT web does not read local MCP configuration. AAGM-O intentionally remains localhost-only, so hosted web use is outside this build.

## Run AAGM-O

Start the relay:

```powershell
cd relay
npm start
```

Expected output:

```text
[relay] ready - WS on ws://127.0.0.1:7888, MCP on http://127.0.0.1:7889/mcp
```

In Foundry:

1. Enable the AAGM-O bridge in one GM tab.
2. Open **Configure Settings > AAGM-O Settings** and select a mode.
3. Leave the bridge disabled in every other tab using the same GM account.
4. Run the auto-created **Open AAGM-O Chat** macro.
5. Run **AAGM-O Loot Watchdog** once to arm it when Item Piles rescue is needed.

In Codex or ChatGPT desktop, verify the bridge with `foundry_ping`.

## Start the Foundry chat listener

Use the complete behavior prompt in
[`relay/LISTENER_PROMPT.md`](relay/LISTENER_PROMPT.md). It requires one stable
`listenerId`, reads the relay enforced posture at startup, and defines
interrupt, rollback, log, mode, and worker behavior.

The minimal polling core is:

```text
Generate one listenerId and reuse it on every foundry_get_prompts and
foundry_get_interrupts call. Poll back to back, answer through
foundry_send_reply, and stop on terminate or -33005 listener-occupied.
```

The MCP call long polls for about 25 seconds, so the client should not add
sleeps between calls. Foundry shows **Ready to chat** while a listener is active.

Internal Foundry chat is the default. `/int` returns to internal dispatch.
`/ext` switches to external Codex work, cancels queued internal prompts, stops
internal workers, and suspends their replies and writes until `/int` is
received. `foundry_set_interaction_mode` provides the same control through MCP.

A follow up sent to a working tab is an interrupt. A client with agent tools
forwards it to that worker at once and keeps the listener polling, including in
single task internal mode where exactly one worker must remain active. A client
without agent tools serves synchronously and checks `foundry_get_interrupts`
at safe checkpoints.

Every supported write creates a point in root `Rollback Points`, one JSON file
per point under a folder per day; today's points survive a relay restart. The
chat card shows what was captured and the first documents. Use the card's
Rollback button, `/rollback [pointId]` in the chat, or call
`foundry_rollback` directly. Active session logs are Markdown files in root
`Logs`, named as `Month day HH.MM.SS.md`.

Stop the listener with `/exit`, `/stop`, or `/quit` in the Foundry chat box. The
local `relay/.loop-stop` file is the emergency stop.

## MCP tools

Read tools:

- `foundry_ping`
- `foundry_query_actor`
- `foundry_query_scene`
- `foundry_query_macro`
- `foundry_query_journal`
- `foundry_query_user`
- `foundry_tail_logs`
- `foundry_rollback_points`
- `foundry_session_logs`
- `foundry_read_session_log`

Write tools with persisted rollback points:

- `foundry_eval`
- `foundry_apply_damage`
- `foundry_restore_loot`
- `foundry_mirror_restore`
- `foundry_rollback`

Chat and mode tools:

- `foundry_get_prompts`
- `foundry_get_interrupts`
- `foundry_send_reply`
- `foundry_set_status`
- `foundry_set_interaction_mode`

Rescue and mirror reads:

- `foundry_loot_pending`
- `foundry_mirror_backup`
- `foundry_mirror_backups`

## Repository layout

```text
module/                  Foundry VTT module
  scripts/bridge.js      Settings, module API, dispatch
  scripts/ws-client.js   WebSocket lifecycle
  scripts/chat-macro.js  GM chat, mode, and rollback UI
  scripts/loot-macro.js  Manual Item Piles watchdog
  scripts/settings-*.js  World mode settings UI
  scripts/rollback-recorder.js  Hook capture for recorded writes
  scripts/handlers/      Foundry command handlers
relay/                   Local Node.js relay
  index.js               Process bootstrap
  src/mcp-server.js      MCP tools, rollback, and write serialization
  src/ws-server.js       Bridge authentication
  src/dispatcher.js      Request routing and notifications
  src/prompt-queue.js    Long-poll chat queue
  src/eval-guard.js      Eval classifier
  src/world-settings.js  Relay-enforced posture
  src/rollback-store.js  Rollback points and the rollback chain
  src/mirror.js          Scoped macro backup storage
  src/write-queue.js     Serialized write lane
  src/audit.js           Markdown session audit logs
Docs/                    Architecture and migration records
```

## Testing

```powershell
cd relay
npm test
```

Foundry runtime acceptance still requires a Foundry VTT 12.343 world running Pathfinder 1e 11.11. Verify the settings form, listener refusal toast, interrupts, interaction mode switching, recorded rollback points, chained and partial rollback, redo, Item Piles hooks, macro restore, and session log retrieval before packaging.

## License

MIT. See [LICENSE](LICENSE).

AAGM-O is not affiliated with or endorsed by OpenAI, Paizo Inc., Foundry Gaming LLC, or The Forge. Pathfinder, Foundry VTT, and other product names remain the property of their respective owners.
