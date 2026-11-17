# Service telemetry (development only)

Implements the service half of [CONTRACT.md](CONTRACT.md). Code: `ts/src/telemetry/` (core),
`ts/src/service/debug-http.ts` (headers and routes). Tests: `ts/test/telemetry/`,
`ts/test/service/debug-http.test.ts`.

## Turn it on

```sh
ARCHER_DEBUG=1 archer serve --foreground        # or: tsx ts/src/bin/archer.ts serve --foreground
```

`ARCHER_DEBUG=1` (exactly `1`) must be set in the environment of the process that runs the service.
CPU profiles and heap snapshots also need `ARCHER_DEBUG_PROFILING=1`.
The devkit sandbox (`tools/devkit/sandbox.mjs up`) sets it. With it off, nothing is built:
`/-/debug/*` gets the ordinary bare 404, no headers are added, and each domain hook is a single
null check.

## Headers (every response, debug on)

- `X-Archer-Request-Id: <6 hex>-<base36 counter>`. Log lines for the request carry it as `requestId`.
- `Server-Timing: auth;dur=0.3, fs;dur=0.2, compile;dur=12.4, render;dur=40.1, total;dur=55.0`. Only
  phases that ran are listed. `total` is measured when the headers are written. Phases:
  - `auth`: the browser credential check (`browserAccess`)
  - `compile`: every Mermaid compile run for this request (authoring preview and edit, reloads triggered by the request)
  - `fs`: thumbnail cache read
  - `render`: thumbnail paint
- A request can send `X-Archer-Client-Action: <name>` (`[A-Za-z0-9._:-]{1,64}`). Its `svc.request`
  line and any warnings it causes then carry `action`.

## Routes (debug on)

Access requires a `Host` the service serves (this blocks DNS rebinding) and a known authority, then
by route (`debugAccess` in `debug-http.ts`; a credential is a cookie or `Authorization: Bearer`):
`health` from a loopback peer or with any valid grant; `POST events` with any valid grant;
`metrics`, `log`, `GET events` and `reset` with the **service token** only (a reader's or author's grant
is refused: `not_owner`); profiles and snapshots with the service token from loopback, and only with
`ARCHER_DEBUG_PROFILING=1` (`profiling_off`, `not_loopback`). A write with a cookie also needs the
exact `Origin` and `Content-Type: application/json` (`cookie_write_origin`), and any write with
`Sec-Fetch-Site` other than `same-origin` or `none` is refused (`cross_site`); a Bearer caller needs
no Origin, but a foreign one is refused (`cross_origin`). A refused request gets the plane's bare 404, and the reason is logged as
`svc.debug-refused`. A sandbox's service token is its record's `ownerToken`
(`node tools/devkit/sandbox.mjs info --name <n>`); otherwise it is `token` in `<state dir>/service.json`.

| Route | Answer |
|---|---|
| `GET /-/debug/health` | `{ok, version, uptimeMs, projects:[{slug, loaded, watcher, lastReloadMs}], streams, eventLoopLagMs, heapUsedMb, rssMb, warnings}`. `watcher` = directories watched, `warnings` = warn/error entries in the last 5 min |
| `GET /-/debug/metrics` | see [Metrics](#metrics) |
| `GET /-/debug/log?since=&level=&limit=&code=` | `{seq, entries}`. With `since`: up to `limit` entries after it, oldest first, so poll with `since=<last seq>`. Without it: the newest `limit`. `level` is a minimum (default `debug`). `limit` 1–1000, default 200. `code` is a prefix (`svc.`, `ui.edit.`) |
| `GET /-/debug/events?since=&level=&limit=&code=` | the same, client entries only |
| `POST /-/debug/events` | browser batch `{session, page, build, events:[{at, type, code?, msg?, data?, level?}]}`. Limits: 64 KiB (413 above), 200 events, short strings (422 when malformed). JSON or `text/plain` (sendBeacon). Answer `{accepted, seq}`. The owner's events keep their text (redacted); anyone else's keep no free text (see Privacy) |
| `POST /-/debug/profile/cpu?seconds=1..60` | a `.cpuprofile` (default 5 s; 422 outside 1–60; 409 while another profile or snapshot runs) |
| `POST /-/debug/heap-snapshot` | a `.heapsnapshot` (tens of MB; blocks the loop for about a second). Spooled to a private temporary file (removed afterwards), refused above 512 MiB (413 `heap_snapshot_too_large`), then sent with backpressure; the lock (409) holds until delivery ends; a client that disconnects gets nothing |
| `POST /-/debug/reset` | clears metrics, both logs and detector windows. `seq` keeps counting |

Log entry: `{seq, at, level, code, msg, source?:"client", requestId?, route?, ms?, action?, data?}`.
Service and client entries are kept in separate rings (4000 and 2000 entries) that share one `seq`.
A flood of browser events therefore cannot push service warnings out. Warn and error lines are
also copied to the service's stderr log as `[archer] debug: <level> <code> <msg>`, so they survive a crash.

Client levels: an explicit `level` wins. Otherwise type `error` maps to error, `warn`/`warning` to
warn, and `info`, `pageview` and `ui.web-vitals` to info. Any other `ui.*` code is a warning.

## Warning codes

| Code | Level | Fires when | Notes |
|---|---|---|---|
| `svc.slow-request` | warn | a non-streaming request takes > 1000 ms | `data.phases` shows where the time went |
| `svc.slow-compile` | warn | one compile > 500 ms | `data.cold: true` marks the process's first compile of that family, which includes parser load and JIT. Expect one at startup |
| `svc.event-loop-lag` | warn | max event-loop delay in a 5 s sample > 100 ms | at most once per sample |
| `svc.duplicate-request` | warn | same client + page load (`x-archer-page-load`, sent by a debug page) + method + URL (+ body digest for writes) ≥ 3 times within 2 s | once per window per key |
| `svc.request-burst` | warn | one client makes > 60 requests within 5 s | client is `grant:<id>`, else `addr:<peer>` |
| `svc.edit-postcondition` | warn | an editor refused with `edit_invalid_result` / `edit_source_mapping_ambiguous` | logged by the dispatcher `editDiagram`, with family and op |
| `svc.edit-refused` | info | any other edit refusal | `data.code` is the refusal code |
| `svc.unhandled` | error | uncaught exception (observed, not handled) or unhandled rejection | the rejection is rethrown when telemetry is the only listener, so Node's crash-on-rejection default holds |
| `svc.watch-storm` | warn | > 50 raw file events for one project within 1 s | |
| `svc.memory-growth` | warn | the heap's low point over the last 5 min is > 1.5× its low point at the start of a 10 min window | needs about 9 min of samples; at most once per 10 min |
| `svc.stream-leak` | warn | > 50 SSE streams open, **or** a stream refused at the cap | the service caps streams at 32 (`MAX_EVENT_STREAMS`), so in practice this fires on the refusal |
| `svc.cache-miss-storm` | warn | > 20 thumbnail + compile cache misses within 10 s | a compile "miss" is a view recompiled on reload; a first compile and background (pre-)drawing are not misses |

Decision-point lines (info unless stated):

- `svc.request` (debug): every non-debug request, with route pattern, status, bytes, client and phases. Its message names the route (`GET /p/:project/api/diagrams 200`), never the path or query, which hold what the caller sent (a mistyped token, a code); so does `svc.duplicate-request`'s
- `svc.access-refused`: why a request got the bare 404. Reasons: `host_not_allowed`, `token_query_invalid`, `token_unknown`, `token_not_page`, `bearer_malformed`, `bearer_unknown`, `path_token_invalid`, `cookie_too_large`, `cookie_missing` (debug), `cookie_ambiguous`, `cookie_unknown`, `cookie_write_origin`
- `svc.authoring-forbidden`: authoring entitlement refused. `data.reason` is `no_entitlement`, `credential_bearer` / `credential_legacy`, `service_token_cookie`, `no_browser_authority`, or an access reason above
- `svc.authoring-refused` / `svc.presentation-refused`: an authoring or layout-save request ended non-200 (warn when 5xx), with `code` and `status`
- `svc.thumbnail-refused`, `svc.reload` (debug) / `svc.reload-failed` (warn), `svc.management` (debug; warn on `internal`), `svc.debug-refused`, `svc.debug-route` (error), `svc.profile`, `svc.heap-snapshot`

## Metrics

`GET /-/debug/metrics` returns:

- `routes["<METHOD> <pattern>"]`: `{count, statuses, errors (5xx), bytes, streams, latency}`. Patterns replace tokens, project names and ids (`/:token/p/:project/api/thumbnails/:id`); an API or debug name the service does not serve is `:other`, so a key never spells what a caller typed. Capped at 128 keys, then `other`. SSE responses count as `streams` and are kept out of `latency`.
- `compile.byFamily[family]` `{latency, outcomes:{compiled, failed}}`; `compile.cache {hit, miss}`
- `thumbnails {cache:{hit, miss}, render, refused}`
- `eventLoop {delayMs:{mean,p50,p90,p99,max} since reset, series:[{at,maxMs,p99Ms}]}`
- `memory {now, series:[{at,heapUsedMb,rssMb}]}`: one sample per 5 s, last 10 min
- `watcher {events:{<root>:n}, reloads:{<root>:{latency,outcomes}}}`; `streams {opened, closed, refused}`; `streamsOpen`
- `authoring.edits["<family> <op>"]`, `authoring.requests[action]`, `management[method]`: `{latency, outcomes:{ok | <code>: n}}`
- `warnings {code: n}`, `client {code: n}`

`latency` is `{count, mean, p50, p95, max}`. `count`, `mean` and `max` cover everything since the
last reset; `p50` and `p95` cover the most recent 512 values.

## Profiles

Start the service with `ARCHER_DEBUG=1 ARCHER_DEBUG_PROFILING=1` (a sandbox: `up --profiling`), then from the same machine:

```sh
B=http://127.0.0.1:<port> T=<service token>   # a sandbox's ownerToken
curl -s -X POST -H "authorization: Bearer $T" "$B/-/debug/profile/cpu?seconds=10" -o archer.cpuprofile   # reproduce the slow thing meanwhile
curl -s -X POST -H "authorization: Bearer $T" "$B/-/debug/heap-snapshot" -o archer.heapsnapshot
```

- CPU: open in Chrome DevTools (Performance → Load profile) or drag onto <https://www.speedscope.app> (Left Heavy view shows the hot paths).
- Heap: DevTools → Memory → Load. To find a leak, take two snapshots a few minutes apart around the suspect action and use the Comparison view.
- Profiles and snapshots are refused from any other machine. Logs from one: `-H "authorization: Bearer $T"`.

## Debugging with it (agents)

1. Start a sandbox (`node tools/devkit/sandbox.mjs up`), or any service with `ARCHER_DEBUG=1`. Then `POST /-/debug/reset` (with the service token) so the window is clean.
2. Note `seq` from `GET /-/debug/log?limit=1`, reproduce the problem, then read `GET /-/debug/log?since=<seq>&level=info`.
3. Start from warnings (`level=warn`). Each one names the code path and carries `requestId`/`route`. Use `requestId` to pull every line that request logged. Match `ui.*` client entries to service lines by time and URL.
4. For slowness, read the request's `Server-Timing` (in a HAR, or `curl -D -`), or `routes` in `/-/debug/metrics`. When the time is not in a named phase, take a CPU profile while reproducing.
5. For refusals: a bare 404 has an `svc.access-refused` reason; an authoring refusal has `svc.authoring-*` / `svc.edit-*` with the exact code.
6. Tag scripted requests with `X-Archer-Client-Action` so their lines are easy to find.

## Privacy and bounds

- Never logged: service token, grant secrets, cookie or authorization values, file contents. Fields
  named like `token`, `secret`, `cookie`, `authorization`, `password`, `credential`, `source`,
  `text`, `content`, `body`, `bytes`, `grant` or `apiKey` are replaced with `[redacted]`. So is any
  run of 16 or more hex digits in any string, plain or percent-encoded, and the value of any credential-named
  parameter (`token`, `grant`, `secret`, `key`, `cookie`, `authorization`, `password`, …) in any
  string. Parameter names and values are URL-decoded first (`%74oken=`, `+`, up to three layers),
  as authentication decodes them. Grant **ids** (not secrets) appear as client keys.
- Page events from anyone but the owner (a grant, a paired device) keep no free text: each keeps its
  time, level and structure, but every string becomes `<text:N>` (its length), a number with 9 or
  more digits in a row `<number:N>`, a code or type not shaped like the page's own (or holding 8 or
  more hex digits in a row) `ui.other` or `other`, and such a key `#N`; the page-load session is kept
  only in its `xxxxxxxx-xxxxxxxx` shape. Such a caller could write its own grant cut short, which no
  redactor can recognise (grants are stored as hashes). The owner's events keep their text, redacted.
- Stored data is cut to depth 4, 40 keys or items, and 512 characters per string.
- Bounded: both log rings, warning timestamps (4096), route keys (128), per-key detector windows
  (≤ threshold + 1 timestamps, ≤ 2048 keys), samples (≤ 720), percentile windows (512), last reload
  timings (64 roots; a detached project's goes at once, all of them on reset).
- Failure hooks only observe: `uncaughtExceptionMonitor` for exceptions and for rejections Node raises
  as exceptions (`--unhandled-rejections=throw`, the default, and `strict`); an `unhandledRejection`
  listener only where it changes nothing (`warn`, `none`, or another listener already handles them);
  Node's warning under `warn-with-error-code`. The configured policy (`execArgv`, then `NODE_OPTIONS`)
  decides whether the process survives, as it would without debug.

## Limits and notes

- One debug service per process reports domain events (`activeTelemetry()` is process-global).
  Tests that start several services in one process should enable debug on only one.
- The management socket (CLI and MCP front doors) is counted per method; it has no request id or Server-Timing.
- The thumbnail `render` phase goes to the request that started the paint. Requests that share an
  in-flight paint report only their wait in `total`.
