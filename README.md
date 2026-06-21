<p align=center> <img width="220" height="307" alt="dancing-bender" src="https://github.com/user-attachments/assets/83db7a2b-c687-4c1a-bbb7-84b7740953ed" /> </p>


# AAGM — Foundry ↔ Claude Bridge

A localhost bridge between a Forge-hosted **Foundry VTT v12** world (Tested on Pathfinder 1e, should work on other systems) and **Claude** (Code or Chat). Two pieces:

- **`relay/`** — a Node process on your machine. Runs the WebSocket server (talks to the Foundry module) and the MCP server (talks to Claude) in one process. Localhost-only.
- **`module/`** — the `foundry-bridge` module (v0.5.0) running in the GM's browser tab. Opens a WebSocket out to the relay.

Claude reaches Foundry **only** through the relay, and every write passes a confirmation gate.

---

## Installation

The bridge has two installable halves — the **Foundry module** and the **relay**.

**1. Foundry module** — in Foundry / Forge → *Install Module → Manifest URL*, paste:
```
https://github.com/DatJavaClass/AutomatedAssistantGM/releases/latest/download/module.json
```
This resolves once a GitHub release with `module.json` + `module.zip` attached is published. You'll enable the module later (see Setup → running a session).

**2. Relay + source** — clone the repo (or use your existing working copy):
```
git clone https://github.com/DatJavaClass/AutomatedAssistantGM.git
```
The relay lives in `relay/`; the module files sit at the repo root (standard Foundry-module layout).

Then continue to **Setup**.

---

## A) Setup (one-time)

### 1. Relay dependencies
Needs **Node ≥ 22**. From the cloned repo root:
```
cd relay
npm install
```

### 2. Set the GM userId
`relay/config.json` maps Foundry **userIds** to capability sets. Add your GM's id: in Foundry, open the console (F12) → run `game.user.id`, and paste the bare string as a key under `"users"` (give it `"capabilitySet": "debug"`). The `userName` beside it is a human-readable comment only — the relay matches on the id, not the name.

### 3. Register the MCP endpoint with Claude Code
```
claude mcp add foundry-bridge --transport http http://127.0.0.1:7879/mcp
```
Add `--scope user` if you want the tools available from any directory.

> **Restart rule.** Claude Code loads MCP tools at startup and caches the tool list. After `claude mcp add` — or after the relay gains any new `foundry_*` tool — **fully quit and relaunch Claude Code**, then restart your loop. A new in-app session is not enough.

---

## B) Using it once deployed

**The primary workflow is the chat box + an external loop, and it works end-to-end.** With the relay up and a Claude Code `/loop` polling, you operate the whole world conversationally from the "Open Claude Code Chat" macro — Claude handles real GM work: fixing corrupted actors, moving tokens, running combat for them — with each write clearing the Approve/Deny gate. The raw MCP tools listed below are the surface that loop is built on.

### Start a session
1. **Start the relay** from the repo root (leave it running):
   ```
   cd relay
   npm start
   ```
   Wait for `[relay] ready — WS on ws://127.0.0.1:7878, MCP on http://127.0.0.1:7879/mcp`.
2. **Enable the bridge in exactly ONE GM window.** Foundry → *Configure Settings → Module Settings → enable the bridge*. You should see "Foundry-Claude bridge connected" and a `bridge.connected` line in the relay's stdout.
   > A second Foundry tab on the same GM userId is rejected (WS close `4002`). Keep the bridge on in only one window.
3. **In Claude Code**, `/mcp` should show `foundry-bridge` connected. Sanity-check with `foundry_ping` → expect `{ pong: true, worldId: "<your-world>", ... }`.

### What Claude can do (MCP tools)
- **Read:** `foundry_ping`, `foundry_query_actor`, `foundry_query_scene`, `foundry_query_macro`, `foundry_query_journal`, `foundry_query_user`, `foundry_tail_logs`.
- **Eval:** `foundry_eval` runs JS in the GM client. Reads run freely; mutating/destructive code is reclassified at the relay and routed through the confirmation gate. DB-backing journals are hard-refused.
- **Damage:** `foundry_apply_damage` is the **only** HP path and enforces an **absolute ≥1 HP floor** — Claude can never drop an actor below 1 HP. Lethal is human-only. HP changes via `foundry_eval` are blocked.
- **Chat channel:** `foundry_get_prompts` / `foundry_send_reply`.
- **Workshop:** `foundry_workshop_set` / `foundry_workshop_get`.

### Two GUI surfaces (auto-created macros in Foundry)
Both appear in your macro directory once the bridge connects:
- **"Open Claude Code Chat"** — the in-Foundry chat box. To use it: in Claude Code run a tight loop that calls `foundry_get_prompts` (it long-polls ≤25s) and answers with `foundry_send_reply`, e.g. `/loop 2s` instructed to call `foundry_get_prompts` back-to-back. Open the macro: it shows "Ready to chat" once the loop polls; type → Claude answers in the box. Write requests render an **Approve/Deny** card (deletes need a **double** confirm).
- **"Claude Macro Workshop"** — editor window for refactoring macros with Claude. Save is user-initiated (rolls a `<name>.old` backup, keeps the macro id). NOTE: THIS IS A WIP!

### Stop
- End the chat loop: type `/exit` in the box, or `touch relay/.loop-stop`.
- Stop the relay: `Ctrl+C`.

### Safety gates (do not bypass)
Confirmation gate on all writes · double-confirm on deletes · ≥1 HP floor (lethal = human-only) · DB-journal access refused · relay binds localhost only. These are load-bearing — never weaken them.

---

## Troubleshooting (quick hits)
| Symptom | Fix |
|---|---|
| `/mcp` shows foundry-bridge failed | Relay not running on `127.0.0.1:7879`. Start it; check stdout. |
| `foundry_ping` → "no bridge connected" | Module didn't reconnect after a relay restart. Toggle the bridge setting off/on; watch for a new `bridge.connected` line. |
| New `foundry_*` tool missing | Fully quit and relaunch Claude Code (tool list is cached). |
| `hello.reject "unknown userId"` | `game.user.id` doesn't match `relay/config.json`. |
| `hello.reject "duplicate userId"` | Two Foundry tabs as the same GM. Close one. |

---

> ⚠️ **Known operator hazard: Claude's Fireball obsession.** The assistant driving this bridge has been observed reaching for *Fireball* as the answer to essentially any problem — including corrupted actors (immune: they're JSON), incorporeal threats, and the occasional merge conflict. If a fix proposal includes "and then a 8d6 evocation," apply the ≥1 HP floor, deny the gate, and gently suggest a saving throw. The spell list is wider than it looks.

