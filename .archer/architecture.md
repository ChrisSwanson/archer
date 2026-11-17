---
author: agent
description: Archer's parts, where their code is, and the boundaries between them.
type: architecture
status: built
checked: 0.4.0 2026-10-22
refs: [ts/src/application/, ts/src/mcp/, ts/src/bin/, ts/src/service/, ts/src/mermaid/, ts/src/model/, ts/src/project/, ts/src/notes/, ts/src/comments/, ts/src/accuracy/, ts/src/docs/, ts/src/export/, ts/plugin/, ui/src/, shared/, ts/src/project/project.ts#writeConfined, ts/src/application/tools.ts#OPERATIONS, schema/diagram-envelope.schema.json]
---
# Architecture

**Archer is one Node bundle with several front doors.** An agent calls it through MCP or the CLI;
both run the same application layer, which reads and writes the Archer folder on disk. A
background service (one per service name; normally one per user) watches the folders it has
attached, compiles what changes and serves the browser page, where the person reads, selects and
comments.

- Context: [system context](diagrams/overview/system-context.mmd) (C4 context).
- Processes and stores: [containers](diagrams/overview/containers.mmd) (C4 container) and
  [runtime topology](diagrams/overview/runtime-topology.mmd).
- What it is for: [use cases](use-cases.md). What must never happen: [invariants](invariants.md).

## Code map

| Part | Code | Does |
|---|---|---|
| Operations | `ts/src/application/` | One registry (`ts/src/application/tools.ts#OPERATIONS`): schemas, validation, refusals, text or JSON results. MCP and `archer call` use it; `list`, `validate`, `serve` and other native commands call their modules directly |
| MCP server | `ts/src/mcp/` | `archer mcp` on stdio: tools, instructions, resources (`archer://docs/...`) |
| CLI | `ts/src/bin/` | `archer init`, `list`, `validate`, `call`, `docs`, `serve` and the rest |
| Service | `ts/src/service/` | Management socket, HTTP data plane and SSE, watchers, project state, presentation, emphasis, selection |
| Compiler | `ts/src/mermaid/`, `ts/src/model/` | Mermaid source to a normalized model; the wire contract is `schema/diagram-envelope.schema.json` |
| Project | `ts/src/project/` | `archer.toml`, the Archer folder, the inventory, confined writes |
| Notes | `ts/src/notes/`, `shared/` | Markdown notes, diagrams embedded in them, note emphasis; parsing both sides share |
| Comments | `ts/src/comments/` | Threads in `.comments.json` files beside what they are about |
| Accuracy | `ts/src/accuracy/` | Git staleness of covered diagrams, history, comparison |
| Doc pack | `ts/src/docs/` | `docs_index`: the router, routing, pack health |
| Export | `ts/src/export/` | SVG and PNG drawings |
| Page | `ui/src/` | React page, built into one HTML file the service serves |
| Plugin | `ts/plugin/` | The Claude Code plugin: skill, references, MCP entry |

## Boundaries

- **Authoring needs no service.** `write_diagram` writes the file; the service notices through its
  watcher. The service is needed for what is shared live: presentation, emphasis, selection,
  comments from the page, and the page itself.
- **Mermaid is the durable source.** The compiled model is derived; the page never changes the
  source when the person selects, and the model carries no coordinates.
- **Diagrams, notes and comments are written only inside the Archer folder**
  (`ts/src/project/project.ts#writeConfined`), where the account's write rules allow. Outside it
  Archer writes `archer.toml` (registration, init), the AGENTS.md section (init), its own state
  directory, and an export file the person names.
- **One service, many projects.** Each attached project keeps its own state; the page reaches a
  project by its slug and a browser link. A named service (`[service] name`) runs apart, with its
  own state and socket.

## Detail

Present and emphasis, writing a
diagram and comments are the
flows. Longer background, outside the pack: `notes/architecture/` (service and state, the contract
and ids, decisions) and `notes/start-here.md`.

## Unknowns

- Phone use: browser tests check layout and accessibility at phone sizes, but nobody has measured
  whether a person can work from a phone (the intent's open question 4).
