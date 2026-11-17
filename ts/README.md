# Archer (TypeScript)

The TypeScript Archer: real Mermaid syntax, a local service for discussing diagrams with agents,
and the existing browser page. Contracts are listed in `docs/agents/frozen-boundaries.md`.

```
npm install            # from the repo root (npm workspaces)
npm --workspace ts test
npm --workspace ts run typecheck
npm --workspace ts run bundle      # ts/dist/: dependency-free ESM, runs with `node dist/archer.js`
npm --workspace ts run draw -- --model ../fixtures/flowchart/shapes.json --width 100
```

Commands (run from inside a project): `archer init` (creates `archer.toml`, the `.archer/` folder
and a pointer section in `AGENTS.md`), `archer list`, `archer validate <name>`, `archer compile
<name>`, `archer draw <name>`, and `archer draw --model <file.json>`. `serve`, `stop` and `mcp` manage the existing local service and MCP adapter.

Requires Node 22.18 or newer (Mermaid 12).

## Project summaries and task notes

The overview displays an optional top-level `archer.toml` description beneath the project name:

```toml
description = "A local workspace for architecture diagrams and interactive reviews."
```

Keep it to one short sentence (maximum 500 Unicode code points). Upgrade older Archer clients
before adding this setting. Without it, Archer uses the first paragraph of the project's root
`README.md`, which discovery admits by default (read-only) beside `.archer/`. A `README.md` inside
the Archer folder is an ordinary note, not the project description. To keep the root README out,
add `exclude = ["README.md"]` under `[discovery]`.

Keep short-lived task notes in the existing project's configured folder, for example
`.archer/notes/wayfinding/<topic>/`. Nested notes need no new project or registration. Git
worktrees currently have separate project identities; moving notes between them needs an explicit
migration plan. Detaching an unused attachment preserves its files and saved review context.
An empty or unavailable inventory does not authorize deleting a project.

The overview and sidebar collect inactive attachments in a collapsed group. New projects with
no admitted Markdown or Mermaid sources move there after ten minutes; adding content brings
them back. Previously populated projects and older attachments with unknown history do not
auto-hide. Discovery failures stay visible.

On a project page, **Archive project** hides it from ordinary browsing and **Keep project visible**
restores it. Manual archives persist across content changes; **Use automatic visibility** returns
to automatic behavior. These choices are shared service browsing preferences, stored privately
across restarts. Files, direct links and search remain available. Detachment stays an agent/CLI
management action and preserves source files.

## Discover and manage emphasis from MCP or CLI

`list_emphases` takes `{}` for this project or `{"viewId":"containers"}` for one view.
Structured content is `{schemaVersion:1,views:[{schemaVersion:1,viewId,emphases:[...]}]}`.
Each emphasis includes its exact top-level `id`, optional `title` and normalized groups.
Use that ID for replacement or clearing; titles and group IDs are different fields.
Discovery reads shared service state, so it works after changing MCP clients. It never starts
an absent service; without one, the registered views have empty lists. Once the service starts,
valid emphasis is restored from private account state by default.

The equivalent commands, run from the intended project directory, are:

```sh
archer emphasis list --json
archer emphasis list containers --json
archer emphasis set --file emphasis.json --json
archer emphasis clear containers inspector-demo --json
```

`list` always writes JSON; `--json` also selects structured results for mutations. The file
contains the complete `set_emphasis` object, including `viewId`, top-level `id`, and `groups`.
An invalid request exits nonzero and leaves existing emphasis unchanged. Set and clear follow
MCP's existing service-start behavior; listing does not start it. CLI and MCP reuse the same
production tool validation and service operations. Clearing a nonexistent ID remains an
idempotent no-op, so discover the exact ID first.

From a source checkout without an installed package, replace `archer` with
`node /absolute/path/to/ts/plugin/dist/archer.js` (the built plugin). Give it the same service
environment as the MCP adapter.

## CLI coverage and scoped access

All thirty current MCP tools are available through `archer call`, with shared schemas,
validation, results and business operations. Start with `archer tools --json`; request
`archer tools <operation> --json` for one complete schema. Then run:

```sh
archer call list_diagrams --json
archer call read_diagram --file arguments.json --json
printf '%s' '{"viewId":"containers"}' | archer call read_diagram --stdin --json
```

`--format text` selects shared readable templates; `--format json` or `--json` retains
complete structured data. Text mode omits exact Mermaid source from the model summary; use JSON
for source editing. MCP takes the same `outputFormat: "text" | "json"` field, with JSON retained
by default for compatibility. Explicit MCP text responses omit duplicated `structuredContent`.

Read surrounding Markdown with `archer call read_note --stdin --json` and
`{"notePath":"notes/topic.md"}`. This returns complete current UTF-8 source, its exact
`sourceRevision` and separate inventory coverage. It reads only the effective authoring folder,
does not start the service and refuses unsafe, oversized or unavailable sources. Broader browser
discovery roots do not widen it. Its whole-note revision cannot guard a diagram edit.
Explicit text mode includes the exact note source after its metadata and untrusted-data warning.
CLI text preserves exact source when piped; an interactive terminal labels its escaped display
as terminal-safe and directs readers to piped text or JSON for the exact source.

Successful compiled `write_diagram` results also return `modelRevision` for immediately guarded
presentation; continue using `sourceRevision` to guard edits. For comments, note and embedded-view
targets are distinct. Note-filtered `get_comments` adds bounded `relatedTargets` hints without
marking those diagram threads read; fetch the hinted target or omit the filter to read feedback.

Successful `--json` calls print the same structured payload as MCP. Domain failures print
`{code,message,details}` to stderr and exit 1; CLI usage/input failures exit 2. The named
emphasis commands remain available. Existing compile/draw commands are separate CLI
workflows, not additional MCP operations. Presentation/context and last-good models are shared
by the project's service, so fresh commands see the same state. Private account persistence
restores attachments, presentation, valid selection, emphasis and verified last-good source
snapshots across restart without modifying project files.

The standalone bundle includes `api.js` and a package export for composable use:

```js
import { openArcher } from './dist/api.js';
const archer = openArcher({ cwd: '/absolute/project/path' });
try { console.log((await archer.call('list_diagrams', {})).structured); }
finally { archer.close(); }
```

`openArcher` uses the same lazy startup policy as the CLI and accepts `service` options for an
explicit environment/state directory. `createApplication` accepts injected service dependencies
for embedding. Application modules do not import the MCP SDK. Close applications you create.
Environment operations are shared too: `start_service`, `stop_service`, `list_projects`,
`attach_project` and `detach_project` are exposed by MCP and `archer call`. Start/attach can
start a service; list/stop/detach never start an absent service. Attach/detach take `root`;
detach preserves files and is idempotent. Existing `serve`/`stop` now wrap the same core functions.
`stop_service` stops the selected service and all attached projects. Independent token scopes
remain future work.

Readable formatting uses a 10,000-value / 256-level bound and refuses unsupported/cyclic values
by name. If an operation has already completed and only its projection exceeds that bound,
its success receipt explains the limit and directs a fresh JSON read. It never reports the
mutation as failed or asks the caller to repeat it. Programmatic results retain the complete
structured payload; `renderOperation` and `ReadableOutputError` are exported from the API.

A project directory confines diagram/note paths, but a project URL is not an independent access
grant. The current single-user service uses one HTTP token across attached projects. Separate
`ARCHER_STATE_DIR` service identities provide operational separation today; separate OS accounts
and filesystem permissions provide local-user isolation. Per-directory browser/MCP access grants,
revocation and role capabilities require a future design and implementation.


## Recovery, Git accuracy, exports and embedded UI

`ARCHER_AUTO_START=false` disables implicit startup; explicit `archer serve` or `start_service`
still starts Archer. `ARCHER_RESTORE_STATE=false` skips startup recovery without deleting saved
state. `ARCHER_OPEN_BROWSER=auto|always|never` defaults to graphical-session detection: headless,
SSH and CI do not open a browser. Recovery never opens one. Binding defaults to localhost;
LAN binding remains an explicit override. These controls do not install an OS-login service.
`ARCHER_THUMBNAIL_FORMAT=svg|png` (default png) names the gallery thumbnail format pages ask for;
only that format is drawn. `ARCHER_HTTP2=1` serves HTTP/2 beside HTTP/1.1 on a TLS port (ignored for
plain HTTP).

`register_diagram.covers` declares supported repository-relative code patterns. Use
`list_stale_diagrams` to compare covered bytes in the current worktree against the last Git
commit that changed the diagram. `read_diagram_at_commit` retrieves actual historical registry
and source; `compare_diagrams` reports source and family-aware semantic differences. The page
provides explicit accuracy and revision comparison controls. No inferred filesystem coverage is added.

`export_diagram` produces self-contained SVG or PNG, in light/dark and underlying-diagram/current-
presentation modes, using the page's layout, primitives, bundled Fira Sans and bundled resvg WASM.
The page sends its actual active emphasis; headless omission selects the newest stored emphasis,
and `activeEmphasisId:null` dismisses it. Broken current source requires explicit `allowLastGood`;
results preserve model/source revisions and diagnostics. Export captures the full static drawing,
not viewport, hover, selection or animated packets.

```sh
archer tools export_diagram --json
archer call export_diagram --file arguments.json --output diagram.png --json
```

`--output` atomically writes actual image bytes and returns metadata without base64. Without it,
JSON carries complete base64 data. Discover each operation's schema rather than loading the entire
catalog. The [Archer skill CLI reference](plugin/skills/archer/references/cli.md) documents these flows.

MCP Apps-capable hosts can embed the same page through `ui://archer/diagram`; other hosts receive
the browser URL. Visual tools retain hidden complete UI payloads even with concise text output.
The production SDK and strict-CSP iframe are browser-tested; proprietary host sandbox/resizing
behavior still requires validation in that host. Browser accuracy/export controls currently use
the TS HTTP surface; embedded hosts use the shared MCP operations instead.
