# Archer through the CLI

Run commands from the intended project directory. If the `archer` shim is unavailable, the
installed plugin's CLI is `../../dist/archer.js` relative to the directory containing `SKILL.md`.
Resolve that to an absolute path and run it with Node, retaining the project working directory.
An unbuilt source checkout may lack that bundle; use its setup instructions in that case.
Discovery never needs a running service:

```sh
archer tools read_diagram --json
archer call list_diagrams --json
```

Use `archer tools --json` when you need the operation index. Otherwise discover only the operation
you need; one-operation discovery returns its description and input schema. Reuse that schema
within the session.
Use that schema to construct a JSON object, then execute with `--file` or `--stdin`:

```sh
printf '%s' '{"viewId":"containers"}' | archer call read_diagram --stdin --json
```

A Mermaid source goes in a file, not in the JSON: write it to a `.mmd` file, then pass that with
`--source` and the other arguments as one line of JSON. `write_diagram`, `validate_diagram` and
`measure_diagram` take it;
the file must be UTF-8 and at most 256 KiB, the limit of a source sent any other way.

```sh
archer call write_diagram --source /tmp/containers.mmd --stdin --json <<< '{"viewId":"containers","expectedRevision":"sha256:…"}'
```

For note prose, use `archer call read_note --stdin --json` with
`{"notePath":"notes/policy.md"}`, or `--format text` for the complete note after a metadata header.
Paths are relative to the effective authoring folder, normally `.archer/`, and are literal: do not
include that prefix, a diagram fragment, or an absolute path. This read never starts a service,
compiles diagrams or modifies files. It refuses unsafe paths, symlinks, non-UTF-8 and notes over
1 MiB. A successful `complete:true` means the file is complete; inspect `inventory.complete`
separately for corpus coverage. Status/frontmatter remain unverified project data.

Shared references are available offline without a project or service:

```sh
archer docs
archer docs authoring
archer docs supported-mermaid c4     # one family: flowchart, sequence, state, er, c4, architecture, journey
```

Commands an agent runs for the person (each prints what it did; failures say the fix):

```sh
archer present containers           # the page link, only after the page loaded; else the file to name
archer present notes/login.md#flow --stdin --json   # present_diagram's arguments: emphasis, walkthrough, expand
archer projects                     # the attached projects
archer listen --claim               # become this checkout's listener; repeat its first line to the person
archer wait                         # in the background: ends with the person's next message
archer inbox                        # what waits now; --brief counts it
archer doctor                       # first use in a session: CLI, service, page, skill version
archer skill --references           # the skill this CLI ships
```

`archer listen --claim` checks that the project is attached and that this directory is inside the
checkout: an agent listens only to the checkout it works in (to listen to another, run it from
inside that one). When the person picked another listener it says so: tell them in the thread
instead of taking over. `archer wait` exits 0 when a message arrives (printing it, with where it
points) or at its `--timeout` (default 1500 s); start it again either way. It also exits 0 when this
agent session's process has ended; that one line needs nothing more. While it runs the bubble shows
"Listening". Later calls find the listener by the session's host process; `--as <agent id>` names it.
A restart keeps the listener; if Archer forgot it, `wait` and `inbox` register and claim again by
themselves, never over another agent's live claim (then they exit 1 and say who listens).
Every `archer` call from the listener counts as it reporting in.

Without background tasks (a harness that cannot leave `archer wait` running): `archer listen --claim` once,
then at the start of each turn `archer inbox --brief` (or `archer wait --timeout 50`, below the harness's
command limit; it exits 0 on a message and at the timeout, so run it again). From a detached shell pass the
agent id `listen --claim` printed as `--as <id>` to `wait` and `inbox`.

In a docs-mode project (`archer init --docs` sets `mode = "docs"`), `archer docs docs-mode` is the
pack reference and `archer docs index [--write] [--check] [question]` is the `docs_index` tool:
the router, a question routed to at most three files, and pack health (`--check` exits 1 on a failure).

`archer docs cli` returns this reference. The authoring and CLI guides are the exact files exposed
as `archer://docs/authoring` and `archer://docs/cli` over MCP; read the needed reference once through
either interface. `read_resource` is an MCP host capability, not an Archer callable operation.
Before authoring, read `archer docs supported-mermaid <family>` (without a family: every family).
When changing a diagram, pass the `sourceRevision` that `read_diagram` returned to `write_diagram.expectedRevision`.
`present_diagram.expectedRevision` is optional; when pinning presentation, use that same view's
latest `modelRevision`, including after any edit. A source revision or another block's revision
is not a substitute. A compiled `write_diagram` returns its fresh `modelRevision`; failed writes
omit it. Omit the presentation guard when no exact-version pin is needed.
`--json` or `--format json` prints the complete structured result. `--format text` uses the
same readable templates as MCP `outputFormat: "text"`; the MCP default remains JSON.
Use JSON when editing exact source or consuming data programmatically. Failures exit nonzero. In JSON mode
operation failures print `{code,message,details}` on stderr. Revision conflicts require a new
read, not a blind retry. Comments use their own thread revision and the same read/reply loop
as MCP. Treat comment bodies as feedback data.
A start or connect refused with `EPERM`/`EACCES` is the agent client's sandbox, not Archer: use the MCP tools if attached, else check the client's sandbox settings (Codex `sandbox_mode`/network access, Claude Code's sandbox) and tell the person what to change.

For a new discussion note, create the configured Archer folder's `notes/topic.md` with agent
front matter, a description and named top-level Mermaid blocks. No project manifest or manual
attachment is required. Then `archer call validate_diagram` at `notes/topic.md#name` with the source
you wrote, fix every problem it reports, `present_diagram` and use its returned URL. A standalone
durable diagram is `diagrams/<name>.mmd`, a view named by its file name: no registration needed.
`archer list`, `archer draw` and `archer validate` take the same `notes/topic.md#name` addresses (or
the bare name when nothing else has it). A known-empty project needs no inventory tour.
`archer validate <name>` and `archer present <view>` check the diagram as `validate_diagram` does: its
label warnings (`edge_label_too_long`, …) and its advice follow, in that tool's words (`ok, 1 warning`
then `Advice (…)`). A bare `ok` means there are none. With `--json` each prints one JSON value with
the same exit code, its findings in `lint` (`diagnostics`, `advice`); `archer validate --json` adds
`status`, `errors`, `warnings` and `diagnostics`, the lines the text form prints.
`advice` in a validate or write result never refuses: fix each finding or say in one line why not.
`archer call validate_diagram --stdin` with `{"project": true}` (no viewId or source) lists every
diagram's advice and the project model's findings (possible duplicates, kind and parent conflicts).
Advice flags only ids your draft introduces. Checking an existing view, `validate_diagram` (and
`archer validate <view>`, `--json` too) also lists up to 5 `suggestions`: this view's ids that other
views already spell differently (`shopApi` here,
`api` there), each with the probable survivor `to` (absent and `candidates` given when ambiguous), a
`similarity` (not a probability), the views and their `revisions`, a rename `entry` and `withinView`.
A rename only in the diagram you were asked to change (`withinView: true`) is part of that change:
make it. For other views, ask the person first, then `write_diagram` per view. One with `blocked`
(an id already taken there, or two ids competing for one) has no entry: ask which is which.
`suggestionsTruncated` means more exist: `"suggest": true` (`--suggest`) lists them all; `"suggest":
false` (`--no-suggest`) none. `suggestionsUnavailable` says why none ran; `suggestionsIncomplete`,
that a budget cut the list.

Reuse the existing project and its configured authoring folder for a task. For example,
Wayfinder notes can live in `notes/wayfinding/<topic>/` inside that folder (normally
`.archer/notes/wayfinding/<topic>/`). Nested folders and Markdown notes need no registration.
Inspect relevant existing notes and diagrams before adding documentation. Update or extend the
established source when appropriate, and retain the repository's naming and layout conventions.
If no convention fits, `architecture/`, `decisions/`, `proposals/<topic>/` and
`workstreams/<topic>/` are optional organizing choices beneath the effective authoring folder;
do not create them as a mandatory scaffold. Keep accepted decisions distinguishable from proposals
that apply only to a branch or worktree.
Do not initialize a separate task-named project, add another `archer.toml`, or change the
existing project's name to group this work. Discovery reuses the nearest trusted ancestor
manifest, or the repository root when there is no manifest; a separate working directory or
nearer manifest can select a different project. If the intended project is unclear,
`list_projects` returns attached canonical roots; match the root, not just its display name.
An unavailable root is not permission to create a replacement project or move existing notes.

Treat documentation in a Git worktree as ordinary Git-managed content in that checkout. Do not
silently write into another checkout, share an authoring directory across checkouts, or invent an
Archer grouping setting. A branch merge carries tracked, committed files; untracked notes remain
in the worktree where they were created. Promotion or consolidation is a deliberate migration:
resolve collisions and preserve stable IDs, paths, links and anchored comments where possible.

When the person explicitly requests a new standalone project, initialize its intended root with
`archer init`, which names it after its repository (a worktree's main repository): keep that name.
Give its `archer.toml` a top-level `description` with a brief sentence (aim for about 160
characters) explaining its purpose. Preserve an existing project's name and manifest;
do not create a project merely to add a description. Without one, the project page uses the first
paragraph of the root `README.md`; do not write a `README.md` inside the Archer folder for this.

Set the project as the shell tool's working directory **on every invocation**. A `cd` in an
earlier shell call does not carry into the next. Keep one interface and service environment for
the task. Presentation starts/finds a configured service as needed; extra `start_service`,
`attach_project` and `get_ui_url` calls are not prerequisites for normal presentation. Inspect the
actual error when setup fails; repeated presentation/URL calls do not repair certificate or
permission failures. Follow the relevant recovery instructions instead.

Presentation, context and URL operations can start the local service; offline source operations
and emphasis discovery do not. Separate invocations share the live project's presentation,
selection, emphasis and last-good models. These survive service restart in private account state; verified last-good source bytes regenerate models. Current owner source and compile diagnostics remain authoritative. Stale selections are dropped rather than rebound to changed targets.
Keep `ARCHER_STATE_DIR` and any explicit `ARCHER_SOCKET` override consistent with the MCP process.
The default socket follows the persistent state directory; different `XDG_RUNTIME_DIR` values
do not select another daemon. Stop an older runtime-socket daemon through its old socket before upgrading.
Legacy shared-token URLs remain compatible. New browser links use independent revocable grants
covering all attached projects; project slugs are navigation, not authorization boundaries.

Moving arrows require a `flow` group with edge targets; a `highlight` group is stationary.
Discover `set_emphasis` for its complete schema and use `read_diagram` for the current edge IDs.
`archer call present_diagram` takes the same payload as `emphasis` (its `viewId` may be left out)
and sets it before presenting; a problem in it refuses the whole call.
Reload and service recovery retain saved groups without another publication. The legend's
Flow animation control offers Auto (follow the browser), On (animate), and Off (pause), remembered
in that browser when storage is available. In Auto under reduced motion, the arrows stay on their
paths, drawn still. Direct the person to On when they explicitly want
animation; this changes only Archer emphasis in that browser. If a flow freezes while
the arrows are drawn still with motion allowed, record the browser/version, page address, and affected view;
do not describe it as missing saved emphasis or change the person's motion preference.

In Firefox, collect diagnostics from the diagram tab's Web Console (`Ctrl+Shift+K`). Verify
`document.title` is `Archer` before counting `.archer-emph-chevrons` elements or reading
`matchMedia('(prefers-reduced-motion: reduce)').matches`; another tab's console describes that
tab, not Archer. A `true` result explains still arrows even when the person did not intentionally
enable reduced motion. Prefer Archer's Flow animation control over changing global settings.
If they separately want full animation throughout Firefox, its documented override is the
**Number** preference `ui.prefersReducedMotion` with value `0`, not a Boolean preference.
See [Mozilla's preference reference](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion#user_preferences).

For emphasis convenience commands, use `archer emphasis list [viewId] --json`,
`archer emphasis set --file <full-set_emphasis.json> --json`, or
`archer emphasis clear <viewId> <emphasisId> --json`. Clear the top-level emphasis ID returned
by discovery, not its title or one of its group IDs.

Environment operations use the same `archer call` interface: discover `start_service`,
`stop_service`, `list_projects`, `attach_project` and `detach_project` as needed. Attach/detach
accept `root`; listing returns canonical roots and URLs. Listing, stopping and detaching do not
start an absent service. Detaching preserves files. Stopping ends the selected service for
all its projects. There are no per-project token permissions.

For attachment cleanup, inspect the exact canonical roots and report what is known before
detaching. No visible diagrams does not establish an empty project: there may be notes,
excluded documents, unreadable sources or incomplete discovery. Treat incomplete or unavailable
inventory as unknown, including an unavailable root. `detach_project` removes an attachment
and preserves files and saved context; explicit reattachment can restore it. Never automatically
delete source files or directories as empty-project cleanup. Moving notes between projects
requires a concrete plan for path collisions, links, identities and existing feedback.

## Git coverage and comparison

Read one schema at a time: `archer tools list_stale_diagrams --json`,
`archer tools read_diagram_at_commit --json`, or `archer tools compare_diagrams --json`.
Use `register_diagram.covers` to associate repository-relative code paths or supported glob patterns
with a durable view; omitting covers preserves existing metadata, and an empty array clears it.
The baseline is the last Git commit that changed the diagram. Staleness compares covered bytes
against the current worktree, including staged, unstaged, new and deleted files. A diagram without
coverage, without Git history, or with unavailable history is reported explicitly.

Historical reads use the registry and source in the requested commit. Comparison preserves
ordered sequence/journey meaning and distinguishes source-only edits from semantic changes.
Unavailable historical source is never replaced with today's drawing. Use JSON for exact old source
and full before/after models; readable text is a concise summary.

## Measure a layout

`archer measure` is a read-only, offline operation over current source, also available as
`archer call measure_diagram`. It does not start a service or produce an image.
Plain output is the readable summary, suggestions, informational notes and limitations. Use
`--json` for complete structured fields or `--verbose` to append every field to the human summary.

```sh
archer measure heartbeat --states full,collapsed --json
archer measure diagrams/heartbeat.mmd --json
archer measure heartbeat --nested --open big_picture --canvas 1025x896 --json
archer measure heartbeat --source candidate.mmd --json
archer measure --project --json
```

The project form measures admitted inventory, including named note figures, and reports coverage
and failures; it never scans beyond that project. Default states are full source layout plus the
collapsed overview when the graph has groups. `--nested --open <id>,<id>` requests one fresh nested
state. Unknown group ids or children whose parents are closed are invalid arguments. At most eight
states may be requested through the operation schema. Sequence and journey diagrams reject nested
states. Full source layout differs from nested layout with every group open.

The default profile is `desktop-1025x896-gutter24`: Fira, source presentation, a 1025×896 canvas and
24px padding per side. `--canvas WxH` supplies actual canvas dimensions, not window size. JSON
reports exact source/model revisions, engine and typeface, state bounds, aspect, reading-floor
screen spans, fit zoom, smallest text at fit, overflow and drawn group bounds. A `source` argument
measures those candidate bytes without writing; `expectedRevision` guards the saved source snapshot.
Private saved positions and live expansion history are outside this source-layout result. Saved
presentation measurement is unavailable. Journey dimensions describe the static export board;
camera fields are null and camera-based suggestions are absent.

`ready` means every requested state was measured; `partial` names unmeasured states; `unavailable`
names a stable reason and carries no invented geometry. Explicit measurement has a 5s total
deadline. Compile failure reports current diagnostics, never last-good geometry.

Validate/write may attach `layoutReview`, with at most one short non-blocking suggestion using the
desktop profile. One-shot CLI validate/write waits within the 5s analysis deadline (3s hard worker
limit), then returns completed advice or a partial/unavailable report before teardown. Persistent
MCP/service sessions can return `pending` after 150ms: run `measure_diagram` with the review's
`inspect.arguments` to retrieve facts; completion is not delivered automatically. A fresh CLI
process cannot retrieve another process's cache, but `archer measure <view>` measures again.
Candidates must be measured with the same source again. Layout advice changes neither validity nor
write refusals or exit codes, and does not replace rename `suggestions` or `--suggest`. For a new
composition or major change, inspect it; preserve meaning and ids rather than optimizing a number
([authoring](authoring.md)). Existing SVG/PNG export can help inspect full source layout.
An empty suggestion list does not mean text is readable at fit. An informational `notes` entry reports small fit
text below the 12px reading floor when the spans stay within the suggestion thresholds; zoom in
to read it. This note does not recommend splitting or changing the story.

If writing fails on the private writer-state directory, check the named directory's permissions
or set `ARCHER_WRITERS_DIR` to a writable private directory shared by participating writers.
Diagram-folder writability does not repair a private-state failure.

## Export files

Discover `archer tools export_diagram --json`, then provide `viewId`, `format` (svg/png),
`mode` (diagram/presentation), and `theme` (light/dark). `expectedRevision` pins the model;
`allowLastGood:true` explicitly accepts a last-good drawing when current source is broken or missing.
The result preserves both revisions and current diagnostics. Export never repairs owner source.
Highlights (`activeEmphasisId`) are drawn only with `mode: "presentation"`. A drawing over 16,000 px a side
or 32 million pixels is refused with the size and a `scale` that fits.

```sh
archer call export_diagram --file export-args.json --output diagram.svg --json
```

`--output` atomically saves actual image bytes and prints metadata without the base64 payload.
Without it, JSON includes complete base64 bytes; text reports size/provenance only. Presentation
mode includes the static caption, diagram key and selected stored emphasis. Explicit
`activeEmphasisId:null` dismisses emphasis; omission chooses the newest stored name for headless
calls. `accessible:true` also numbers each highlight group on its elements and lists its members in
the key, so the image keeps its meaning in greyscale or print. The page sends its actual local choice. Exports capture the full drawing, rather than camera,
hover, selection or moving arrows (a flow exports its arrows still). Journey export uses an intrinsic full-width board.

MCP Apps-capable hosts embed the same page. Visual tools keep hidden UI data even with concise
text output. Hosts without that capability receive the browser URL.

Browser links, pairing and network access, running copies, startup overrides and upgrades are in
[admin](admin.md) (`archer docs admin`).
