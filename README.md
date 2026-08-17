# AAGM-O

**Automated Assistant Game Master - OpenAI**

AAGM-O puts Codex or ChatGPT behind your Foundry GM screen. Locally.

Two loopback ports. One GM tab. Zero OpenAI keys in Foundry.

The module connects a running Foundry world to an OpenAI client through a localhost-only Model Context Protocol relay. Model access, authentication, and tool selection stay inside Codex or the ChatGPT desktop app. AAGM-O is the OpenAI sibling of AAGM-C, not a plug-in for it.

Test target:

- Foundry VTT 12, build 343
- Pathfinder 1e 11.11
- Node.js 22 or newer

## How it works

Two pieces. That is it.

- **Foundry module:** Runs in one GM browser tab, connects to the relay over WebSocket, and executes a controlled handler set.
- **Relay:** Runs on the same computer, exposes Streamable HTTP MCP to the OpenAI client, routes JSON-RPC messages, and enforces safety gates.

The relay binds only to loopback addresses. No cloud service can reach it directly.

See [Architecture](Docs/ARCHITECTURE.md) for the full data flow and [Migration Inventory](Docs/MIGRATION.md) for the original-version reconstruction record.

## Safety boundaries

The safety boundary? The GM. Reads run immediately. Writes wait at the table.

- Every Foundry write requires GM approval, except the constrained loot restore primitive.
- Deletes and lethal damage require two approvals.
- A closed chat box automatically denies writes.
- Confirmation requests time out as denied.
- Direct HP evals are ordinary gated writes.
- `foundry_apply_damage` previews live HP and rechecks lethal authorization at commit.
- Protected database journals are blocked.
- Evaluated results are depth and size capped.
- The relay and WebSocket server refuse non-localhost binding.
- One listener owns the chat queue at a time.
- Chain Mode never covers deletes or lethal outcomes.
- Macro Mirror never deletes files or writes outside its configured root.

These controls are load-bearing. Bypass them and the bridge stops being the bridge.

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

Use the complete behavior prompt in [`relay/LISTENER_PROMPT.md`](relay/LISTENER_PROMPT.md). It requires one stable `listenerId`, reads the relay-enforced mode at startup, and defines Chain Mode, Macro Mirror, Loot Watchdog, and multitasking behavior.

The minimal polling core is:

```text
Generate one listenerId and reuse it on every foundry_get_prompts call. Poll
back-to-back, answer through foundry_send_reply, and stop on terminate or
-33005 listener-occupied.
```

The MCP call long-polls for about 25 seconds, so the client should not add sleeps between calls. Foundry shows **Ready to chat** while a listener is active.

Stop the listener with `/exit`, `/stop`, or `/quit` in the Foundry chat box. The local `relay/.loop-stop` file is the emergency stop.

## MCP tools

Read tools:

- `foundry_ping`
- `foundry_query_actor`
- `foundry_query_scene`
- `foundry_query_macro`
- `foundry_query_journal`
- `foundry_query_user`
- `foundry_tail_logs`

Controlled tools:

- `foundry_eval`
- `foundry_apply_damage`
- `foundry_chain_offer`
- `foundry_restore_loot`
- `foundry_mirror_restore`

Chat tools:

- `foundry_get_prompts`
- `foundry_send_reply`
- `foundry_set_status`

Rescue and mirror reads:

- `foundry_loot_pending`
- `foundry_mirror_backup`
- `foundry_mirror_backups`

## Repository layout

```text
module/                  Foundry VTT module
  scripts/bridge.js      Settings, module API, dispatch
  scripts/ws-client.js   WebSocket lifecycle
  scripts/chat-macro.js  GM chat and approval UI
  scripts/loot-macro.js  Manual Item Piles watchdog
  scripts/settings-*.js  World mode settings UI
  scripts/handlers/      Foundry command handlers
relay/                   Local Node.js relay
  index.js               Process bootstrap
  src/mcp-server.js      MCP tools and safety gates
  src/ws-server.js       Bridge authentication
  src/dispatcher.js      Request routing and confirms
  src/prompt-queue.js    Long-poll chat queue
  src/eval-guard.js      Eval classifier
  src/world-settings.js  Relay-enforced posture
  src/chain.js           Chain grant registry
  src/mirror.js          Scoped macro backup storage
  src/gate-queue.js      Serialized write lane
Docs/                    Architecture and migration records
```

## Testing

```powershell
cd relay
npm test
```

Foundry runtime acceptance still requires a Foundry VTT 12.343 world running Pathfinder 1e 11.11. Verify the settings form, listener refusal toast, Chain Mode card and cancellation, Item Piles hooks, macro restore, and damage confirmation tiers before packaging.

## License

MIT. See [LICENSE](LICENSE).

AAGM-O is not affiliated with or endorsed by OpenAI, Paizo Inc., Foundry Gaming LLC, or The Forge. Pathfinder, Foundry VTT, and other product names remain the property of their respective owners.
