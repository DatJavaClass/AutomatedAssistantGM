# AAGM-G

AAGM-G 2.0 is the Grok Build CLI client for this Foundry bridge. The relay
speaks Model Context Protocol on localhost. Foundry holds no model key.

## How Grok attaches

Grok Build CLI reads `.grok/config.toml` in this repository when the folder
is the working directory. Put the same block in `~/.grok/config.toml` when
it is not. The checked-in file is the client config, not session state.

```toml
[mcp_servers.aagm-g]
url = "http://127.0.0.1:7891/mcp"
enabled = true
tool_timeout_sec = 300
```

`http://127.0.0.1:7891/mcp` is the Streamable HTTP MCP endpoint. A one shot
invocation is `grok -p "prompt"`. The inside chat loop is the listener
prompt at `relay/LISTENER_PROMPT.md`.

`tool_timeout_sec` is 300 seconds. Writes and rollbacks use that same limit
on MCP tool calls and on the typed `/rollback` command.

## Ports

| Service | Address |
|---|---|
| Foundry WebSocket | `ws://127.0.0.1:7890` |
| MCP | `http://127.0.0.1:7891/mcp` |

Both servers refuse any bind that is not loopback.

## One task, or background workers

Assistant Mode is the default. It forces multitasking off. Grok serves a
single task. The tab id is `t-main`.

Co-GM Mode forces multitasking on. The chat box shows up to five tabs. The
listener keeps polling `foundry_get_prompts` and may start one background
worker per tab. Grok Build CLI can run those workers. The relay does not
start them. If the session is not using background workers, the listener
serves the open tabs one at a time. Custom mode leaves the toggle as set.

## What 2.0 keeps and what it dropped

Document writes run at once and leave a rollback point of the documents
they touched. There is no per write approval card and no chain of writes.
`/rollback` and `foundry_rollback` roll back to before a point, newest first,
and record a `redo` point. A point where any document failed to restore is
named partial.

The original plugin pack and the unfinished macro workshop are not in this
tree. Loot Watchdog and Macro Mirror stayed.

## Identity

| Slot | Value |
|---|---|
| Module id | `aagm-g` |
| Relay package | `aagm-g-relay` |
| MCP server name | `aagm-g-relay` |
| Chat macro | Open AAGM-G Chat |
| Loot macro | AAGM-G Loot Watchdog |
