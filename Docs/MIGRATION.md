# Original AAGM to AAGM-O Migration Inventory

## Priority finding

The original AAGM did not call the Anthropic API.

There was no Anthropic SDK, API key, model identifier, request payload, response parser, token accounting, streaming client, or provider retry layer. The model connection already used Model Context Protocol through a local relay. That transport is provider-neutral.

AAGM-O therefore adapts the client-facing MCP workflow and original-provider naming. It does not add an OpenAI API dependency. Codex or the ChatGPT desktop app owns model authentication and inference.

## Reconstructed original architecture

The original repository contained:

1. A Foundry VTT module running in a GM browser tab.
2. A local Node.js relay with WebSocket and Streamable HTTP MCP servers.
3. A JSON-RPC dispatcher between MCP tools and Foundry handlers.
4. An eval classifier and human confirmation gate.
5. A nonlethal damage primitive with an absolute 1 HP floor.
6. An in-Foundry chat box backed by a long-poll prompt queue.
7. A set of optional world-macro plugins.
8. A macro editor that was unfinished.

The original design document also proposed a second autonomous capability channel, browser fallback, high-level token and world tools, and Foundry journal audit storage. Those features were not present in the shipped source. AAGM-O documents implemented code separately from design-stage proposals.

## Complete original-provider inventory

| Original location | Original-specific component | AAGM-O treatment |
|---|---|---|
| `README.md` | Product title, client names, setup commands, listener instructions, UI names, troubleshooting, plugin briefs, and browser fallback | Rewritten for AAGM-O, Codex, and ChatGPT desktop |
| `Docs/DESIGN.md` | Original client surfaces, channel names, architecture diagram, protocol names, fallback, and planned phases | Replaced by a current-state AAGM-O architecture document |
| `module/module.json` | Original provider named in the description | Rebranded and assigned the `aagm-o` package ID |
| `module/lang/en.json` | Original provider throughout notifications, chat labels, prompts, approvals, and dead-feature text | Replaced with the `AAGM_O` localization namespace |
| `module/scripts/bridge.js` | Original chat macro name, protocol namespace, notification routing, and dead-feature API | Renamed to AAGM-O protocols and reduced to the live chat surface |
| `module/scripts/chat-macro.js` | Original macro title, localization namespace, assistant role, style IDs, and log prefix | Renamed to AAGM-O and provider-neutral assistant roles |
| `module/scripts/ide-macro.js` | The original **Claude Macro Workshop**, a dead feature | Excluded completely |
| `relay/package.json` | Original client named in package description | Renamed to `aagm-o-relay` |
| `relay/src/dispatcher.js` | `claude.confirm` and `claude.confirm.result` | Renamed to `aagm.confirm` and `aagm.confirm.result` |
| `relay/src/prompt-queue.js` | `claude.prompt`, `claude.hello`, `claude.status`, and original polling comments | Renamed to the `aagm.*` namespace and client-neutral polling |
| `relay/src/mcp-server.js` | Original relay identity, client-specific tool descriptions, operator loop instructions, reply protocol, and dead-feature tools | Rewritten for AAGM-O and stripped of dead-feature tools |
| `.gitignore` | `CLAUDE.md` and `.claude/` local state exclusions | Replaced by `AGENTS.md` and `.codex/` exclusions |
| `plugins/` | Four optional original-version world-macro plugins | Excluded from AAGM-O |
| `Docs/PLUGIN_API_ALPHA.md` | Original plugin contract and client-facing usage brief | Excluded with the plugin system |
| `Docs/assets/PatchBoy.png` | Plugin-only documentation art | Excluded with the plugin system |

## Protocol migration

| Original notification | AAGM-O notification |
|---|---|
| `claude.prompt` | `aagm.prompt` |
| `claude.hello` | `aagm.status.request` |
| `claude.status` | `aagm.status` |
| `claude.reply` | `aagm.reply` |
| `claude.confirm` | `aagm.confirm` |
| `claude.confirm.result` | `aagm.confirm.result` |
| `claude.refactor.set` | Removed with the dead feature |

The public MCP tool prefix remains `foundry_`. It describes the controlled system, not a model provider.

## Client workflow migration

Original client registration:

```text
claude mcp add foundry-bridge --transport http http://127.0.0.1:7879/mcp
```

AAGM-O client registration:

```text
codex mcp add aagm-o --url http://127.0.0.1:7889/mcp
```

The original client used a product-specific recurring command to poll the Foundry queue. AAGM-O uses an active Codex or ChatGPT desktop turn instructed to call `foundry_get_prompts` back-to-back until `terminate` becomes true.

ChatGPT web cannot read local Codex MCP configuration. Supporting a hosted web client would require a remotely reachable, authenticated MCP service. That conflicts with AAGM-O's localhost trust boundary and is not part of this reconstruction.

## Provider-neutral components retained

- Model Context Protocol SDK
- Streamable HTTP transport
- WebSocket transport
- JSON-RPC request correlation
- Foundry handlers
- Eval result serializer
- Eval safety classifier
- Human approval gate
- Atomic nonlethal damage flow
- Prompt queue and long-polling
- Console log capture
- User-ID capability mapping
- Loopback binding checks

The `@modelcontextprotocol/sdk` package is an MCP dependency, not an Anthropic API client.

## Exclusions

The plugin directory, plugin API documentation, plugin-only artwork, and stale original module archive are not part of AAGM-O.

The original **Claude Macro Workshop** was a dead feature. Its module source, macro creation, localization, bridge API, `refactor.get` capability, MCP tools, and `claude.refactor.set` notification are excluded.

No replacement macro editor is planned in this build.

## Behavior carried forward

- One active GM bridge for each configured user ID
- Reconnection after relay restarts
- Query tools and log capture
- Read eval without approval
- Single approval for writes
- Double approval for deletes
- Automatic denial without an open chat box
- Protected journal refusal
- In-memory chat queue
- Chat and file stop signals

## Corrections made during reconstruction

- Module source version now comes from the manifest instead of a stale hard-coded value.
- Asynchronous WebSocket message-handler failures are now logged.
- The implemented `gm` capability set replaces phase-number terminology.
- Direct HP evals are gated writes instead of hard refusals.
- Atomic damage allows lethal outcomes after double confirmation.
- Current architecture is separated from unimplemented design proposals.
- Public configuration no longer contains a personal GM display name.
