# Testing UI and service work

## Before handing back UI or service work

Run `npm run release-check:quick` (the full `npm run release-check` before a PR). It runs the type
checks, unit suites and production page build, then drives a fresh throwaway sandbox in Chromium.
It fails on any duplicate request, over-budget page view or unlisted `ui.*`/`svc.*` warning. Report
its verdict and `release-check.md` path; a red check is fixed or named, never passed over. The bug-class
catalogue, the cheapest check for each class and the kit commands are in the
[`archer-ui-verification` skill](../../.agents/skills/archer-ui-verification/SKILL.md); the gate itself is
documented in [`docs/devkit/agent-harness.md`](../devkit/agent-harness.md#release-check). It does not
replace the browser suite below.

## The browser suite: what jsdom cannot see

`npm test` runs under jsdom, which does no layout, no hit-testing, no stacking, and no press/focus
sequencing; `ui/tests/setup.ts` lists what has to be faked for it to run at all. Defects have shipped
green there that were obvious in a browser.
`npm --workspace ui run test:browser:ts` is the other half: Playwright drives Chromium against the page in `ui/dist`, served
by the TypeScript service started in the test process, and asserts on real `getBoundingClientRect`s
and on what the service received. It lives in `ui/tests/browser-ts/` (`*.e2e.ts`, so vitest never
collects it), with its helpers in `ui/tests/browser-ts/support/`. The Rust-era suite against the
Rust binary (`ui/tests/browser/`) went with the Rust implementation and is not in this tree.

- **Build first:** `npm run build`. Browser once per machine: `npx playwright install chromium`.
- **A change must add a browser test when it is about** layout or text fitting, hit-testing,
  focus or tab order, stacking (what paints or receives events over what), or the sequencing of
  pointer and keyboard events (press, focus, release, click). Add a jsdom test as well where one
  pins the cause; it cannot pin the outcome. Start from an existing `browser-ts` test and
  `sharedTsProject` (`ui/tests/browser-ts/support/shared-service.ts`): one service per Playwright
  worker, a fresh project attached per test (about 50 ms, against about 700 ms for a service of
  its own). The account remembers every root ever attached (256 at most) and a detach keeps it, so
  the fixture renews the worker's service after 192 attaches, between tests; one test gets 64
  shared projects at most. Use `startTsProject` (`ui/tests/support/ts-service.ts`, a service per test) only when the
  test changes the service itself: a restart, an offline seed (`beforeService`), a clock (`now`),
  HTTPS, the shared config file (`configPath`), or access grants it lists. A git-seeded case uses
  `sharedTsProject`'s `beforeAttach`.
- **A new row in the `?` cheat sheet needs a check** in `cheat-sheet.e2e.ts`, which fails when the
  sheet and its table of checks name different rows.
- **No sleeps and no retries.** Wait on a condition: `expect.poll`, a web-first `expect`, or
  `settled(page)` (`support/settled.ts`) for the drawing at rest. The canvas publishes its state for
  it: `data-camera="moving"|"idle"` on `.react-flow` (React Flow's move start/end, glides included)
  and `data-framed` once the opening framing is made. A sleep is kept only to show that nothing
  happens in a window, with a comment saying so. Retries are off in the config on purpose: a test
  that fails one run in ten is fixed or removed.
- **One theme or width where only colours differ.** Themes change custom properties only
  (`ui/src/styles.css`), so a geometry, focus or text check runs in one theme; a matrix alternates
  themes across widths so each width and each case still meets both. Keep both themes where the
  check is about paint or contrast.
- **A check that needs no browser goes in Vitest** (a file read, a pure computation, a Node/worker
  parity check). Keep one browser assertion for what only the browser shows.
- **A product defect the suite finds and you are not fixing** is recorded with `test.fail(...)`
  and a comment naming the cause: the test still runs, and goes red the day the defect is fixed so
  the annotation gets removed. Only an INTERMITTENT defect is parked with `test.fixme`, with its
  measured rate and the command that reproduces it.
- **axe runs on every main state** (`chrome.e2e.ts`, "axe"). Never disable a rule globally; an exclusion is
  one rule on one element, with its reason.

## The docs site and the playground

- `npm run docs:build` builds the site and the playground (`site/scripts/prepare.ts`:
  `prepareDocs()` + `buildPlayground()`), and fails over the per-view and per-chunk gzip budgets
  (`site/scripts/size-budget.mts`).
- `npm run docs:test:browser` (`site/tests/`, after `docs:build`) checks the landing, theme and hero
  in Chromium against the built site; `npm --workspace ui run test:playground`
  (`ui/tests/playground-browser/`) checks the static playground. Both serve the build with one
  Pages-like static server, `site/tests/serve-static.ts` (directory index, slashless redirect, clean
  URLs), as the dev server does (`publicDirectoryIndex`).
- `site/tests/smoke/clickthrough.e2e.ts` is the smoke test: it crawls every page, CLICKS every internal link (the
  VitePress client router handles a click, not a direct load), and checks the theme switch and Play in the hero and
  the Playground, failing on any 4xx or console error. A page and a folder of one name (`x.html` beside `x/`) are
  ambiguous on a static host: make the page the folder's `index.md`.
- `vitepress preview` indexes `dist/` when it starts: after a rebuild, restart it, or every new hashed asset 404s
  and the page looks dead (no theme switch, no hero).
- Load time: serve the build (`npx vitepress preview site --port 4173`) and run
  `cd ui && node ../tools/perf/site-load.mjs --base http://localhost:4173 --fail-on-error` (load and
  idle ms, bytes, every 4xx and error). The preview server brotli-compresses on each request (about
  2 s for the layout worker); Pages serves gzip, so read idle time from it with that in mind.

- Playground warm-up: every docs page, once per session and only when idle after load, prefetches the
  Playground's first view (`site/.vitepress/theme/warm-playground.mts`), listed in `playground/app/warm.json`,
  which the build derives from the manifest (`warmList` in `site/scripts/playground-build.mts`). It is skipped
  under Save-Data or a 2G connection. GitHub Pages serves every file with `Cache-Control: max-age=600`, so for
  10 minutes the click into the Playground reads from cache, and after that each file is a cheap 304
  revalidation, not a new download. `serveStatic(root, base, { pagesCache: true })` sends the same headers for a
  test (`site/tests/smoke/warm.e2e.ts`). Time the effect with
  `node --import tsx site/scripts/measure-playground-warm.mts [runs]` after `docs:build`: a fresh profile per run,
  throttled to 40 ms RTT and 20 Mbit/s by default, from the docs page to the Playground's first node.

## Where the test time goes

Measure before cutting. Write JSON reports and summarise them:

```sh
cd ts && npx vitest run --reporter=json --outputFile=/tmp/ts.json
cd ui && PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/browser.json npx playwright test -c tests/browser-ts --reporter=json
node tools/perf/test-timings.mjs /tmp/ts.json /tmp/browser.json --top 25
```

A test far slower than its timeout allows (a 15 s timeout, 970 s taken) was not running: the host
was suspended. Check `pmset -g log | grep -E " (Sleep|Wake) "` for that window. Every runner holds
off idle sleep for itself (`tools/keep-awake.mjs`, `caffeinate -i -w <pid>`; `ARCHER_KEEP_AWAKE=0`
turns it off), since a Mac set to `sleep 1` otherwise sleeps through an unattended run
(one run slept through 30 of the ts suite's 36 minutes).

### On macOS

CI runs this suite on Linux only; it also passes on a Mac, and a test must not assume Linux where a
Mac user does something else. Where the platform differs, the test says what the user means:

- **Keys on macOS.** Control+click is a right-click and Control+C is not copy: press
  `ControlOrMeta` (Playwright maps it to ⌘ on a Mac). End and Home in a text field scroll and leave
  the caret where it is (Cocoa's key bindings, which Playwright applies to Chromium on a Mac): to put
  the caret at the end, use `caretToLineEnd` (`support/keys.ts`), ⌘→ on a Mac. A product shortcut
  that checks `ctrlKey` alone is a product bug: accept `metaKey` too. Shift+F10 sends no
  `contextmenu` on a Mac (the context-menu key does); the page sends one itself
  (`ui/src/app/menu-key.ts`), so a test of Shift+F10 holds on both.
- **Temporary directories.** macOS's `tmpdir()` is behind a link (`/var` → `/private/var`), which
  Archer refuses on the way to a confined root, and long for a Unix socket path. The
  config moves `TMPDIR` to `/private/tmp/archer-test-<uid>` on a Mac, as `ts/vitest.config.ts` does.
- **Created dates on macOS.** APFS keeps a certain birth time, so a Created date is the file
  system's and no row names Git (`ts/src/project/file-dates.ts`). A test that needs a Git-dated row
  checks the corpus's birth times the way the service does, and checks what is drawn otherwise.
- **Fonts.** CI draws with DejaVu; a Mac with its system fonts. A width reserved in `ch` is the
  font's default "0", which is narrower than its tabular digits in a font with proportional default
  digits (SF): reserve the width in the glyphs that will be drawn.
