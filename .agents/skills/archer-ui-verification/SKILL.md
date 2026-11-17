---
name: archer-ui-verification
description: Verify a UI or service change in a real browser before handing it back. Use after any change under ui/src, ts/src/service or anything else the page or its requests can see, before a PR, and when a bug looks like one of the classes below (state decided at mount, overlap, focus, shifting ids, duplicate requests, re-render storms, event-loop stalls, caching, stale tests). Covers the bug-class catalogue with the cheapest check for each, and how to run the sandbox, harness, page-load lab and `npm run release-check`.
---

# Verifying UI and service work

Unit tests under jsdom were green for every defect in this catalogue. The browser and the budgets catch them.
The rules this verifies are [`UI_UX.md`](../../../UI_UX.md) (behaviour and accessibility) and `DESIGN.md` (visuals).

## When and what to run

1. While iterating: focused `npx vitest run <files>` in `ui/` or `ts/`.
2. Before handing back any `ui/src` or service change: `npm run release-check:quick`.
3. Before a PR or release: `npm run release-check` (adds smoke-a/b/c journeys, seeded monkeys, the lab on a
   throttled profile).
4. Chasing one bug: a sandbox, one journey, its `summary.json` (commands at the end).

The browser suite (`npm --workspace ui run test:browser:ts`, ~850 tests) runs past 10 minutes, longer
than a foreground shell may: run it in batches (file groups or `--shard=i/n`) or in the background and
take its completion notice. Never wait with a shell loop: `until ! pgrep -f "<cmd>"` matches its own
command line and spins for days.

A red gate is not handed back as green. Say which check failed, and either fix it or say why it is not yours.

## Bug classes and the cheapest check for each

Each class: what it looks like, the portable check, then the Archer specifics.

1. **State decided once at mount**: a mode chosen before editing turned on, a handler closing over old
   state, a side effect inside a state updater (runs twice under StrictMode). The reverse too: a default
   recomputed from polled data (the folders' open default re-decided every catalog poll, so 200 → 201 files
   closed folders and dropped focus); settle it once per visit and test the crossing while mounted. An effect that rebuilds DOM
   is keyed on content, not object identity: a re-read with the same highlights relaid the note and took the
   reader's selection from under "Comment on selection".
   A control copied into the loading toolbar is a new instance when the drawing arrives: its open menu and
   focus are lost unless handed over or held above both (a 2× CPU throttle widens the window).
   Check: dev build under StrictMode plus a detector for the same write sent twice, keyed on what the
   service sees (source + edit) and fired only when a request is actually sent; assert state after every
   step, not only at the end.
   Archer: `ui.edit.double-commit`, `ui.edit.pointer-hand`; invariants `duplicate-writes`, `pointer-mode`.
   A control disabled for a settling moment (a layout pass, an edit in flight) silently eats a click that
   lands then (Save, the part buttons): keep it enabled, say `aria-busy`, run the click once settled.
   Check: a MutationObserver on `disabled` through a preview landing (the Save and part tests in `authoring.e2e`); a
   journey step that changes the source ends with `settle()`.
2. **Library defaults fighting the feature**: double-click zooms, auto-pan while connecting, hand mode
   by default, a re-render eating the second click.
   Check: do the gesture in a real browser and assert the viewport and the target did not change.
   Archer: `pointer-mode`; a `ui/tests/browser-ts` test for the gesture (`docs/agents/ui-testing.md` says when one is required).
3. **Layering, overlap, clipping**: toolbars over panels or handles, alerts under a pane, content under chrome.
   Check: after every step, intersect the boxes of the chrome elements, and `elementFromPoint` the centre of
   every alert and control. Screenshot each editor at two widths and both themes.
   Archer: `chrome-overlap`, `chrome-clipped`, `chrome-scrolls`, `alert-visible`; `editor-entry.mjs` shots.
   Chrome at the left edge (toolbar, key, legend) is covered by the hover-expanded sidebar when a layout shift
   fires under Playwright's resting pointer at (0, 0): `page.mouse.move(700, 450)` after `goto` in any test that
   clicks it (`diagram-layout.e2e.ts`). Baseline-compare a red e2e before blaming the change: a second worktree
   of the base commit with `node_modules` symlinked builds and runs in minutes.
   The page itself never scrolls: a few pixels of overflow scroll it when focus moves. Check
   `documentElement.scrollHeight === innerHeight`. Example: the hidden caption copy kept the bar's padding.
   On the drawing, measure at every zoom a control or label shows (opening, Fit, zoomed in, a frame
   opened), not only the opening view: a 44 px hit area scaled to 20 px after Fit, and a wire
   struck through a frame caption only once the frame opened (`frame-toggle-clear.e2e.ts`).
4. **Parity across types**: a gesture works in one diagram type and silently does nothing in another.
   Check: one journey per gesture × type; each type either does it or refuses with a message.
   Archer: smoke-a/b journeys, one seeded monkey per family (full gate).
5. **Focus and keyboard**: focus falls to `<body>` after a commit, shortcuts fire while typing or die.
   Check: press keys at document level as a person does, never by clicking the button; assert where focus is.
   Archer: `shortcut-focus`, `label-focus`; `ui.undoKey()`/`ui.redoKey()`.
   Discussion pins: assert focus after open/Close and after dismissal; an intermediate programmatic focus
   must not erase the invoking pin, and a removed pin cannot receive return focus (`comments`, `sequence-block-comments`).
   Drag a discussion across chrome and assert it stays detached and covered controls become inert: a queued
   placement observer must not reattach it after the gesture (`sequence-block-comments`, docked Key case).
6. **Shifting ids**: positional ids (`msg-N`) renumber, derived ids (`a--b`) change after a retarget, and
   selection or an open editor points at a different thing.
   Check: compare the selection by id and by visible label before and after each step.
   Archer: `selection-identity`; `seq.drawMessage` finds the new id by label diff.
7. **Server editors on unusual input**: comments, CRLF, styling lines, nested blocks; wrong splice, or a
   refusal the person cannot act on.
   Check: an awkward-input corpus plus a seeded fuzz with shrinking; every refusal names a next step.
   Archer: `awkward` corpus, `npm --workspace ts run test:stress` (opt-in), `svc.edit-postcondition`.
8. **Transport and session**: cookies, proxies, URL flags, redirects, draft recovery after reload, a write
   from elsewhere while editing, leaving a dirty editor.
   Check: journeys for reload mid-edit, a second tab, a reader link, an external write; a dirty-navigation guard.
   Archer: `dirty-navigation`; `ui.reload()`, `agentWrite`, `readerContext()`; smoke-c journeys.
   Chromium's offline mode keeps an open event stream alive, so `setOffline` alone never shows a real loss: also
   run `ui.prepareStall()` + `ui.stallNetwork(true)` (stream held silent, requests failing, no `offline`).
   The page reports "lost" on `offline`, a read failing at the network (checked once), or the 45 s stall rule.
   A read out while an event of its kind arrives is older than the event: drop it (`arrived` counts in
   `host-bridge.ts`). The view-turn emphasis read applied after `set_emphasis`'s event emptied the highlights.
   Check: hold the read in a test, emit the event, then answer the read (`emphasis-shell.test.tsx`).
9. **Duplicate requests and over-fetching**: two components each fetching the same thing; N+1 per item.
   Check: per page view, count requests by method + URL + body with poll ticks excluded. Allow zero
   duplicates except a reasoned allow-list, and cap API requests per view. Find the call sites from
   initiator stacks. A poll is tagged, never inferred from the gap ("any repeat ≥ 900 ms" let a bootstrap
   read twice 1 s apart pass) or from what is in flight (an ambient tag exempted every read made while a slow
   bell tick was pending): `schedulePoll` (`ui/src/app/polls.ts`, the one home of intervals) hands each tick
   its own `<name>#<n>` tag, the tick passes it down its own fetch path (`withPollTag`), and one copy of each
   request per tick counts as the tick. A harness step is no excuse (an assertion step changes nothing), nor
   is a heartbeat: only an input, a data-carrying stream message or a changed ETag makes a repeat legitimate.
   One classifier decides for the harness, lab and budget: `tools/perf/lib/requests.mjs`; a new poll adds its
   name and URLs to `SCHEDULED_POLLS` there.
   Reads for something not on screen are over-fetching too: key per-view reads on what the page shows, not on
   state that arrives with it (a note route read the agent's presented view until the note opened).
   A redirect is a `history.replaceState` before the first read, not a second page load: `-/edit/?viewId=`
   reloaded from a `useState` initializer while the component's effects still read. The per-view cap counts
   reads; committed edits (`isCommittedEdit`) are a person's changes, gated by `duplicate-writes`. A request
   counts for the document that issued it: the outgoing page keeps asking until the next one commits
   (`trackDocuments`), and a page past `pagehide` starts no work and treats what it stopped as a cancellation, not an error (a refused layout retried there fetched a
   new ELK worker). Before
   blaming the page for a `svc.duplicate-request`, check the harness's own requests (resets logged in again).
   Archer: `archer-budget/1` blocks → gate checks `duplicate-requests`, `api-requests-per-page`;
   `page-load.mjs --initiators` on an unminified page. `ui.fetch-duplicate` keys writes on a body hash;
   check `svc.duplicate-request` does too before trusting it on POSTs.
10. **Full re-render per edit**: every node re-renders when one changes; large diagrams take seconds.
    Check: a commit counter per component with a storm threshold; profile the app's own CPU time, not the
    test driver's.
    Archer: `ui.render-storm`; harness `--profile --no-trace-snapshots`, `step.cpu.appMs`; `flow-large`.
11. **Blocking work on the service's event loop**: rendering or parsing on the request thread stalls everyone.
    Check: an event-loop delay histogram with a threshold; move CPU work to worker threads.
    Archer: `svc.event-loop-lag` (≥ 500 ms fails the gate), `svc.slow-request`; `/-/debug/profile/cpu`.
12. **Caching headers**: the page re-downloaded on every load, uncompressed, `no-store`; a large API answer
    polled raw (the catalog moved 4.24 MB/min per idle tab at scale M).
    Check: a warm reload moves revalidation bytes only (304s); cap the compressed page size; an idle polled
    page moves headers only (the page sends its held ETag; API answers stay `no-store`, 304 after auth).
    Count idle reads from Resource Timing (`transferSize`): Playwright's request events missed those 304s. At M
    raise the buffer first (`performance.setResourceTimingBufferSize` in an init script): it holds 250 by default.
    Archer: lab warm rows ≤ `budgets.maxWarmTransferBytes`; `pageSize` caps in `tools/release-check/config.json`.
    Over TLS, never `ignoreHTTPSErrors`: Chromium then caches nothing and every warm load looks like a
    regression. Pin the sandbox leaf: `page-load.mjs --tls-ca <caPath>` (lib/tls.mjs), which also
    checks the wire status (`responseReceivedExtraInfo`: 304 there, 200 in `responseReceived`).
    The ELK worker is `/-/page-assets/<hash>.js` (immutable): a second page fetches it from cache (same `Date`
    header).
    Per-route first-load bytes come from Resource Timing: a worker's script response never reaches the page's
    CDP session (the request does, with no loader id), so CDP alone hides the worker and never settles the load.
13. **Stale or skipped tests**: tests that no longer run, run the wrong thing, or "pass" in an incomplete environment.
    Check: one gate runs every suite and reports an environment gap as a warning with its cause, never as a pass.
    Archer: the gate's `unit` step (a missing ripgrep, "ripgrep (rg) is not installed", → WARN); `test.fail(...)` for
    known defects (`docs/agents/ui-testing.md`). A detector that cannot read its source is a WARN too: a 64-hex token check against the
    service's 32-hex token hid every `svc.*` warning for a pass (`tools/devkit/lib/service-log.mjs`). Test the
    property, not the mechanism: `page-bundle.test.ts` checks each hashed file's bytes, not which build hooks exist.
    The hand-maintained fake server is gone (every recorded failure of it was drift): page tests,
    jsdom and browser, run on the real service (`ui/tests/support/ts-service.ts`, `page-on-service.ts`). What
    remains is the in-memory comments store (`ui/tests/support/comments-store.ts` behind `memory-transport.ts`),
    for unit tests only, held to the service by `comments-contract.test.ts`; a behaviour it lacks is a case there.
    A hand-spelled wire fixture hides a parser that drops real answers: the compile parser required a string
    `sourceRevision`, the deleted file's `null` was dropped, and the fixtures never had one. Feed parsers a captured answer.
14. **Debug code shipping**: telemetry or a profiling renderer in the production page.
    Check: build the production artefact and grep it for the debug markers.
    Archer: the gate's `page-build` step (`ui/scripts/check-prod-strip.mjs`).

15. **Reading a browser test mid-change**: a computed colour read during a 120 ms transition (`/ 0.262` for
    `0.25`), an element resolved in one protocol call and read after a re-render swapped it (`parentElement`
    null), a route handler still holding a second read of the same URL when the test ends.
    Check: `expect.poll` for computed styles; find and measure inside one `evaluate`; hold only the request
    the test is about (`route.continue()` the rest). Read styles under reduced motion, where the page runs none
    (`UI_UX.md`, Motion).
    Archer: `walkthroughs.e2e` fade, `support/emphasis-motion.ts`, `embedded-view.e2e` figure route.
    A harness check in a `setTimeout(0)` after a key can run after the next keys: Chromium runs input ahead of timers. Judge a key from its own events: `tools/devkit/harness/key-recorder.mjs` ends a key at its keyup or the next keydown.
    A `Failed to fetch` mid-test is not page teardown, which logs nothing in Chromium: read the trace's
    `_failureText`. `net::ERR_NETWORK_CHANGED` is the host's network changing (containers starting).

16. **State contrast read from styles**: a pressed, selected, focused or dimmed state that looks fine in
    computed styles and fails on screen. An ancestor's opacity fades a ring the style shows at full
    strength (1.69:1), a fill-only pressed state passes no ratio (1.16:1), and a
    probe that mis-parses `color(srgb …)` reads 2.61 where pixels give 4.87.
    Check: capture every state (rest, hover, pressed, selected, focused, dimmed and focused) in both themes
    and measure the composited pixels of the cue against what touches it, ≥ 3:1 (text 4.5:1).
    Archer: `ui/tests/browser-ts/support/pixels.ts`, `tools/devkit/harness/contrast.mjs` (its raw flags
    need classifying; it is not a verdict).

## The warning budget

Every `ui.*`/`svc.*` warning fails the gate unless `tools/release-check/allowed-warnings.json` covers it.
An entry is `{code, reason, match?, run?, max?, kind}`: `false-positive` (why the detector is wrong, and
what judges the real case) or `debt` (ledger id; printed on every run). Narrow entries with `match` (for
example, only tasks under 1 s), and delete an entry the day its cause is fixed. Duplicate and failed
requests have the same rule, in `config.json` (`allowedDuplicates`, `allowedFailedRequests`).

## Running the kit (Archer)

```sh
npm run release-check:quick                       # typecheck, unit, page build, sandbox, lab, 5 journeys, budgets
npm run release-check -- --skip unit              # any step can be skipped; the verdict then says "partial"
node tools/devkit/sandbox.mjs up --name me --debug-ui        # your own sandbox (never your own service)
node tools/devkit/harness/smoke.mjs --sandbox me --journey tools/devkit/journeys/<file>.mjs
node tools/perf/page-load.mjs --base <origin> --login '<link>' --pages diagram --profiles default --initiators
node tools/devkit/sandbox.mjs down --name me
node tools/perf/round.mjs --out <scratch>          # a full performance measurement: manifest, TLS, coverage
# the static docs site and its playground (serve first: npm run docs:build && npx vitepress preview site --port 4173)
(cd ui && node ../tools/perf/site-load.mjs --base http://localhost:4173 --fail-on-error)   # load/idle ms, bytes, 4xx, errors
# where test time goes (Vitest --reporter=json / Playwright --reporter=json reports)
node tools/perf/test-timings.mjs ts.json ui.json browser.json --top 25
```

Slow tests: time them before cutting (`test-timings.mjs`). The browser suite's usual costs were a service
per test and fixed sleeps: new tests take `sharedTsProject` (one service per worker, a project per test) and
wait with `settled(page)` or a condition, not a clock (`docs/agents/ui-testing.md`). A test "taking" far longer
than its timeout means the Mac slept (`pmset -g log`); runners hold `caffeinate` (`tools/keep-awake.mjs`).
The docs site and playground: `npm run docs:test:browser`, `npm --workspace ui run test:playground`.

`round.mjs` and a sandbox without `--page`/`--debug-ui` serve `ui/dist` as it is: run `npm --workspace ui run
build` after your last commit, and record its sha256 (otherwise a round and the leak journey measure the
previous commit's page because nothing rebuilt it; the debug journeys, which build their own, do not).

Every request must also match `tools/perf/manifests.json` for its page and load (`page-load.mjs --manifest`):
a read of a view the page does not show (an agent's presented view while a list is shown) fails even when it is
not a duplicate. `--seed-fault <kind>` shows a gate failing before you trust it passing.

A scratch build (`vite build --outDir <dir>`, so a parallel build doesn't replace `ui/dist` under a
running suite) is tested with `ARCHER_PAGE=<dir>/index.html`: every e2e file names its page through
`testPage()` (`ui/tests/browser-ts/support/page-path.ts`), which fails with "build ui/dist first" when
neither is there. A new e2e file uses it too, never `resolve("dist/index.html")`.

Reading a red gate: `release-check.md` names the failing step and its evidence. Journeys point to
`summary.json` (`failures[]`, then `trace.zip`); budget lines name the page view and the request; lab
lines name `<page>/<profile>/<load>` in `lab/perf-report.md`. Details: `docs/devkit/agent-harness.md`.

When a new kind of bug gets through, add the cheapest check that would have caught it (an invariant, a
telemetry code, a budget) and a line to this catalogue in the same change.
