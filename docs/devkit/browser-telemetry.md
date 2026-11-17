# Browser telemetry and the page-load lab

Development-only instrumentation for the page (`ui/`), per the [debug-kit contract](CONTRACT.md).
The production page carries none of it.

## Switching it on

`__ARCHER_DEBUG__` is a Vite `define` (`ui/vite.config.ts`, `archerDebug()`):

| How the page is built | `__ARCHER_DEBUG__` |
|---|---|
| `npx vite` (dev server) | `true` |
| `npm --workspace ui run build:debug` (writes `ui/dist/debug/index.html`), or `ARCHER_DEBUG_UI=1 npx vite build --outDir <elsewhere>` | `true` |
| `npm run build` (production, `ui/dist/index.html`; fails while `ARCHER_DEBUG_UI=1` is set) | `false` |
| Vitest | `false` (a test sets `globalThis.__ARCHER_DEBUG__ = true` to exercise call sites) |

`ARCHER_DEBUG_UI=0` forces it off on the dev server. A debug build also swaps `react-dom/client` for
`react-dom/profiling`, so the render-storm `<Profiler>` reports outside the dev server too.
The devkit sandbox builds and serves a debug page with `--debug-ui`.

Events go to `POST /-/debug/events` on the page's origin root. The service accepts them only with
`ARCHER_DEBUG=1` ([service telemetry](service-telemetry.md)); on a service without it the first
batch gets a 404 and the page stops sending, keeping everything local. The dev server forwards only
`POST /-/debug/events` to `ARCHER_DEV_SERVER` (the browser's cookie as sent, the same Origin rewrite
as `api/`) and answers 404 to every other `/-/debug/` path: through a proxy every client would reach
the service from loopback. Read logs from the service itself, with its token.

### How the production page stays clean

- `main.tsx` loads `src/telemetry/runtime.ts` with `await import()` behind `__ARCHER_DEBUG__`; the
  production build drops the branch and never bundles the module.
- Product call sites (`useAuthoring.ts`, `AuthoringWorkspace.tsx`, `DiagramCanvas.tsx`,
  `SequenceCanvas.tsx`) are each behind `if (__ARCHER_DEBUG__)` / `__ARCHER_DEBUG__ ? … : …`, so the
  calls, their code strings and the `src/telemetry/dev*.ts` modules are removed too.
- `npm run build` starts with `scripts/check-prod-strip.mjs --refuse-debug-env` (fails while
  `ARCHER_DEBUG_UI=1` is set) and ends with `scripts/check-prod-strip.mjs dist/index.html`, which
  fails on any telemetry marker (`/-/debug/`, `__archerTelemetry`, the `ui.*` codes) or React's
  profiling renderer. A debug build refuses to write `ui/dist`; `ts/scripts/bundle.ts` runs the same
  marker check on the page it packages.
- `tests/telemetry-prod-strip.test.ts` builds both variants and asserts the production page has
  none of the markers and the debug page has all of them (so the check is not vacuous).

## What is captured

Installed before the first render, so it sees every request:

- **Errors**, recorded and passed on: `error`, `unhandledrejection`, `console.error` (wrapped; the
  original still prints), and React's root error callbacks (`onUncaughtError`, `onCaughtError`,
  `onRecoverableError`) instead of an added error boundary, so the tree behaves as in production.
  Each callback then does React's default: uncaught and recoverable errors go to `reportError` (a
  window `error` event, which Playwright sees as `pageerror`), caught ones to the console; the
  window event is not recorded a second time as `ui.page-error`.
- **Redaction before retention**: every event's `msg` and `data` pass the service's redaction rules
  (`src/telemetry/redact.ts`: credential names and parameters after URL decoding, 64-hex runs, file
  contents) before the page keeps or sends them; request records keep redacted URLs.
- **Requests**: `window.fetch` is wrapped. Each request is a `RequestRecord`
  `{at, page, method, url, pattern, status, ms, bytes, serverTiming?, requestId?, error?}`.
  `ms` is the time to response headers; `bytes` is Content-Length, else the resource-timing body
  size once known. `pattern` replaces id-like path segments with `:id` and drops query values.
  An aborted request is not a failure. `EventSource` streams are not fetches and are not recorded.
- **Web vitals** with `PerformanceObserver`, no library: TTFB, FCP, LCP (first page view only: a
  route change is not a navigation), CLS (largest session window) and INP (98th percentile of
  interaction latency; only the 10 longest interactions are held, exact below 500), per page view.
- **Long tasks** (`longtask` observer) and a **resource-timing summary** per page view.
- **Page views**: a page view is a `pushState` or `popstate` that changes the path or one of
  `tab`, `edit`, `view`, `note`, `folder`. `replaceState` (canonical addresses, filters, scroll)
  stays in the same view.
- **Editing invariants** (`ui.edit.*`) and **render storms**, below.

Events are batched every 2 s and on `pagehide` (`sendBeacon`, else a keepalive fetch), ≤ 200 events
and ≤ 64 KiB a batch, as `{session, page, build, events:[{at, type, code, msg, data}]}`; `data.page`
names each event's page view. `build` is `dev-server` or `debug-build`.

## `window.__archerTelemetry`

| Member | Returns |
|---|---|
| `events()` | every event kept (last 2000), oldest first: `{at, type, code, msg?, data?, page}`; `type` is `info`, `warn`, `error` or `pageview` |
| `warnings()` | the `warn` and `error` events |
| `requests()` | `RequestRecord[]` (last 2000) |
| `vitals()` | the current page view's `{TTFB?, FCP?, LCP?, CLS, INP?}` |
| `clear()` | forget events and requests (start a measurement window) |
| `flush()` | send what is queued now (extra to the contract) |

From Playwright: `await page.evaluate(() => window.__archerTelemetry.warnings())`.

## Codes

| Code | Level | When |
|---|---|---|
| `ui.page-error` | error | an uncaught error reached `window` |
| `ui.unhandled-rejection` | error | a promise rejection nobody handled |
| `ui.console-error` | error | anything called `console.error` |
| `ui.react-error` | error | React reported an error at the root (`data.kind`: uncaught, caught, recoverable) |
| `ui.fetch-failed` | error (5xx, network) / warn (4xx) | a request failed or returned ≥ 400 |
| `ui.fetch-slow` | warn | a response took > 1000 ms to its headers |
| `ui.fetch-duplicate` | warn | the same method + URL issued ≥ 3 times within 2 s (once per URL per 2 s) |
| `ui.request-count` | warn | a page view made > 40 requests (once per view); committed edits (`POST …/api/authoring/edit`) not counted |
| `ui.long-task` | warn | a main-thread task > 200 ms |
| `ui.render-storm` | warn | a profiled component (`editor`, `canvas`) made > 30 commits of 1 ms or more within 1 s (then quiet 5 s) |
| `ui.csp-violation` | warn | the browser's Content Security Policy blocked a load or script; data is `{directive, blocked, sourceFile?, line, column, disposition}`, with addresses cut to origin + path and redacted; once per directive + blocked address per load (64 at most). The harness's `csp-violations` invariant fails on it. |
| `ui.resize-observer-loop` | info | the browser's benign "ResizeObserver loop …" notice (not a `ui.page-error`) |
| `ui.web-vitals` | info | a page view ended: its vitals |
| `ui.page-view` | info | a page view ended: duration, request count, long tasks, resource summary, DOM size (extra to the contract) |
| `ui.page-view-start` | pageview | a page view began (extra to the contract) |
| `ui.edit.pointer-hand` | warn | an editable canvas sat in hand mode for 500 ms without the reader picking it (`DiagramCanvas`, `SequenceCanvas`) |
| `ui.edit.stale-selection` | warn | the selected, editing-node or editing-edge id is not in the settled editor layout (1 s after the last change; `AuthoringWorkspace`) |
| `ui.edit.chrome-overlap` | warn | two of: tools-row children, parts bar, edit cluster, message panel, `.react-flow__controls`, `.archer-canvas-controls`, structure panel (when shown) intersect; checked on layout changes and resizes, at most every 750 ms, once per pair until it clears |
| `ui.edit.edit-refused` | warn | the service refused a structured edit; `data.code` is its refusal code, with the edit's op, ids and sizes (`useAuthoring.edit`) |
| `ui.edit.double-commit` | warn | the same edit (`edit`) or the same write minus its operation id (`write`) was issued twice within 300 ms: the effect-ran-twice bug class. Compared by a hash held in the page (64 at most); `data` is only `{kind, op, ids, target kind/id, numbers, <field>Bytes, requestBytes, gapMs}`, never labels, notes or source |

The checks wait for the page to settle before reporting, so the frame between a state change and the
effect that follows it is not reported. Call them only behind `__ARCHER_DEBUG__`; the hooks live in
`ui/src/telemetry/dev-hooks.tsx` and the report function in `ui/src/telemetry/dev.ts`.

## Static checks

`ui/src/main.tsx` already renders inside `<StrictMode>`, so the dev server runs every effect twice on
mount; with telemetry on, a side effect that is not idempotent shows up as `ui.edit.double-commit` or
`ui.fetch-duplicate`.

There is no ESLint in the repository (`npm run lint` is `tsc --noEmit`). Recommended, as its own
change because it touches the lockfile: `eslint` + `eslint-plugin-react-hooks` with only
`react-hooks/rules-of-hooks` (error) and `react-hooks/exhaustive-deps` (warn at first: the code
deliberately omits dependencies in places, e.g. `useAuthoring`'s load effect), run as `npm run lint`.
The `if (__ARCHER_DEBUG__) useX()` calls are conditional hooks by syntax but constant per bundle;
they would need an `eslint-disable-next-line react-hooks/rules-of-hooks` each.

## Page-load lab (`tools/perf/`)

```sh
node tools/perf/page-load.mjs --base https://<host>:<port> --login 'https://<host>:<port>/projects/?token=…' \
  [--project <slug>] [--diagram <source path>] [--pages projects,project-diagrams] \
  [--profiles default,remote-link] [--runs 3] [--out <dir>] \
  [--budget tools/release-check/lab-budgets.json] [--write-budget <file>] [--lighthouse] [--allow-writes] [--initiators]
```

- Chromium from Playwright, driven over CDP. Pages: `projects`, `project-folders`,
  `project-diagrams`, `project-notes` (`?tab=`), `diagram` (the project's first `.mmd` view, or
  `--diagram`), `diagram-edit` (`?edit`), `new-diagram` (`-/edit/`).
- Each page and profile: a fresh browser context, logged in by the link, HTTP cache cleared, then
  a **cold** load and a **warm** reload in the same tab. A load ends when nothing new has been in
  flight for 1.5 s; event streams, `blob:` workers and repeats of a request already made in that
  load (polls) do not hold it open. Timeout `--timeout` (60 s).
- Profiles: `default` (no throttling) and `remote-link` (≈ 20 Mbps, 40 ms latency, CPU 4×).
- **Read-only by default**: every `/api/` request goes through CDP `Fetch`; GET/HEAD and the
  known read POSTs (compile, search, authoring open/preview/edit/snapshot, presentation `op:"read"`,
  operations `export_diagram`/`compare_diagrams`/`list_stale_diagrams`/`read_diagram_at_commit`)
  continue, anything else is refused and listed in `blockedWrites`. The interception adds about a
  millisecond to each API request. `--allow-writes` turns it off (sandboxes only).
- `--lighthouse` also runs `npx lighthouse@13.5.0 --preset=desktop` on each page (cold, with the
  session cookie, Playwright's Chromium); its score, FCP, LCP, TBT and byte weight land in
  `lighthouse`. Needs network access for `npx`.

- `--initiators` records, for every request, the JS call site that issued it (CDP `initiator` stack with
  async parents, `Runtime.setAsyncCallStackDepth`): up to six app frames `name file:line:col`, fetch wrappers
  skipped. `duplicates[].initiators` and `topPatterns[].initiators` then list the distinct call sites, so
  "`api/diagrams` ×2" reads as two components each fetching it. Names are readable only in an unminified page:

  ```sh
  (cd ui && ARCHER_DEBUG_UI=1 npx vite build --minify false --outDir "$TMPDIR/archer-unmin" --emptyOutDir)  # ~3 s
  node tools/devkit/sandbox.mjs up --name prof --page "$TMPDIR/archer-unmin/index.html"
  ```

  Line and column refer to the page document itself (the build is one inline file). Leave `--initiators`
  off for timing runs: async stack capture slows the page.

Output (`--out`, default `tools/perf/out/<time>/`, gitignored): `perf-report.json`, `perf-report.md`
and `summary.json` (`{ok, report, budget}`: the machine-readable budget block shared with the smoke
harness, described in [agent-harness.md](agent-harness.md#budget-results); its page rows are keyed
`<page>/<profile>/<cold|warm>` like `budgets.json` and take the worst run's duplicates). Per page ×
profile × cold/warm in `perf-report.json`:

| Field | Meaning |
|---|---|
| `wallMs` | navigation start to settled |
| `transferBytes` / `decodedBytes` | on the wire / after decompression, all requests |
| `documentDecodedBytes` | the page itself |
| `requests`, `cachedRequests`, `failedRequests` | counts (event streams excluded) |
| `duplicateRequests`, `duplicates` | requests beyond the first with the same method, URL and body |
| `polls` | the same request ≥ 5 times at a steady interval |
| `topPatterns`, `slowest` | where the requests go; the slowest with their server time |
| `ttfbMs`, `fcpMs`, `lcpMs`, `cls` | vitals measured in the page |
| `longTasks`, `longTaskMs` | main-thread tasks > 50 ms |
| `heapUsedMb`, `domNodes` | after the load |
| `firstLoad` | report only: bytes transferred for the document, scripts, workers, styles and fonts, from Resource Timing (a worker's script response never reaches the page's CDP session, so it is read there) |
| `dom` | report only: elements outside `<main>` (`shell`), `[role=row]` rows and elements per row (`perRow`, `maxPerRow`), header rows, the rest of `<main>` |
| `serverTimingMs` | sums of `Server-Timing` metrics (present with `ARCHER_DEBUG=1`) |
| `telemetryWarnings` | counts of `ui.*` warnings when the page is a debug build |

`--runs N` reports medians. `--write-budget <file>` seeds caps from the run with head-room;
`--budget <file>` exits 1 listing every value over its cap (`"<page>/<profile>/<cold|warm>"` →
`{transferBytes, decodedBytes, requests, duplicateRequests, lcpMs, wallMs, longTaskMs, domNodes}`).
`tools/release-check/lab-budgets.json` is seeded from a fresh sandbox of the release-check corpus; the
earlier seed of 2026-10-20, from a long-running service, is kept as history in `tools/perf/history/budgets-2026-10-20.json` (another
corpus and machine, 7 duplicates allowed: not a reference). Measurements from another machine or corpus need
their own seed. Tests: `node --test tools/perf/test/*.test.mjs`.

Known baseline before the lab: a 5 MB uncompressed page on every uncached load; ~150 comment
requests per project page; the Diagrams tab ~2.25 MB and 5–7 s over a remote link.
