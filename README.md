<p align="center"> <img width="420" alt="CodeMan" src="Docs/assets/CodeMan.png" /> </p>


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

---

<p align="center"> <img width="420" alt="PatchBoy" src="Docs/assets/PatchBoy.png" /> </p>

# Claude Item Forge (plug-in macro)

A paste-in world macro that turns the bridge into a magic-item factory. Describe an item to Claude in the chat box ("a +1 keen longsword", "boots that let the wearer walk on smoke") and Claude builds the complete item data for your game system, then invokes this macro through the gated eval. The finished item lands in a dedicated compendium, filed in the right folder, with the Approve/Deny card as the safety boundary. Good for conjuring a magic item in a pinch, mid-session, without leaving the table.

Source: [`plugins/ClaudeItemForge.js`](plugins/ClaudeItemForge.js)

### Install
1. In Foundry, create a new **Script** macro named exactly `Claude Item Forge`.
2. Paste the contents of `plugins/ClaudeItemForge.js` into it and save.
3. Click the macro once. The bare run creates the storage below, repairs it if folders went missing, and shows a routing diagnostic. Bare runs never write items.

### Storage it creates (automatically, on first run)
```
Claude Items  (world Item compendium)
├─ Claude Magic Weapons
│  ├─ Claude Magic Simple Weapons    <- weapon-simple
│  ├─ Claude Magic Martial Weapons   <- weapon-martial
│  ├─ Claude Magic Exotic Weapons    <- weapon-exotic
│  ├─ Claude Magic Firearms          <- weapon-firearm
│  └─ Claude Magic Ammo              <- ammo
├─ Claude Magic Armor                <- magic-armor
├─ Claude Wondrous Items             <- wondrous
└─ Claude Alchemy                    <- alchemy
```
The arrows are the `destination` keys Claude passes when forging.

### How Claude invokes it
One gated eval per item, with declared intent `"write"`:
```js
return await game.macros.getName("Claude Item Forge").execute({
  destination: "weapon-martial",
  itemData: { name: "...", type: "weapon", img: "icons/...", system: { ... } }
});
```
Returns `{ ok, uuid, name, folder, pack, warnings }` on success, `{ ok:false, error, ... }` on refusal.

### Guard rails
- **Duplicate refusal.** A same-name item in the pack refuses the forge unless `allowDuplicate: true` is passed, so a retried request can never double-create.
- **Portable images only.** `img` must start with `icons/` (Foundry's core icon library) or `systems/<your system id>/`, and descriptions may not embed `<img>` tags. Nothing in the pack can dangle on world-local uploads, so the compendium stays shareable.
- **Read-back verify.** The macro re-reads the created item from the pack before reporting success. Claude should still confirm with a separate read after the gate approves; a gated eval's own return value is never proof that a write landed.
- **One item per approval.** Forge items one gated eval at a time; long batch loops inside a single eval will hit the relay timeout.

Tested on Pathfinder 1e. The macro itself is system-agnostic: it validates against your world's own item types and leaves system-correct item data to Claude.

---

# Claude Foe Forge (plug-in macro)

The Item Forge's combat-ready sibling: a paste-in world macro that turns the bridge into a monster factory. Describe a foe to Claude in the chat box ("an orc werewolf that fights with a chain", "something slow and dreadful for a swamp") and Claude clones the nearest real creature from your bestiary compendiums - or designs one from parts when nothing matches - then files the finished actor through the gated eval, sheet and hostile-ready prototype token included. The Approve/Deny card stays the safety boundary.

Source: [`plugins/ClaudeFoeForge.js`](plugins/ClaudeFoeForge.js)

### Install
1. In Foundry, create a new **Script** macro named exactly `Claude Foe Forge`.
2. Paste the contents of `plugins/ClaudeFoeForge.js` into it and save.
3. Click the macro once. The bare run seeds the config journal below and shows a source/routing diagnostic. Bare runs never write actors.

### Config journal it creates (automatically, on first run)
A journal named **"Claude Foe Forge Config"** holds the destination and every compendium Claude may pull from (bestiaries, universal monster rules, monster abilities, templates, racial HD, feats, races). Edit it like any journal text page:
```
Destination:
Insert Destination Compendium here     <- replace with a compendium id, or
                                          "world.actors" for the Actors sidebar

User Extra Content:
system.content.stuff //Example Label   <- format guide (always ignored); add
                                          your own "pack.id //Label" lines under it
```
The shipped source list is Pathfinder 1e (`pf1-bestiary` + `pf-content`); swap the pack ids for your system's content and the macro follows the journal, not the code.

### How Claude invokes it
One gated eval per foe, with declared intent `"write"`:
```js
return await game.macros.getName("Claude Foe Forge").execute({
  actorData: { name: "...", type: "npc", img: "...", system: { ... },
               items: [ ... ], prototypeToken: { ... } }
});
```
Returns `{ ok, uuid, name, destination, folder, items, warnings }` on success, `{ ok:false, error, ... }` on refusal. `{ action: "config" }` returns the parsed source list, so Claude always knows what it may search.

### Guard rails
- **Duplicate refusal.** A same-name actor at the destination refuses the forge unless `allowDuplicate: true` is passed, so a retried request can never double-create.
- **Mandatory icon coverage.** A payload with a missing/default portrait or icon-less items is refused before anything is created - no art-less monsters to repair by hand (`allowIconless: true` is the deliberate override).
- **Hostile token defaults.** Disposition, name/bar visibility, and an HP bar are filled wherever the payload left gaps; anything Claude (or a bestiary clone) supplies wins.
- **Read-back verify.** The macro re-reads the created actor before reporting success. Claude should still confirm with a separate read after the gate approves; a gated eval's own return value is never proof that a write landed.
- **One foe per approval.** Forge foes one gated eval at a time; long batch loops inside a single eval will hit the relay timeout.

Tested on Pathfinder 1e (straight clones, template applications, and vague open-ended briefs). The macro itself is system-agnostic: it validates against your world's own actor types and follows whatever source list your config journal carries.

---

Want to build your own plug-in? Both Forges follow one contract - a world macro as the endpoint behind the gated eval. The bare essentials are in [`Docs/PLUGIN_API_ALPHA.md`](Docs/PLUGIN_API_ALPHA.md).

