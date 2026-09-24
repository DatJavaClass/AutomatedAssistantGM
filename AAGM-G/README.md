# AAGM-G

**Automated Assistant Game Master - Grok**

AAGM-G 2.0 puts Grok behind your Foundry GM screen. Locally.

Two loopback ports. One GM tab. No model key in Foundry.

The module connects a running Foundry world to Grok Build CLI through a
localhost-only Model Context Protocol relay.

Test target:

- Foundry VTT 12, build 343
- Pathfinder 1e 11.11
- Node.js 22 or newer

## What 2.0 changes

Four things.

**Interrupt.** If Grok is already on Foo and you send Foo+, the next tool
call stops Foo and starts Foo+. A call that has already reached Foundry
still finishes. You do not wait for the rest of the plan.

**Rollback points.** Approval cards are gone. A document write runs at once
while the module records the documents that write touched, and the relay
stores them as a point under `Rollback Points/`. If the change is wrong,
`/rollback` puts those documents back. The rollback records what it changed
as a `redo` point, so you can undo the undo. Chat messages, sockets, hook
calls, and opening a sheet are refused, because a rollback point cannot undo
them.

**`/int` and `/ext`.** `/int` is the default. You are talking in the Foundry
chat box. `/ext` means you are talking to a Grok outside Foundry. The inside
listener stands down. Prompts already queued when you switch are parked
until `/int` brings them back. Lines you type in the box after the switch are
held and handed to that outside Grok on its next Foundry action.

**The log.** Each relay start writes one markdown file in `Logs/`. The name
is the month, the day, and the start time, such as
`September 24 14.05.06.007.md`. Everything the relay does is a timed heading
in that file. `/log` tails it in the chat box.

## How it works

- **Foundry module:** one GM tab, WebSocket to the relay, a fixed handler set.
- **Relay:** Streamable HTTP MCP for Grok, JSON-RPC to Foundry, rollback
  files, the log, and the chat queue.

The relay binds only to loopback.

See [Architecture](Docs/ARCHITECTURE.md).

## Safety boundaries

The safety boundary is the rollback point, plus a few hard refusals.

- Reads run immediately.
- A document write runs at once, then returns `rollbackPoint` with its id,
  `captured` (counts per op), and the first `docs`. The point holds the
  documents the write touched: updates keep their before state, creates keep
  their id, deletes keep their full data.
- `/rollback` and `foundry_rollback` roll back to before a point: that point
  and every later live point are undone newest first. Documents the points did
  not touch are left alone.
- A rollback records what it changed as a new `redo` point. Rolling that point
  back redoes the work.
- A failed write is not undone automatically. The documents it touched before
  failing still land in a point, and the error names that point.
- Protected database journals are blocked, including reads, and never enter
  a point. Rolling back a loot restore removes the recreated item; the Rescue
  Log keeps its record.
- Evaluated results are depth and size capped.
- The relay refuses a non-localhost bind.
- One listener owns the chat queue at a time.
- Macro Mirror never deletes files or writes outside its configured root.

Rollback points cover documents only: files, and writes made in another
window, are not covered. A rollback is not a database transaction. Each
document is restored and reported on its own; a point where any document
failed is marked `partial`, never success.

## Development installation

### 1. Install the Foundry module

Copy the contents of `module/` into a Foundry module folder named `aagm-g`:

```text
FoundryVTT/Data/modules/aagm-g/
  module.json
  lang/
  scripts/
```

Enable **AAGM-G: Automated Assistant Game Master - Grok** in the target world.

### 2. Install the relay

```powershell
cd relay
npm install
```

Open `relay/config.json`. Replace `<YOUR_GM_USER_ID>` with the result of
`game.user.id` from the Foundry browser console. Keep the capability set as
`gm`.

Loot Watchdog also requires the Item Piles module and a Rescue Log journal.
Before deployment, replace every `REPLACE_WITH_RESCUE_LOG_JOURNAL_ID`
occurrence with that journal's ID.

### 3. Register MCP with Grok Build CLI

Grok Build CLI reads `.grok/config.toml` in this folder when the folder is
the working directory. The same block in `~/.grok/config.toml` applies when
it is not. This repository already has the project file:

```toml
[mcp_servers.aagm-g]
url = "http://127.0.0.1:7891/mcp"
enabled = true
tool_timeout_sec = 300
```

That URL is the relay's Streamable HTTP MCP endpoint. `tool_timeout_sec`
is 300 seconds. Every write and every rollback, from a tool call or the typed
`/rollback` command, waits up to that same 300 second limit.

AAGM-G stays on localhost. A hosted Grok session cannot reach it.

Ports are 7890 for the Foundry WebSocket and 7891 for MCP.

Assistant Mode is the default, and it forces multitasking off. Grok then
serves a single task on tab `t-main`. Co-GM Mode forces multitasking on.
The chat box shows up to five tabs, and the listener may run one background
worker per tab while it keeps polling. Grok Build CLI can run those
workers. The relay does not start them. If the session is not using
background workers, the same tabs are served one at a time. The listener
prompt is [`relay/LISTENER_PROMPT.md`](relay/LISTENER_PROMPT.md).

## Run AAGM-G

Start the relay:

```powershell
cd relay
npm start
```

Expected output:

```text
[relay] ready - WS on ws://127.0.0.1:7890, MCP on http://127.0.0.1:7891/mcp
```

`Start-AAGM-G.ps1` starts that relay and does not launch Grok. Open Grok
Build CLI yourself and point it at the listener prompt when you want the
inside chat loop. An outside session (`/ext`) just calls the tools. A one
shot check is `grok -p "prompt"`.

In Foundry:

1. Enable the AAGM-G bridge in one GM tab.
2. Open **Configure Settings > AAGM-G Settings** and select a mode.
3. Leave the bridge disabled in every other tab using the same GM account.
4. Run the auto-created **Open AAGM-G Chat** macro.
5. Run **AAGM-G Loot Watchdog** once to arm it when Item Piles rescue is needed.

In Grok, verify the bridge with `foundry_ping`.

## Chat commands

| Command | Effect |
|---|---|
| `/int` | Default. This Foundry chat drives Grok. |
| `/ext` | Grok outside Foundry drives. This listener stands down. Queued prompts park until `/int`. |
| `/log` | Tail the current markdown log into the chat. |
| `/rollback` | Roll back the newest live point. |
| `/rollback <id>` | Roll back to before that point, newest first. |
| `/exit`, `/stop`, `/quit` | Stop the inside listener. |

A normal message while a tab is working is the interrupt. You do not need a
separate slash for Foo+.

## Start the Foundry chat listener

Use [`relay/LISTENER_PROMPT.md`](relay/LISTENER_PROMPT.md). One stable
`listenerId`. Poll `foundry_get_prompts` with no added sleep. Stop on
`terminate`, on `hold: true`, or on `-33005`.

The local `relay/.loop-stop` file is the emergency stop.

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

Write tools, each one behind a rollback point:

- `foundry_eval`
- `foundry_apply_damage`
- `foundry_mirror_restore`
- `foundry_restore_loot`
- `foundry_rollback`

Chat and session:

- `foundry_get_prompts`
- `foundry_get_interrupts`
- `foundry_send_reply`
- `foundry_set_status`
- `foundry_set_interaction_mode`

Mirror reads:

- `foundry_mirror_backup`
- `foundry_mirror_backups`
- `foundry_loot_pending`

## Repository layout

```text
module/                  Foundry VTT module
  scripts/bridge.js      Settings, module API, dispatch
  scripts/chat-macro.js  GM chat, interrupt line, rollback cards
  scripts/rollback-recorder.js  Hook capture for recorded writes
  scripts/handlers/      Foundry command handlers, including rollback.js
relay/                   Local Node.js relay
  src/mcp-server.js      MCP tools, interrupt check, rollback writes
  src/prompt-queue.js    Chat queue, /int, /ext, interrupts
  src/rollback-store.js  Rollback points and the rollback chain
  src/audit.js           Stdout plus Logs/*.md
  src/write-queue.js     One write at a time
Logs/                    Month, day, time markdown logs
Rollback Points/         One JSON file per point, a folder per day
```

## Testing

```powershell
cd relay
npm test
```

Foundry runtime acceptance still needs a Foundry VTT 12.343 world on
Pathfinder 1e 11.11. The relay tests do not open Foundry.

## License

MIT. See [LICENSE](LICENSE).

AAGM-G is not affiliated with or endorsed by xAI, Paizo Inc., Foundry Gaming
LLC, or The Forge. Pathfinder, Foundry VTT, and other product names remain
the property of their respective owners.
