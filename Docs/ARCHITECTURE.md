# AAGM-O Architecture

## Current scope

AAGM-O connects one authenticated Foundry GM browser session to a local OpenAI client. Foundry holds no API key. Both servers bind only to loopback.

Who owns policy? The relay. It enforces settings, listener ownership, confirmations, Chain Mode, and Macro Mirror filesystem access.

The `gm` capability set supports reads, log capture, gated JavaScript, atomic damage, loot rescue, chat, settings-aware operation, and mirrored macro backup and restore.

## Component map

```text
Codex CLI, Codex IDE, or ChatGPT desktop
                  |
        Streamable HTTP MCP
     http://127.0.0.1:7889/mcp
                  |
          Local Node.js relay
 policy, gates, queue, chain, mirror
                  |
          JSON-RPC WebSocket
        ws://127.0.0.1:7888
                  |
        Foundry module in GM tab
 handlers, chat, settings, approvals
                  |
          Foundry VTT world
```

## Foundry module

`module/scripts/bridge.js` registers settings, provisions the **Open AAGM-O Chat** and **AAGM-O Loot Watchdog** macros, connects the relay, dispatches handlers, and exposes the chat API. Player clients do not connect.

`module/scripts/settings-def.js` registers eight world-scoped values. `module/scripts/settings-menu.js` is the only module Application class and provides Assistant, Co-GM, and Custom modes. The module publishes settings in `hello` and `settings.sync`. The relay validates and enforces them.

`module/scripts/chat-macro.js`:

- Sends prompts and renders replies as text.
- Accepts Foundry document drops as `@UUID` references.
- Shows listener and background-work status.
- Renders single and double confirmation cards.
- Shows live Chain Mode progress and cancellation.
- Denies pending writes when closed.

The handler boundary contains:

| Handler | Purpose |
|---|---|
| `ping` | World and session liveness |
| `query.*` | Actor, scene, macro, journal, and user reads |
| `logs.*` | Filtered console forwarding |
| `eval` | Capped JavaScript execution |
| `damage` | Atomic damage with lethal recheck |
| `loot.*` | Constrained rescue queue reads and restores |
| `mirror.*` | Macro reads and gated restore application |

The Loot Watchdog requires Item Piles and a deployed Rescue Log journal UUID. Its source ships with `REPLACE_WITH_RESCUE_LOG_JOURNAL_ID` until deployment supplies the real ID.

## Relay

`relay/index.js` composes these policy components:

| Component | Responsibility |
|---|---|
| `ws-server.js` | Loopback WebSocket, hello validation, capabilities |
| `dispatcher.js` | Requests, responses, notifications, confirmations |
| `mcp-server.js` | Public MCP tools and gate orchestration |
| `prompt-queue.js` | Chat queue and 45-second listener lease |
| `world-settings.js` | Validated relay-owned posture cache |
| `chain.js` | One active Chain Mode grant |
| `mirror.js` | Scoped backup, rotation, and restore reads |
| `gate-queue.js` | One serialized lane for all writes |
| `eval-guard.js` | Read, mutation, delete, and journal classification |

The listener generates one `listenerId` and reuses it. A competing listener receives JSON-RPC `-33005`, the GM receives a toast, and the slot releases on terminate or 45 seconds of quiet.

## Safety model

### Local transport

Both servers hard-fail non-loopback bind configuration. The WebSocket server also rejects non-loopback peers.

### Relay-owned posture

The module is the settings surface. The relay is the authority. Assistant Mode forces multitasking and Chain Mode offers off. Co-GM forces both on. Custom accepts their individual values. Chain length is capped at 40.

### Serialized writes

Eval writes, damage, chain offers, mirror restores, and the constrained loot restore share one relay queue. Confirmations cannot interleave and concurrent workers cannot execute overlapping document writes through separate tools.

### Write gates

Reads execute immediately. Mutations require one approval. Deletes and lethal damage require two. Missing UI, denial, timeout, disconnect, chain escalation, or execution error fails closed.

`foundry_restore_loot` is the only ungated Foundry write. It can recreate only the recorded item, recorded shortfall quantity, and recorded recipient. Phantom records are never restorable.

### HP handling

`foundry_apply_damage` plans against live HP. Nonlethal outcomes use one confirmation and lethal outcomes use two. Commit rereads HP and uses `allowLethal` so a plan-to-commit race cannot apply a lethal outcome that received only single approval. Direct HP evals remain ordinary gated writes.

### Chain Mode

A grant covers only a declared count of single-auth gates, never deletes or lethal outcomes. The relay enforces the active ID, count, ten-minute TTL, and one-chain limit. Wrong IDs, missing IDs on a gated call, escalation, denial, refusal, error, expiry, or GM cancellation end the chain immediately.

### Macro Mirror

The configured root must already exist. The mirror resolves it before use, skips links, and verifies each destination remains inside that root. Backup rotation overwrites `<Name>.js.bkp` with the prior primary and never deletes a file. Restore is a gated write. Bulk restore uses one gated call per macro and may ride an eligible chain.

### Agentic multitasking

When enabled, a capable OpenAI client may delegate read and design work to background agents while the main listener keeps polling. All writes still use the serialized main lane. Background agents do not send chat replies. The box receives a status-line update instead.

If the connected OpenAI client cannot run background subagents, the same setting remains valid and the listener behaves synchronously.

## Protocol additions

The `hello` payload includes the world settings snapshot. Later changes use `settings.sync`. Relay notifications use the `aagm.*` namespace, including prompt, reply, status, confirmation, listener refusal, and chain progress messages.

`foundry_ping` returns Foundry liveness plus `mode` and the full relay-enforced `settings` snapshot.

## Compatibility notes

- Foundry 12, verified at 12.343
- Pathfinder 1e 11.11
- Node.js 22 or newer
- Plain JavaScript ES modules
- No bundler or build step

Live Foundry verification is still required for Dialog rendering, settings lock states, Item Piles hooks, and document creation APIs.
