# Archer debug kit: shared contract

Development-only instrumentation so people and agents can trace, measure and debug Archer.
Nothing here ships active in production. Three parts are built in parallel against this contract:
the **sandbox + harness** (`tools/devkit/`), **service telemetry** (`ts/`), and **browser telemetry +
page-load lab** (`ui/`, `tools/perf/`).

## Switches

- Service: `ARCHER_DEBUG=1` (exactly `1`) in the environment of the process that runs `archer serve`. Off by
  default. When off, every `/-/debug/*` route returns the service's ordinary bare 404, no
  Server-Timing or request-id headers are added, and no extra logging work is done.
- Profiling: `ARCHER_DEBUG_PROFILING=1` as well, or CPU profiles and heap snapshots stay refused
  (a heap snapshot holds every secret the process has; log redaction cannot help).
- Browser: a build-time constant `__ARCHER_DEBUG__` (Vite `define`). `true` for the Vite dev server
  and for builds made with `ARCHER_DEBUG_UI=1`; `false` for the production build, so the telemetry
  module is tree-shaken out. A test asserts the production page contains no `/-/debug/` string and
  no telemetry module code. `npm --workspace ui run build` fails while `ARCHER_DEBUG_UI=1` is set, and
  a debug build may not write `ui/dist` (debug pages: `build:debug` → `ui/dist/debug/`, or a sandbox);
  `ts/scripts/bundle.ts` refuses to package a page carrying telemetry or React's profiling renderer.

## Service routes (only with `ARCHER_DEBUG=1`)

All JSON, all under the service origin root (not a project prefix). A credential is a cookie or
`Authorization: Bearer <token>`. Access by route (a refusal is the bare 404, logged as
`svc.debug-refused` with its reason):

| Routes | Who |
|---|---|
| `GET health` | a loopback peer, or any valid grant |
| `POST events` | any valid grant (the page's own upload); with a cookie, the exact Origin and a JSON body, as for every cookie write here |
| `GET metrics`, `GET log`, `GET events`, `POST reset` | the **owner**: the service token only; a reader or authoring grant is refused (`not_owner`) |
| `POST profile/cpu`, `POST heap-snapshot` | the owner, from a loopback peer, with `ARCHER_DEBUG_PROFILING=1` (`profiling_off`, `not_loopback`) |

Every route is refused while the service's own authority is unknown. Bounded sizes everywhere. A
proxy in front of the service makes every client look like loopback: the UI dev server forwards only
`POST /-/debug/events` (with the browser's own cookie) and answers 404 to the rest.

| Route | Purpose |
|---|---|
| `GET /-/debug/health` | `{ok, version, uptimeMs, projects:[{slug, loaded, watcher, lastReloadMs}], streams, eventLoopLagMs, heapUsedMb, rssMb, warnings:<count last 5 min>}` |
| `GET /-/debug/metrics` | per-route request counts and latency (p50/p95/max), bytes; compile counts/durations by family; cache hit/miss (thumbnails, compile); event-loop delay histogram; heap/RSS series (last N samples); watcher events; SSE streams; authoring edits by op and outcome/refusal code |
| `GET /-/debug/log?since=<seq>&level=debug\|info\|warn\|error&limit=<n>&code=<prefix>` | structured log ring buffer (newest last), `{seq, at, level, code, msg, requestId?, route?, ms?, data?}` |
| `POST /-/debug/events` | browser telemetry batch `{session, page, build, events:[{at, type, code?, msg?, data?}]}` (≤ 64 KiB, ≤ 200 events); stored in the same log with `source:"client"`; from anyone but the owner, without free text (strings become their length; service-telemetry.md, Privacy) |
| `GET /-/debug/events?since=` | client events only |
| `POST /-/debug/profile/cpu?seconds=<1..60>` | returns a `.cpuprofile` (V8 CPU profile JSON; open in Chrome DevTools or speedscope) |
| `POST /-/debug/heap-snapshot` | a `.heapsnapshot`: written to a private temporary file (≤ 512 MiB, else 413 `heap_snapshot_too_large`), then delivered with backpressure; one profile or snapshot at a time (409 `profile_busy` until delivery ends); a client that leaves gets nothing |
| `POST /-/debug/reset` | clears metrics and the log (for a clean measurement window) |

Every response (debug on) carries `X-Archer-Request-Id` and `Server-Timing` with phases where known
(e.g. `auth;dur=…, compile;dur=…, fs;dur=…, render;dur=…, total;dur=…`), so HAR files and traces show
server-side time. A request may send `X-Archer-Client-Action: <name>` to tag its log lines.

## Warning codes ("this should not happen")

Logged at `warn` (or `error`) with a stable `code`, counted in metrics, visible in `/-/debug/log`.
Service side (`svc.*`):
- `svc.slow-request` (> 1000 ms), `svc.slow-compile` (> 500 ms), `svc.event-loop-lag` (> 100 ms)
- `svc.duplicate-request` (same client + page load + method + URL, and for writes the same body, ≥ 3 times within 2 s; a debug page names its page load in `x-archer-page-load`)
- `svc.request-burst` (one client > 60 requests within 5 s)
- `svc.edit-postcondition` (an editor refused with `edit_invalid_result` / `edit_source_mapping_ambiguous`: the
  editor's own invariant failed), `svc.edit-refused` (info, with the refusal code)
- `svc.unhandled` (uncaught exception / unhandled rejection), `svc.watch-storm` (> 50 file events / 1 s)
- `svc.memory-growth` (heap grew > 50% over 10 min without returning), `svc.stream-leak` (open SSE streams > 50)
- `svc.cache-miss-storm` (> 20 thumbnail/compile cache misses within 10 s)
Browser side (`ui.*`):
- `ui.page-error`, `ui.unhandled-rejection`, `ui.console-error`, `ui.react-error`
- `ui.csp-violation` (the Content Security Policy blocked a load or script), `ui.resize-observer-loop` (info: the browser's benign notice)
- `ui.fetch-failed`, `ui.fetch-slow` (> 1000 ms), `ui.fetch-duplicate` (same URL ≥ 3 times within 2 s),
  `ui.request-count` (a page view made > 40 API requests; committed edits, `POST …/api/authoring/edit`, are a person's changes and not counted)
- `ui.long-task` (> 200 ms), `ui.render-storm` (a component made > 30 commits of 1 ms or more within 1 s)
- `ui.web-vitals` (info: TTFB, FCP, LCP, CLS, INP per page view)
- Editing invariants: `ui.edit.pointer-hand` (an editable canvas is in hand mode), `ui.edit.stale-selection`
  (selected / editing id not present in the current layout), `ui.edit.chrome-overlap` (editor chrome
  elements — tools row, parts bar, editing cluster, message panel, canvas controls, structure panel —
  intersect), `ui.edit.edit-refused` (with the server's refusal code), `ui.edit.double-commit` (the same
  edit request issued twice within 300 ms)

## Browser telemetry surface (dev builds)

`window.__archerTelemetry` → `{events(): Event[], warnings(): Event[], requests(): RequestRecord[],
vitals(): Record<string, number>, clear(): void}` so a Playwright harness can read it directly without
the service. Events are also batched to `POST /-/debug/events` every 2 s and on `pagehide`.

## Sandbox (tools/devkit)

`node tools/devkit/sandbox.mjs up [--name <n>] [--corpus <dir>]` → prints one JSON line
`{name, url, link, stateDir, port, pid, projects:[…]}`; `down --name <n>` stops it and deletes its state.
`up --profiling` also sets `ARCHER_DEBUG_PROFILING=1` (otherwise never inherited).
`info --name <n>` prints the whole record, including `ownerToken` (the sandbox service's token, which
reads `/-/debug/log` and `events`); the registry file is mode 0600. Names match
`^[a-z0-9][a-z0-9-]{0,40}$`. `down` deletes only a record that names itself and carries its nonce and
a root carrying the matching marker, and signals only a PID whose start time and command line still
match the recorded service. Corpus copies exclude `.git` and refuse symlinks; git runs without
inherited `GIT_*` variables, and the new `.git` must resolve inside the sandbox.
Runs the worktree's service (`tsx ts/src/bin/archer.ts serve --foreground`) with `ARCHER_DEBUG=1`, a
fresh `ARCHER_STATE_DIR`, a free port, copies of the corpus projects (never the user's repos), and an
editing link for all of them. The user's running service is never touched.
