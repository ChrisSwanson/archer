# Smoke-testing Archer with the devkit harness

For agents (and people) who drive Archer in a browser and need evidence for every failure. Binding
contract: [`CONTRACT.md`](CONTRACT.md). Code: `tools/devkit/`.

## Loop

```sh
node tools/devkit/sandbox.mjs up --name smoke --debug-ui   # prints one JSON line (url, link, projects…)
node tools/devkit/sandbox.mjs check --name smoke           # optional: every corpus diagram compiles
node tools/devkit/harness/smoke.mjs --sandbox smoke \
  --journey tools/devkit/journeys/flowchart-create.mjs \
  --journey tools/devkit/journeys/sequence-edit.mjs \
  --journey tools/devkit/journeys/source-panel.mjs \
  --journey tools/devkit/journeys/helpers-tour.mjs \
  --journey tools/devkit/journeys/editor-entry.mjs        # PASS/FAIL + summary.json path per journey
node tools/devkit/sandbox.mjs link --name smoke --reader   # optional: one more ordinary access link (no authoring roots; still edits)
node tools/devkit/sandbox.mjs down --name smoke            # stops the service, deletes its state + copies
```

1. Start a sandbox. `--debug-ui` builds the page with browser telemetry (`ARCHER_DEBUG_UI=1`) into
   the sandbox dir (about 5 s), so `ui.*` warnings are recorded. Without it the sandbox serves
   `ui/dist/index.html`; `pageWarning` in the JSON says when that build is older than `ui/src`.
2. Run journeys. Add `--json` for one JSON line per journey, `--headed --slow-mo 200` to watch,
   `--keep-going` to run the remaining steps after a failure, `--no-invariant <name>` to switch one off,
   `--max-minutes n` for a deadline (default: the journey's `meta.maxMs`, else 5 min or 3× its `timeoutMs`; a journey past it is aborted and fails), `--profile` for a CPU split per step (see "Measuring app time"),
   `--no-trace-snapshots` when measuring, `--no-entry-shots` to skip editor entry screenshots.
   Exit code: 0 pass, 1 a journey failed, 3 the run was aborted.
3. Read `summary.json` (see below). Open other artifacts only when it points at them.
4. Stop the sandbox. `down --all` stops every sandbox this checkout started.

`list` shows the running sandboxes; `info --name n` shows the full record, including `ownerToken`
(the sandbox service's own token: the harness reads `/-/debug/log` with it; a link grant no longer
may). Journeys that save call
`ui.resetProject(slug)` first, which restores the sandbox copy from its git snapshot, so runs repeat.

## What a sandbox is

- `archer serve --foreground` from this worktree (`tsx ts/src/bin/archer.ts`), `ARCHER_DEBUG=1`,
  bound to 127.0.0.1 on a free port (never one listed in `ARCHER_RESERVED_PORTS`, comma-separated:
  your own services' ports).
- **Plain HTTP (`--force-http`).** Over HTTP the service names its access cookie `archer-<port>`
  without `__Host-`/`Secure`, so following the link logs Chromium in on `http://127.0.0.1`. No
  certificates are needed and the user's TLS state is not touched.
- Everything lives under `$TMPDIR/archer-devkit-<name>-XXXXXX/`: `state/` (`ARCHER_STATE_DIR`,
  socket), `home/` (`HOME`, `XDG_*`), `archer.toml` (`ARCHER_CONFIG`, empty), `projects/` (copies of
  the corpus, each `git init` + one commit), `service.log`, and `ui-debug/` with `--debug-ui`.
- One editing link (`issue_access_link` with `authoringProjectRoots`) covers all projects (16 at most).
- `down` deletes only the root it created: under the OS temp dir, named for that sandbox, owned by
  you, and holding the `.archer-devkit-sandbox` marker whose nonce matches the registry
  (`tools/devkit/.sandboxes/<name>.json`). It never deletes by prefix.
- `--corpus <dir>` uses other projects (a dir of project dirs, or one project). `--page <file>`
  serves a specific page build.

## Corpus (`tools/devkit/corpus/`)

| Project | What it is for |
|---|---|
| `pageturner` | A separate copy of `ts/test/fixtures/pageturner` plus a flowchart: clean, typical diagrams of all seven families and notes. |
| `awkward` | Hard inputs: comments and `%%{init}%%` before headers, `classDef`/`class`/`style`/`linkStyle`, nested subgraphs, C4 enterprise/system/generic boundaries, nested state composites with choice/fork/join, ER keys and comments, sequence notes/activation/autonumber/nested loop-alt-opt-par, long labels, quotes, `&`, `#59;`, Unicode, CRLF files (flowchart, sequence, state, a note), a 150-node/~200-edge flowchart (`flow-large`), saved positions (`flow-positioned`, seeded from `.devkit/positions.json`), notes with embedded diagrams of every editable family, `fixtures/notes/auth.md` (includes one deliberately broken block, `#broken`), plus architecture and journey (read-only). |
| `journeys` | Small, stable `flow`, `seq` and a note with one embedded diagram. The four example journeys (`tools/devkit/journeys/`) edit these. |

`check` result at the time of writing: 37 of 38 diagrams compile. The one that does not is
`awkward/notes/auth.md#broken`, which is meant to fail.

## Driver robustness

- **Signals and orphans.** SIGINT/SIGTERM/SIGHUP, a closed stdout, or the driver shell dying (the run is
  re-parented; checked every 2 s, `--no-orphan-check` for deliberately detached runs) abort the run: the browser
  closes at once, later steps are recorded as skipped, `summary.json` is written with `aborted`, and the remaining
  journeys are not started. A second signal exits immediately. Measured: SIGTERM to written summary in about
  100 ms; an orphaned run stops within 2 s.
- **Stop a run by its pid.** `progress.json` in the run dir is rewritten after every step: `{pid, steps, last, at}`
  (and `done`, `ok`, `aborted` at the end). `kill <pid>` from it. Never `pkill -f <pattern>`: the pattern is also in
  the command line of the shell running pkill, which kills that shell (the monkey batch's "exit 144").
- **Dialogs.** A modal dialog blocks every `page.evaluate`, so the harness never leaves one open: a
  `beforeunload` prompt (leaving a dirty editor by `page.goto`/`reload`) is accepted, as a person choosing
  Leave; `alert`/`confirm`/`prompt` are dismissed. Each is in `step.dialogs` and `console.jsonl`. Before this, a
  `page.goto` away from a dirty editor waited out its whole timeout (8 s here, the default 10 s in a journey) and
  returned on the editor: the monkey's slow "reopen" steps.
- **A closed browser** (crash, OOM) aborts the run instead of failing every later step on its timeout.

## Measuring app time (Playwright's own cost)

Every Playwright locator call and the trace recorder run JavaScript in the page's main thread. With `--profile`
each step gets `step.cpu = {appMs, harnessMs, browserMs, busyMs, idleMs, topApp, topHarness}` from a V8 CPU
profile (`tools/devkit/harness/cpu.mjs`): samples whose innermost frame is the page's own script are `app`;
frames without a URL (Playwright's injected script and snapshotter, the harness's `page.evaluate` probes) are
`harness`; `(program)`/GC are `browser` (layout and paint outside JS; layout forced inside a query counts for
whoever forced it). Compare `appMs` across runs, not `TaskDuration`.

Measured on `awkward/flow-large` (150 nodes), harness ms per step, trace DOM snapshots on → off
(`--no-trace-snapshots`):

| Step | app | harness, snapshots on | harness, off |
|---|---|---|---|
| open `?edit` | 784–1218 | 735 | 220 |
| rename a node | 666–794 | 980 | 158 |
| move a node | 128–137 | 671 | 42 |
| select (with reveal) | 1634–1979 | 3220 | 454 |
| 30 `boundingBox()` locator calls, no action | 0 | 2792 | 149 |
| one invariant probe | 0 | 82 | 4 |

The trace's DOM snapshotter (`visitNode`) is most of it: it walks the whole DOM after every action. Locator
queries cost 1–5 ms each on this diagram. So: measure with `--profile --no-trace-snapshots` and read
`step.cpu.appMs`; for timing without any harness, use the page-load lab (one navigation, no locators) or a raw CDP
trace filtered to the page's script URL. `ui.reveal` on flow-large took 34 s for five far nodes (pan, zoom,
re-check loops): pan to a target once with `panTo` instead of revealing many.

## summary.json

Path: `tools/devkit/runs/<timestamp>-<journey>/summary.json`. Read it top-down:

- `ok`, `counts`, `failures[]`: the failures, each with `step`, `kind` (`action` | `invariant` | `journey` |
  `aborted`) and `error` or `details`. A failed action has a `screenshot`. `aborted` (`{reason, at, afterSteps}`)
  when the run was cut short.
- `budget`: the machine-readable request/warning budget (below). A release check reads this.
- `entryShots[]`: one screenshot per editor family × viewport × theme the run entered, with `{family, width,
  theme, sourceOpen, canvasHeight, sourceHeight, path}` (`shots/entry/<family>-<width>-<theme>.png`).
- `warningCodes`: each distinct `ui.*`/`svc.*` code once, with its count, steps and an example message.
- `warnings[]`: invariant results at warn severity, including issues a journey has downgraded on purpose.
- `steps[]`: `title`, `ok`, `durationMs`, `url`, `requests`, `perf` (CDP deltas: `JSHeapUsedSize`,
  `Nodes`, `LayoutCount`, `RecalcStyleCount`, `TaskDuration` in seconds…), `invariants[]`, `warnings[]`,
  `dialogs[]` (when one appeared) and `cpu` (with `--profile`).
  `clientAction` is the `X-Archer-Client-Action` tag sent with that step's requests; service log
  lines carry it as `data.action`.
- `surfaces`: whether the service `/-/debug/*` routes and `window.__archerTelemetry` were present.
  The harness works without them; it simply records less.
- `perf.delta`, `vitals`, and `service.health`.
- `artifacts` / `howTo`:
  - `trace.zip`: open with `npx playwright show-trace <path>`. It has a per-action timeline with
    screenshots, DOM snapshots you can inspect selectors in, the console, the network and the source.
  - `requests.jsonl`: one line per request, with `t`, `method`, `url`, `status`, `ms`,
    `serverTiming`, `requestId` and `step`. Start here for network questions.
  - `network.har.zip`: `har.har` plus the response bodies, each stored once by hash. Extract it with
    `python3 -m zipfile -e network.har.zip har/`, then import `har/har.har` into DevTools or jq it.
  - `console.jsonl`: console messages, page errors, failed requests and HTTP ≥ 400, in order.
  - `service-log.jsonl`: the service's `/-/debug/log` for this run, including echoed client events.
    `service-metrics.json` holds `/-/debug/metrics` before and after, plus health.
  - `browser-telemetry.json`: the final `window.__archerTelemetry` dump.
  - `shots/`: a screenshot of each failed step, plus `final.png`.

## Budget results

`summary.budget` (harness) and the page-load lab's `<out>/summary.json` → `budget` share one shape, schema
`archer-budget/1` (`tools/perf/lib/budget.mjs`), so a pre-release check can gate on either:

| Field | Meaning |
|---|---|
| `schema`, `source` (`harness` \| `page-load`), `name`, `generatedAt` | identity |
| `totals.pages` | page views: documents the first tab loaded (harness), or page/profile/load rows (lab) |
| `totals.requests`, `totals.apiRequests` | all requests (event streams and `/-/debug/` uploads left out), and those under `/api/` |
| `totals.duplicateRequests` | repeats of the same method + URL (+ body) in one page view, **poll ticks excluded**: a repeat the debug build tagged `x-archer-poll: <name>` (`ui/src/app/polls.ts` `schedulePoll`) for a poll in `SCHEDULED_POLLS` that reads that URL. A repeat whose ETag changed, or one after a person's input or an event-stream message (harness and lab `invalidations`), is not one either; a later harness step alone is no excuse. One classifier for all of it: `tools/perf/lib/requests.mjs` |
| `totals.duplicateWrites` | harness only: steps where `duplicate-writes` failed |
| `totals.transferBytes` | bytes on the wire (headers + encoded body); `null` when unknown |
| `totals.failedRequests` | network failures and HTTP ≥ 400 |
| `totals.maxApiRequestsPerPage`, `totals.maxDuplicateRequestsPerPage` | the worst page view |
| `warnings.total`, `warnings.byCode` | `ui.*`/`svc.*` warning counts by code (harness: every step's warnings; lab: the debug page's `telemetryWarnings`) |
| `failures` | harness only: `{total, byInvariant: {name: n}, actions}` |
| `overBudget` | lab only: values over `--budget` caps |
| `errors` | lab only: rows that did not complete |
| `pages[]` | per page view: `key` (`doc<N>` or `<page>/<profile>/<load>`), `url` (login token cut), `requests`, `apiRequests` (thumbnail images and committed edits left out), `thumbnailRequests` (`api/thumbnails/` images), `editRequests` (`POST …/api/authoring/edit`), `pollTicks`, `duplicateRequests`, `duplicates[{request, count}]` (top 10), `transferBytes`, `decodedBytes`, `failedRequests`; lab rows add `wallMs`, `lcpMs`, `longTaskMs`, `warnings` |

`npm run release-check` is that gate (next section).

## Release check

```sh
npm run release-check:quick     # before handing back any ui/src or service change
npm run release-check           # before a PR: + smoke-a/b/c journeys, seeded monkeys, lab on the remote-link profile too
node tools/release-check/release-check.mjs [--quick] [--out <dir>] [--skip <step>…] [--keep-sandbox] [--serial]
```

Code: `tools/release-check/` (`release-check.mjs` runs the steps, `lib/gate.mjs` judges them; tests:
`node --test tools/release-check/test/*.test.mjs`). Steps, each timed with a PASS/WARN/FAIL/SKIP line and its
evidence paths:

| Step | What | Fails when |
|---|---|---|
| `typecheck` | `tsc --noEmit` in ui and ts, in parallel | any type error |
| `unit` | vitest in ui, then ts (`STRESS*` removed, so the fuzz suite stays out; `--parallel-unit` runs both at once) | any failed test or suite. All failures `spawnSync rg ENOENT` with no `rg` on PATH: **WARN**, an environment gap, named as such |
| `page-build` | validator check, the production web page and the MCP App file (`vite build --mode mcp`) into temp dirs, `check-prod-strip.mjs` on the web page, every asset it names and the MCP file, size caps. Reports (never gates) `index.html` alone, every emitted file and their total (raw/gzip/br), and with `--buckets <ref>` (default `main` in a full run; `none` turns it off; about 20 s) gzip per source bucket (npm package, or first folder under `ui/src`) against the merge base, through sourcemap builds | stale validator, debug markers, raw/gzip/brotli over `config.json` `pageSize` of the web distribution (`index.html` + every asset it names, each compressed on its own and summed) or of the MCP file |
| `sandbox` | builds the debug page (`ARCHER_DEBUG_UI=1`) into a temp dir and starts `sandbox.mjs up --page <it>` as `rc-<hex>`, torn down in `finally` and on SIGINT/SIGTERM/SIGHUP; `service.log` is copied to the output first | the page does not build, or the service does not start |
| `lab` | `page-load.mjs --allow-writes` on `pageturner`, every page, cold + warm (`default`; full also `remote-link`), against `tools/release-check/lab-budgets.json` | counts, bytes or DOM over a cap, a row that did not complete. Each cold row also prints a `report` line: first-load bytes by kind and the DOM as shell + rows × elements per row + headers + the rest of `<main>` (the scale step prints the same DOM line per page); neither gates yet. Timings over their cap are WARN; `budgets.timingFailFactor` (null here: this host is shared, timings ran 2–4× the seed) makes them fail above that factor × the cap. Re-seed with `page-load.mjs --runs 3 --write-budget` on a fresh sandbox, then check that no row seeded a broken page (the first seed had both editors at 9 DOM nodes) |
| `journeys` | the harness: quick = the five stock journeys; full = + `smoke-a/b/c` (minus `lib.mjs`, probes, `-dbg`) + one 45 s monkey per family with fixed seeds | any journey fails (an app bug fails the gate) |
| `scale` | `tools/perf/scale-gates.mjs`: the S (today's corpus; quick runs only this) and M (250 views, 1k notes, 200 threads; full runs add it) corpora from `tools/devkit/corpus/scale.mjs`, each in a sandbox of its own, over the debug page. Per size: the first-request compression probe (the first page GET after start must carry `content-encoding`), then cold loads of the tree, notes and a diagram: API requests, comment fetches, catalog bytes, DOM nodes, React commits; S→M growth ratios. `ARCHER_SCALE_L=1` adds L (1,000 views, a 257-view project with 2k threads, a 200-node dense diagram; slow, no caps). Event Timing for a node click and an arrow key and the `archer:interactive` mark are timings: they warn | a count over `tools/perf/scale-budgets.json` (M's caps are today's values; its `tighten` map names the slice that should lower each), the probe came back uncompressed |
| `budgets` | every `archer-budget/1` block (journeys and lab) plus the runs' `requests.jsonl` and warnings | see below |

Both pages are built from the committed `ui/index.html`: lines the working tree added (the Impeccable live tag, with its token) are removed from the build, and an external `<script src="http…">` that HEAD does not have fails the step. The CSP violation that tag causes is never allow-listed.

Budget checks (caps in `tools/release-check/config.json`, `budgets`):

- `duplicate-requests`: no page view repeats a request (poll ticks excluded) unless `allowedDuplicates` explains it
  (`{match, maxCopies?, reason}`, a regex on `METHOD /path`).
- `api-requests-per-page` (≤ 40, poll ticks excluded), `transfer-bytes-per-page` (≤ 4.5 MB; a lab warm reload
  ≤ 1 MB, so lost caching headers fail), `duplicate-writes` (none).
- `failed-requests`: HTTP ≥ 400 or a network error in any journey; aborted requests (navigation) are not failures;
  `allowedFailedRequests` as above.
- `warnings`: every `ui.*`/`svc.*` code fails unless `tools/release-check/allowed-warnings.json` covers it
  (`{code, reason, kind, match?, run?, max?}`; `match` is a regex on the message, `run` on the journey name or
  `lab`). Lab warnings carry no message, so a `match` entry cannot cover them. Service warnings logged during the
  lab are read from `/-/debug/log`. `debt` entries are printed on every run. `harness.*` codes are listed, not gated.

Output (`--out`, default `tools/release-check/out/<time>-<mode>/`, gitignored): `release-check.md` (steps,
failing checks, journey table), `release-check.json` (schema `archer-release-check/1`: `verdict`, `exitCode`,
`steps[]` with `details`, `evidence` and the budget `checks`), `budgets.json`, `lab/`, `unit-*.json`, `logs/`,
`service.log`. Exit codes: 0 every step passed (WARN allowed), 1 a step or check failed, 2 usage or
configuration error (or the gate crashed), 3 interrupted (the sandbox is still torn down; a second signal exits at
once and prints the `down` command).

## Invariants (after every step; `tools/devkit/harness/invariants.mjs`)

| Name | Fails when |
|---|---|
| `page-errors` | an uncaught exception or unhandled rejection reaches the page |
| `console-errors` | `console.error`. Ignored: favicon noise, React DevTools noise, and Chromium's own "Failed to load resource" lines, which `http-errors` already judges. |
| `failed-requests` | a network failure (an aborted request is counted, not failed) |
| `http-errors` | status ≥ 500 fails; 4xx is a warning |
| `duplicate-requests` | the same GET/HEAD URL ≥ 3 times within 2 s in one document (writes: see `duplicate-writes`). A scheduled poll's tick (tagged `x-archer-poll` by the debug build; `tools/perf/lib/requests.mjs` `isPollTick`) is skipped. |
| `requests-per-view` | > 40 API requests in one page load, reported once per view. Telemetry uploads, the event stream, tagged poll ticks (`isPollTick`) and committed edits (`isCommittedEdit`: one per change a person made; `duplicate-writes` gates them) are not counted. |
| `duplicate-writes` | the same write (method + URL + whole body, so operation id, base revision and payload) twice within 2 s in one step and one document (a reload re-sends its preview). Distinct edits never match. |
| `chrome-overlap` | the editing cluster, parts bar, message panel, canvas controls, open structure panel or top toolbar intersect (> 1 px) |
| `pointer-mode` | an editing canvas is in hand mode (`.archer-pan-hand`, or Select mode not pressed). Switch it off in journeys that pan on purpose. |
| `label-focus` | after a label edit, focus is still in the inline editor or on a detached node; focus on `<body>` is a warning |
| `editor-alert` | warning only: an editor alert is on screen, or the service refused an edit (`svc.edit-refused`, also in `step.refusals`). Journeys that expect a refusal assert it themselves. |
| `alert-visible` | an alert/refusal (`.authoring-error`, `[role=alert]`) has its centre outside the viewport, or `elementFromPoint` at its centre returns something that is neither the alert nor inside it (covered by the source pane, a panel…) |
| `csp-violations` | a `securitypolicyviolation` event in any document (a blocked `<img>`, script or style), a console line saying so, or the page's own `ui.csp-violation` telemetry. Reported through an init script, so it survives navigations. |
| `shortcut-focus` | while editing, Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y (always), Delete/Backspace or Alt+arrows (with a selection) pressed outside a text field and no handler took it (`defaultPrevented` false): the dead-shortcut bug when focus falls to `<body>` or sits in the app's header/rail. Or a plain key typed into a text field that a shortcut swallowed (prevented, or focus pulled out, and the value unchanged). Ignored while the editor is busy (warning) or in a dialog/menu. Keys are recorded by an init script, so every press counts, the journey's own `page.keyboard` too. |
| `chrome-clipped` | editor chrome (cluster, parts bar, panels, the editor pane, and every button in the toolbar/parts bar/cluster) is cut off by an `overflow` ancestor that cannot scroll, or lies outside the viewport while the document does not scroll. Fail. |
| `chrome-scrolls` | warning: the same items are cut off but reachable by scrolling their container (parts bar items hidden at ≤ 1024 px; a structure panel taller than the window). Reachable is not discoverable: check for a cue. |
| `selection-identity` | what was selected before a step keeps its id but now shows a different label (a sequence message renumbered under the selection). Compares by id AND text, not id alone. Exempt: steps with `labelEdit` or `selectionMayChange` (rename, undo/redo, source edits, navigation). |
| `dirty-navigation` | the editor had unsaved changes (Save enabled) and after the step the page is no longer editing the same diagram, though the step was not Save/Cancel(discard)/an explicit navigation (`leavesEditor`). Silent loss of work. |
| `warnings` | `ui.page-error`, `ui.unhandled-rejection`, `ui.react-error`, `ui.edit.*`, `svc.unhandled` or `svc.edit-postcondition` appeared. Any other `ui.*`/`svc.*` warning is a warning. (The ResizeObserver notice is info `ui.resize-observer-loop` now, so it never reaches this check.) |

Warning collection is by monotonic id: each telemetry warning gets a harness id (`hid`) the first time a poll
sees it and a step consumes ids above the last one seen, so the page's 2000-event ring wrapping cannot hide a
new warning. If the ring wrapped between two polls the step gets a `harness.telemetry-gap` warning: split such
a step. A step's own `meta` (third argument of `step`) feeds the exemptions above: `{ labelEdit, selectionMayChange, leavesEditor }`;
the `ui.*` helpers that navigate or leave the editor already set them, and a helper called inside your own
`step` passes its exemptions up to that step. Put your own `page.goto` away from a
dirty editor in `step(title, fn, { leavesEditor: true })` or the invariant will (rightly) fire.

Configure per journey: `export const meta = { invariants: { "<name>": false } }` turns a check off.
`{ "<name>": { severity: "warn", reason: "…" } }` downgrades a known, reported issue.

## Writing a journey

```js
// tools/devkit/journeys/my-check.mjs
export const meta = { name: "my-check" };
export default async ({ ui, step, expect, page }) => {
  await ui.resetProject("journeys");
  await ui.openDiagram("journeys", "diagrams/flow.mmd");   // path inside the Archer folder; "notes/x.md#name" for embedded
  await ui.enterEdit();                                     // the reading page's Edit button (?edit)
  const id = await ui.addPart("Process", { name: "Cache" }); // returns the new node id
  await ui.connect("b", id);
  await ui.save();
  await step("file has the cache", async () =>
    expect(await ui.readProjectFile("journeys", ".archer/diagrams/flow.mmd")).toContain("Cache"));
};
```

Every `ui.*` helper is one step. Wrap your own assertions or raw Playwright calls in
`step(title, fn)` so they get invariants and evidence. `expect` is `@playwright/test`'s.

Helpers (`tools/devkit/harness/actions.mjs`):

- **Navigation:** `openProject`, `openDiagram(slug, path, {edit, source})`, `newDiagram(slug, {type, saveAs})`.
  Types are `Flowchart`, `Sequence`, `C4 container`, `State` and `Entity relationship`.
- **Settling:** every helper ends with `settle()`: the preview is not busy, nothing says "Checking preview…", and,
  when the Mermaid source pane is open, it shows exactly the source the service returned for the last accepted
  edit (`POST …/api/authoring/edit`, CR/LF normalised). A pane that lags or ignores an edit fails the step with a
  diff (`settle(timeout, {source: false})` skips that part).
- **Edit session:** `enterEdit`, `cancel({discard})`, `save()` (in-place editing exits after Save),
  `undo`, `redo` (the buttons), `undoKey()`, `redoKey()` (Ctrl+Z / Ctrl+Shift+Z at document level, as a user
  types them; the buttons hide shortcut bugs), `deleteSelected`, `toggleStructure`, `status()`, `alerts()`.
- **Parts and labels:** `addPart(label, {name})`, `typeLabel`, `rename(id, text)` (double-click),
  `renameEdge(id, text)`, `select(id, {shift})`.
- **Graphs:** `connect(from, to, {slow})` (handle drag; returns the edge id), `reattachEdge(edgeId, 'source'|'target', nodeId, where, {slow})`
  with `where` = `"handle"` (default) | `"body"` | `{x, y}`, `moveNode`, `selectEdge(id)` (clicks along the path until it
  is selected), `pickEdge(id, f)` (one click at fraction f; returns whether it selected), `pan(dx, dy)`, `panTo(...ids)`,
  `slowDrag(from, to, steps)` (human speed, dwell at both ends: thin handles need it). Ids: a bare id also finds a subgraph
  frame, whose DOM id is `group:<id>`; groups are pressed at their corner because their children cover the middle.
  **Off-screen targets:** `select`, `rename`, `connect`, `reattachEdge`, `moveNode` first bring their targets into the
  canvas (`ui.reveal(...locators)`: Hand-mode pan, then Zoom out a notch at a time, never a drag on a node), so a
  node pushed off by the layout is reachable. A background drag in select mode draws a selection box and the wheel is
  unreliable; that is why panning uses Hand mode and restores Select.
- **Sequence:** `seq.drawMessage(from, to, {label, atY})` (`atY`: `"end"` default, `"start"` above the first
  message, or a page y; returns the new message's id found by comparing from/to/label before and after, never the
  open editor's `msg-N`, and throws naming the message whose label changed if the text landed elsewhere),
  `seq.state()` (the diagram as drawn: `participants[{id, label, x, selected}]`, `messages[{id, number, from, to,
  label, kind, y, selected}]` with ends read from the arrow geometry, `notes[{id, text, over}]`,
  `fragments[{id, kind, label, sections, messages}]`, `selection`, `panel` (the open message/note/block panel:
  `{kind, from, to, type, position, text, heading}`), `labelEditor`), `seq.dragMessageEnd(msg, end, participant)`,
  `seq.moveMessage(msg, aboveMsgId|dy)`, `seq.reorderParticipant(id, beforeId|dx)`,
  `seq.wrap([msgs], 'Loop'|'Alt'|'Opt'|'Par')`, `seq.addNote([ids])`,
  `seq.panel.set(msg, {from, to, type, position})`, `seq.participants()`, `seq.messages()`.
- **Source:** `openSourcePanel()` (returns the text), `copySource()` (returns the clipboard),
  `editSourceFromPanel`, `toggleEditorSource()` (returns `{forced, pressed}`; a family whose pane is forced open has a
  disabled toggle, reported at once instead of waiting out a 10 s click), `editorSource()` (works open, forced or closed;
  a closed pane is opened and closed again), `setEditorSource(text)`.
- **Banners, drafts, recovery:** `editorState()` (no wait: `{editing, status, draftId, checkpoint, restored,
  resumable, storageFailed, busy, save: {enabled, blockedReason}, conflict: {kind: "blocked" | "changed-outside",
  text, actions}, feedback: {text, role, error}, recovery: {actions}, diagnostics}`), `waitForConflict()`,
  `resumeDraft()` / `startFresh()` (the "unsaved changes from an earlier edit" offer), `discardRestored()`,
  `reload()` (the editor must come back with the work: dirty-navigation judges it).
- **Viewport and theme:** `setViewport(width, height)`, `setTheme("light" | "dark")` (OS preference emulated,
  stored choice cleared). The first time an editor family opens per viewport and theme, the harness keeps an
  entry screenshot (`entryShots`); `editor-entry.mjs` opens all five families at 1440 and 1024 in both themes.
- **Files:** `readProjectFile(slug, rel)`; `resetProject(slug)` (git checkout + clean, the service's saved layouts emptied and
  re-seeded from `.devkit/positions.json`, this browser's editor drafts `archer.authoring.v1:*` and the source-pane
  preference cleared; drafts held by the service itself are not touched); `agentWrite(slug, rel, text)` /
  `agentRemove(slug, rel)` (change a file in the sandbox copy as an agent would; `rel` is relative to the project root, e.g.
  `.archer/diagrams/flow.mmd`; the path may not leave the project); `diffFile(slug, rel, before)` (unified diff + CRLF/mixed
  endings; `udiff`/`hasCrlf` are exported too).
- **Other people and tabs:** `ui.newTab()` (same cookies), `ui.readerContext()` (a new browser context logged in with an
  ordinary access link, which may still edit: `readerLink()` issues it, or `node tools/devkit/sandbox.mjs link --name <n> --reader`), `ui.openContext({fresh, reader, link})`.
  Each returns `{page, ui, context}`; their requests, console and CSP reports feed the same evidence (tagged `tab`), but the per-step
  invariants probe the first page only.
- **Locators** (`ui.locators`): `node`, `edge`, `participant`, `lifelineHit`, `message`, `openLabelInput`.

When the UI changes, fix the selector in `actions.mjs` once, not in each journey. Sequence message ids
are `msg-N` in source order. Flowchart edges are `eN`; C4, ER and state edges are `src--dst`.

## Known-risky areas to probe

Each maps to a contract warning code.

- **Overlapping editor chrome** (`ui.edit.chrome-overlap`): narrow viewports (`meta.viewport`), the
  message panel together with the open structure panel, long diagram titles.
- **Hand mode while editing** (`ui.edit.pointer-hand`): after entering edit from a reading page that
  was panned, and after Undo.
- **Stale selection** (`ui.edit.stale-selection`): delete or undo while something is selected; rename
  a sequence participant that a message is selected on; Cancel with a selection.
- **Double commits and refusals** (`ui.edit.double-commit`, `ui.edit.edit-refused`,
  `svc.edit-postcondition`): Enter followed by a blur on label inputs, quickly repeated drags, and
  edits on `awkward` files (CRLF, comments, styling lines, nested composites, fragments).
- **Request storms** (`ui.fetch-duplicate`, `ui.request-count`, `svc.duplicate-request`,
  `svc.request-burst`): opening any page in a project with many views.
- **Render and long tasks** (`ui.render-storm`, `ui.long-task`, `svc.slow-compile`): `flow-large`,
  dragging in it, and sequence edits.
- **Embedded diagrams** (`notes/embedded-families.md#…`): editing and saving one must not disturb the
  rest of the note; also try the CRLF note.
- **Saved positions** (`flow-positioned`): positions survive opening the editor, Save, Undo and Cancel.
- **Source round-trip**: what the Source panel copies must equal what Save writes.
