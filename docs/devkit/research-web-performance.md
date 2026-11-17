# Research: keeping the page minimal and fast, and measuring it durably

Researched 2026-10-30 against primary sources (web.dev, Chrome for Developers, MDN, WHATWG, IETF,
the Chrome DevTools Protocol `.pdl` files, Playwright, Vite, Lighthouse and the tools' own READMEs).
It builds on what exists: `tools/perf/page-load.mjs`, `budgets.json`, `scale-gates.mjs`,
`tools/release-check/`, the devkit harness, [browser-telemetry.md](browser-telemetry.md) and
[performance-baselines.md](../performance-baselines.md). Statements about Archer's own code are
from a development build after 0.7.1. Where a sentence is my inference rather than a source's, it says so.

## Where Archer is today (from the repo, not a source)

- **The page is one file.** `ui/vite.config.ts` uses `vite-plugin-singlefile`. The local build is
  `ui/dist/index.html` at 2.39 MB raw / 576 KB brotli, with Inter embedded (`ui/src/theme/current-font.css`)
  and CSS inlined. The ELK layout worker is the one split-out asset:
  `page-assets/elk-layout-worker-<hash>.js`, 1.5 MB raw / 355 KB brotli.
- **Caching is already correct by the standard pattern.** The shell is `private, no-cache` plus a weak
  ETag (`PAGE_CACHE_CONTROL`, `ts/src/service/http.ts`), and hashed page assets and thumbnails are
  `max-age=31536000, immutable`. Project data is `no-store` with page-held ETags.
  The packager pre-compresses with gzip 9 and brotli 11 (`ts/src/service/page-version.ts`).
- **HTTP/2 is opt-in** (`ARCHER_HTTP2=1`, `node:http2` `createSecureServer` with `allowHTTP1`).
  Without it, each tab's single `EventSource` (`ui/src/app/http-connection.ts`) holds one of the
  browser's HTTP/1.1 connections to the origin.
- **No `<link rel=icon>`** in `ui/index.html`, so the browser fetches `/favicon.ico`. The harness
  already ignores `favicon` console errors, which suggests that request fails on every load.
- **The lab measures well already**: bytes, requests, duplicates, polls, initiators, LCP/CLS/FCP/TTFB,
  long tasks, heap after GC, DOM shape, optional Lighthouse. The harness reads `Performance.getMetrics`.
  **Not measured yet**: unused JS/CSS bytes, Long Animation Frames, INP under scripted interaction,
  memory growth across repeated navigation, main-thread time by category, SSE reconnects, and a
  per-page list of expected resources.

## Recommendations, ranked by value for Archer

1. **Per-page resource manifests, checked in, each entry with a reason** (§5). This is the
   "only what each page needs" rule turned into a test. Any new request kind fails until someone
   names why it is there. It replaces most numeric request caps.
2. **Ratchet, then compare to the last release, with noise handled** (§5). Counts and bytes are
   deterministic and can only go down without a reason. Timings get compared against the last
   release with interleaved runs and a confidence interval, never against a fixed number.
3. **Add JS/CSS coverage per page** (`Profiler.takePreciseCoverage` / Playwright `page.coverage`, §3).
   Unused bytes on load is the evidence for any split decision. Without it, splitting is guesswork.
4. **Make HTTP/2 the default over TLS** (§1, §2). It removes the 6-connections-per-origin limit
   that SSE tabs share. Measure first, because one big file gains little else from h2.
5. **Kill the zero-value requests**: an inline `data:` SVG favicon (or a 204 at `/favicon.ico`) and
   no manifest unless installability is wanted (§1).
6. **Long Animation Frames + scripted-interaction INP in the harness** (§3). These attribute jank to
   scripts and forced layout, which the 200 ms `longtask` warning cannot.
7. **A leak check across navigation**: N loops of a journey, `Memory.getDOMCounters` and the
   heap after GC per loop. Fail on monotonic growth, with a heap snapshot on failure (§3).
8. **Move the script out of the HTML into one hashed, immutable file** only if coverage and
   warm-compile timing show it helps (§1, the code-cache point). Keep the "few requests" shape:
   document + one script + worker.
9. **Replace the deprecated `Network.emulateNetworkConditions`** before Chrome drops it (§4).
10. **A quarterly review rota** of axe-core, visual diff, offline/SSE resilience and the rest (§6).

---

## 1. Request count: what sets it, and how to cut it

**What determines it.** A page needs the document, every render-blocking subresource it names
(scripts, stylesheets, fonts discovered through CSS), the data it fetches after boot, any long-lived
stream, and whatever the browser adds on its own. The browser adds `/favicon.ico` when no
`rel=icon` link is present: "in the absence of a link with the icon keyword … user agents may
instead … [fetch] `/favicon.ico`" ([WHATWG HTML, rel=icon](https://html.spec.whatwg.org/multipage/links.html#rel-icon)).
Each extra dependent request costs at least one round trip. That matters on a remote link, where the
lab profile models 40 ms.

**Techniques, with their trade-offs:**

| Technique | What the source says | Fit for Archer |
|---|---|---|
| Inline critical CSS | ~14 KB fits the first round trip (TCP slow start, ~10 packets). Inlined styles cannot be cached separately, and "if everything is prioritized then nothing is" ([web.dev](https://web.dev/articles/extract-critical-css)) | Already done (all CSS inline). Fine for a local app with a 304'd shell |
| Single bundle vs splitting | A single commons bundle ships code a route never uses. Granular chunks cache better. Going from 5 to 15 initial requests changed load and FCP "about the same", and only hundreds showed overhead; Next.js chose ≤ 25 ([web.dev, granular chunking](https://web.dev/articles/granular-chunking-nextjs)) | Archer's single file is a deliberate choice. Splitting it saves only what coverage proves unused |
| `modulepreload` | Fetches, parses and compiles a module into the module map, unlike `preload`, which only fetches ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/modulepreload)). Vite emits it for entry chunks and rewrites dynamic imports to preload their dependencies in parallel ([Vite features](https://vite.dev/guide/features)); `build.modulePreload` defaults to `{polyfill: true}` ([Vite build options](https://vite.dev/config/build-options)) | Only relevant if Archer splits; it flattens the waterfall a split would otherwise add |
| Fonts | `font-display`: `swap` = tiny block period, infinite swap; `optional` = tiny block period, no swap ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-display)) | Inter is embedded with `swap`: no request, but its bytes ride in every uncached shell. System fonts cost 0 bytes; a Latin subset is the middle ground. A design decision |
| Icons as inline SVG | (no source needed: an inline icon is markup, not a request) | Keep. Never add an icon font or sprite request |
| Small assets inline | Vite inlines imported assets under `build.assetsInlineLimit` = 4096 bytes ([Vite build options](https://vite.dev/config/build-options)) | Single-file inlines everything, so the limit does not apply |
| Data in the HTML vs fetched | (inference) Embedding the first API answer in the shell saves one round trip | **Conflicts with the caching contract**: the shell is `no-cache` and project data is `no-store`. Embedding data would make the shell `no-store` and lose its 304. Not worth it |
| Favicon / manifest | See WHATWG above | Add `<link rel="icon" href="data:image/svg+xml,…">`: zero requests. No manifest unless install is a goal |
| Fetch priority | `fetchpriority` and `fetch(…, {priority:'low'})` are hints that do not affect discovery ([web.dev](https://web.dev/articles/fetch-priority)) | Already done: fetch-ahead is low priority and paced (`ui/src/app/thumbnail-fetch-ahead.ts`) |

**SSE and connection limits.** Without HTTP/2, SSE is "limited to the maximum number of open
connections … 6 per browser and domain", across all tabs, and Chrome and Firefox marked raising it
"Won't fix". Over HTTP/2 the limit is the negotiated stream count, defaulting to 100
([MDN EventSource](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)). RFC 9113
recommends `SETTINGS_MAX_CONCURRENT_STREAMS` "no smaller than 100"
([RFC 9113 §6.5.2](https://www.rfc-editor.org/rfc/rfc9113.html#section-6.5.2)). With five Archer tabs
open over HTTP/1.1, five of the six connections are streams. A sixth tab's fetches then queue
behind one connection, or stall (inference from the limit).

**When splitting is worth it** (synthesis of the sources above, applied to Archer). Split a piece out
only when all four hold:

1. It is large: tens of KB compressed or more. Below that, the extra request and wrapper cost more.
   The release-check note records lazy-loading chat as 313 bytes *larger* gzip in the one-file page.
2. Coverage shows it unused on the page views that matter most (reader pages).
3. It is not needed for first paint, or can preload in parallel.
4. Better: it changes at a different cadence (vendor vs app code) or runs off-thread (the ELK worker).

The ELK worker meets all four. CodeMirror (editor only) is the next candidate to measure.
**Code cache** is the argument for moving the script out of the HTML at all. Chrome caches inline
scripts only "by attaching their cache to the HTML document's resource", so the cache depends on
"the *entire* HTML document not changing", and V8 recommends external files for non-trivial scripts
([V8 blog, code caching](https://v8.dev/blog/code-caching-for-devs)). Whether that helps a 304'd
shell is unverified. Measure warm `ScriptDuration` before and after (§3).

## 2. Transfer: compression, caching, protocol, service workers

**Compression.** `Content-Encoding` tokens: `gzip`, `br` (RFC 7932), `zstd` (RFC 8878), plus
dictionary variants `dcb`/`dcz`. Compressing already-compressed media "is usually inappropriate"
([MDN Content-Encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Encoding)).
Support for zstd arrived in Chrome/Edge 123 (2024-03), Firefox 126 (2024-05) and Safari 26.3 (2026-02).
That is Baseline "Newly available" since 2026-02-11
([web-features explorer](https://web-platform-dx.github.io/web-features-explorer/features/zstd),
[Chromium intent to ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/GFFOLCF12a4/m/crdNkVeaAQAJ)).
Node has zstd in `node:zlib` since v23.8.0 / v22.15.0, marked **Experimental**
([Node zlib](https://nodejs.org/api/zlib.html)).

*For Archer:* keep pre-compressed brotli 11 for static bytes. It is already the best ratio for
data that is compressed once. zstd would help only dynamic answers (the fast-level brotli 5 /
gzip 6 in `sendRevalidatedJson`), on a still-experimental Node API, so it is not worth adopting
now. PNG thumbnails must not be re-compressed (per MDN above); check that they are sent without
`Content-Encoding`.

**Caching.** Hashed assets: `max-age=31536000, immutable`. HTML: `no-cache` so it revalidates.
`no-cache` "allows caches to store a response but requires them to revalidate it"; `no-store` forbids
storage ([MDN Cache-Control](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control)).
ETag (content-based) is the preferred validator, answered with `304`
([web.dev HTTP cache](https://web.dev/articles/http-cache)). Archer already matches this exactly.
The remaining lever is *how much* the shell holds: every release changes one 576 KB file. A
split vendor/app/worker set would re-download only what changed. That pays off only if releases are
frequent relative to how often readers load cold.

**HTTP/1.1 vs HTTP/2 over TLS.** Browsers support HTTP/2 only over TLS: "there are no browsers known
that support unencrypted HTTP/2", hence `http2.createSecureServer()`
([Node http2](https://nodejs.org/api/http2.html)). The 6-connection limit and the case for
multiplexing are above. Granular chunking only works well under HTTP/2
([web.dev](https://web.dev/articles/granular-chunking-nextjs)). *For Archer:* run the lab with
`ARCHER_HTTP2=1` vs off on the `remote-link` profile. Default it on for TLS if it is no worse,
because it fixes the multi-tab SSE limit regardless of bytes. Plain-HTTP loopback stays HTTP/1.1.

**Service workers: not recommended here.** Pros: offline shell, and scripts cached at install get a
full code cache at once ([V8 blog](https://v8.dev/blog/code-caching-for-devs)). Cons: a new worker
waits until every tab using the old one closes. `skipWaiting` can mix versions within one page, and
background update checks are skipped if one ran in the last 24 h
([web.dev SW lifecycle](https://web.dev/articles/service-worker-lifecycle)). Service workers need a secure context
([MDN Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)), which a
self-signed LAN certificate complicates (inference). Archer's data is live, `no-store` and
SSE-driven, so offline adds little and staleness risk is high.

## 3. Metrics beyond load, and how to measure each headlessly

**Core Web Vitals (current).** Thresholds are at the 75th percentile of page loads
([web.dev Web Vitals](https://web.dev/articles/vitals)):

| Metric | Good | Poor | Definition source |
|---|---|---|---|
| LCP | ≤ 2.5 s | > 4.0 s | [web.dev/lcp](https://web.dev/articles/lcp): standalone `<svg>` is **not** a candidate; text blocks and images are |
| INP | ≤ 200 ms | > 500 ms | [web.dev/inp](https://web.dev/articles/inp): clicks, taps and keys only (not scroll or hover); longest interaction, ignoring one per 50. INP replaced FID in 2024 ([web.dev](https://web.dev/articles/vitals)) |
| CLS | ≤ 0.1 | > 0.25 | [web.dev/cls](https://web.dev/articles/cls): largest session window, shifts < 1 s apart, window ≤ 5 s |

*Archer note:* diagrams render as SVG, so LCP lands on text or a thumbnail `<img>`, not the drawing.
Add an `elementtiming` attribute on the drawing for a "diagram visible" mark
(the `element` entry type, [MDN supportedEntryTypes](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceObserver/supportedEntryTypes_static)).
A route change is not a navigation. `web-vitals` supports soft navigations only in Chromium 151+
with `reportSoftNavs: true` ([web-vitals README](https://github.com/GoogleChrome/web-vitals)).

**TBT, long tasks, LoAF.** TBT sums each long task's time over 50 ms between FCP and TTI. It is a lab
metric, with good < 200 ms on average mobile hardware ([web.dev/tbt](https://web.dev/articles/tbt)).
Long Animation Frames (`long-animation-frame`, Chrome 123+) measure whole frames delayed > 50 ms with
`blockingDuration`, `renderStart`, `styleAndLayoutStart`, and per-script attribution for scripts > 5 ms
including `forcedStyleAndLayoutDuration`. Long Tasks are not deprecated
([Chrome LoAF](https://developer.chrome.com/docs/web-platform/long-animation-frames)). The fix
pattern is yielding (`scheduler.yield()`) every ~50 ms of work
([web.dev](https://web.dev/articles/optimize-long-tasks)). **LoAF is the single best addition**: it
names the script and forced-layout time behind a slow canvas interaction.

**Measurement map** (headless Chromium via Playwright; CDP methods from the protocol's own
`.pdl` files: [browser](https://github.com/ChromeDevTools/devtools-protocol/tree/master/pdl/domains),
[js](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/js_protocol.pdl)):

| What | How (exact API) | Already in Archer? |
|---|---|---|
| LCP / CLS / FCP | `PerformanceObserver` in an init script, or CDP `PerformanceTimeline.enable({eventTypes:[…]})` → `timelineEventAdded` (carries `lcpDetails`, `layoutShiftDetails`) | yes (observer) |
| INP | `event` entries (`durationThreshold: 16`) after scripted `page.click`/`keyboard` | debug telemetry only; not in lab/harness numbers |
| Long tasks / LoAF | observe `longtask` / `long-animation-frame` (check `PerformanceObserver.supportedEntryTypes`) | longtask yes, LoAF no |
| Unused JS/CSS bytes | Playwright `page.coverage.startJSCoverage()` / `startCSSCoverage()` (Chromium only; V8 format, `resetOnNavigation` default true) ([Playwright](https://playwright.dev/docs/api/class-coverage)); or CDP `Profiler.startPreciseCoverage({callCount, detailed})` + `takePreciseCoverage`, and `CSS.startRuleUsageTracking` / `takeCoverageDelta` / `stopRuleUsageTracking` | no |
| Main-thread time by category | CDP `Performance.getMetrics` → `ScriptDuration`, `LayoutDuration`, `RecalcStyleDuration`, `TaskDuration`, `LayoutCount`, `RecalcStyleCount` ([names: Puppeteer](https://pptr.dev/api/puppeteer.page.metrics)); fuller breakdown from a trace (`browser.startTracing`, opens in DevTools Performance ([Playwright](https://playwright.dev/docs/api/class-browser#browser-start-tracing))) or Lighthouse's `mainthread-work-breakdown` (script evaluation, style & layout, rendering, parsing, compile, GC; [Chrome](https://developer.chrome.com/docs/lighthouse/performance/mainthread-work-breakdown)) | harness reads getMetrics; lab does not |
| Layout thrash | `LayoutCount` / `RecalcStyleCount` deltas per interaction; LoAF `forcedStyleAndLayoutDuration`; DevTools "Forced reflow" insight ([web.dev](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing)) | no |
| Memory growth / leaks | Per loop: `HeapProfiler.collectGarbage` ×2, `Runtime.getHeapUsage`, `Memory.getDOMCounters` (`documents`, `nodes`, `jsEventListeners`); `Memory.prepareForLeakDetection` + `getDOMCountersForLeakDetection`; `DOM.getDetachedDomNodes` (experimental); `HeapProfiler.takeHeapSnapshot` on failure. DevTools workflow: snapshot, filter `Detached` ([Chrome memory](https://developer.chrome.com/docs/devtools/memory-problems)) | heap once after load; no loop |
| React renders | `__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot` count (exists: `COMMIT_COUNTER_SCRIPT`); `<Profiler onRender>` gives `actualDuration` vs `baseDuration`, but is off in production builds ([react.dev](https://react.dev/reference/react/Profiler)), and the debug build already swaps in `react-dom/profiling` | counter exists, unused by lab |
| SSE reconnect | Spec: on error the client waits the reconnection time (`retry:`), resends `Last-Event-ID`, and 204/non-200/wrong type closes for good ([WHATWG SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html)). Test: restart the service or `context.setOffline(true/false)` mid-journey; count `api/events` requests, time to first event, and missed updates | no |
| Throttling | `Emulation.setCPUThrottlingRate({rate})`; network: `Network.emulateNetworkConditions` is now **deprecated** in the protocol, superseded by experimental `Network.emulateNetworkConditionsByRule` + `Network.overrideNetworkState` | lab uses the deprecated call |

Caveat on throttling. DevTools throttling is request-level: "latency affects things at the packet
level rather than the request level", so it is approximate. Packet-level shaping is the most accurate
option but needs `sudo` and affects the whole machine
([Lighthouse throttling](https://github.com/GoogleChrome/lighthouse/blob/main/docs/throttling.md)).
For Archer the `remote-link` profile is good enough for *relative* comparison. Absolute remote-link
numbers need a real remote reader.

Caveat on coverage. It reflects only what ran during the recording, so code used by an untested
interaction shows as unused ([Chrome Coverage](https://developer.chrome.com/docs/devtools/coverage)).
Report it per page *and* per journey.

## 4. Tools: what each gives, cost, fit for a no-cloud local tool

| Tool | Gives | Cost | Fit |
|---|---|---|---|
| **CDP via Playwright `newCDPSession`** ([Playwright](https://playwright.dev/docs/api/class-cdpsession)) | Everything in §3 | Already wired | **Core**. Extend, don't replace |
| `Profiler.takePreciseCoverage` / `page.coverage` | Used vs unused bytes per script/sheet | ~50 lines; the single file needs source maps to attribute to modules | **Adopt** (rec. 3) |
| `PerformanceObserver` types | LCP, CLS, event (INP), longtask, LoAF, element, resource | Init-script lines | **Adopt LoAF + event** |
| `HeapProfiler` / `Memory` domain | GC, heap, DOM counters, snapshots | ~80 lines for a loop runner | **Adopt** (rec. 7) |
| `Performance.getMetrics` | Layout/style/script durations and counts | Already in harness | Add to lab rows |
| `Emulation.setCPUThrottlingRate` / network emulation | Slow-reader profiles | In use | Migrate off the deprecated network call |
| Chrome tracing (`browser.startTracing`) | Full timeline, openable in DevTools | Cheap to capture; costly to parse | On failure only, as an artefact |
| **Lighthouse** (already `--lighthouse`) | Scored audits, TBT, main-thread breakdown; **user flows**: navigation / timespan / snapshot ([docs](https://github.com/GoogleChrome/lighthouse/blob/main/docs/user-flows.md)) | `npx`, needs network once | Keep optional. Timespan mode fits SPA interactions but drives Puppeteer, not Playwright |
| **Lighthouse CI** | `lhci autorun`, assertions (`lighthouse:recommended`), runs several times per URL; upload to public temp storage or a self-hosted server ([getting started](https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/getting-started.md)) | A server to host for history | **Emulate, don't adopt**: its assert-and-median model is what `release-check` already does, without the server |
| **size-limit** | Size and execution-time limits, `--why` analysis; suggests starting at current + ~25% ([README](https://github.com/ai/size-limit)) | Small | **Emulate**: `release-check` sizes already do this. Its time plugin is noisy by its own admission |
| **rollup-plugin-visualizer** | Treemap/sunburst/network/flamegraph; `raw-data` JSON and `list` YAML, meant for committing ([README](https://github.com/btd/rollup-plugin-visualizer)) | One Vite plugin | **Adopt for diagnosis**: commit the `list` output per release for a reviewable diff of what got bigger |
| source-map-explorer | Bytes per source via sourcemaps | Small | Redundant: `release-check` already attributes bytes per source bucket through sourcemaps |
| **web-vitals** | `onLCP/onINP/onCLS/onFCP/onTTFB`, attribution build ~1.5 KB more, ~3 KB brotli ([README](https://github.com/GoogleChrome/web-vitals)) | Adds bytes to the page | **Don't ship it**. The debug telemetry already implements the definitions; use its source as the reference when checking ours |
| **tachometer** | Interleaved runs, ≥ 50 samples, 95% CI of the difference, auto-samples until resolved (`--auto-sample-conditions`, `--timeout`) ([README](https://github.com/google/tachometer)) | Its WebDriver runner, or copy the method | **Emulate the statistics** for release-vs-release timing (§5) |
| memlab | Scenario `url`/`action`/`back`, heap-snapshot diffing, retainer traces ([README](https://github.com/facebook/memlab)) | Puppeteer-based | Emulate the action/back loop in the harness; use memlab's analyzer on saved snapshots if needed |

## 5. Regression gating without arbitrary goals

The sources give no universal number for "minimal"; the thresholds in §3 are field 75th percentiles
for public sites. Gate on **change and reason**, not on targets:

1. **Per-page resource manifest** (new). For each lab page, a checked-in list of request
   *kinds*: pattern (the lab's `pattern`, ids → `:id`), method, phase (`document`, `boot`, `data`,
   `stream`, `idle`), max count, and a `reason` that names the feature. Example:

   ```json
   "diagram": [
     {"kind": "document", "pattern": "/p/:id/…", "count": 1, "reason": "the page"},
     {"kind": "worker", "pattern": "/-/page-assets/elk-layout-worker-*.js", "count": 1, "reason": "graph layout off the main thread"},
     {"kind": "data", "pattern": "GET api/projects/:id/diagrams/:id", "count": 1, "reason": "the view"},
     {"kind": "stream", "pattern": "GET api/events", "count": 1, "reason": "live updates"}
   ]
   ```

   The lab fails on any request not in the manifest, and on a count above it. A shrink is reported
   so the manifest can be tightened. This turns "2–3 resources per page" into a reviewed list
   rather than a number.
2. **Ratchets for deterministic quantities**: request count, distinct patterns, duplicates, bytes
   (raw/gzip/br per asset), DOM nodes, unused-bytes-on-load. A cap may only fall automatically. A
   rise needs a commit to the manifest or budget with the measurement, as `config.json`'s
   `$comment` already requires. `--write-budget`'s refuse-a-drop rule is the right guard against
   seeding from a broken run.
3. **Timings vs the previous release, not vs a cap**. Run the last release's page and the
   candidate **interleaved** on the same host, ≥ 5 runs each. Lighthouse: "the median … of 5
   runs is twice as stable as 1 run"; never run concurrently; use dedicated cores
   ([Lighthouse variability](https://github.com/GoogleChrome/lighthouse/blob/main/docs/variability.md)).
   Report the median difference with a 95% CI (tachometer's method), and flag only when the
   interval excludes a stated noise floor (e.g. `+10%`). The repo already notes timings run 2–4×
   seed under load on the shared host. That supports keeping `timingFailFactor: null` there and
   gating timing only on a quiet host.
4. **Prefer CPU-independent proxies** where possible: `LayoutCount`, `RecalcStyleCount`, React
   commit count per interaction, long-frame *count*. They barely move with host load (inference),
   so they can be gated tightly when absolute ms cannot.
5. **Scale curves**, not points: keep `scale-gates.mjs`'s S/M/L and judge per-element cost growth,
   as `performance-baselines.md` already does for layout.

## 6. Other dimensions for a periodic quality review (one tool each)

| Dimension | Tool |
|---|---|
| Accessibility | `@axe-core/playwright` `AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze()` per journey step ([README](https://github.com/dequelabs/axe-core-npm/blob/develop/packages/playwright/README.md)) |
| Visual regression | Playwright `toHaveScreenshot` (`threshold` 0.2 default, `maxDiffPixels`). Baselines are platform-specific, so generate them on one host ([Playwright](https://playwright.dev/docs/test-snapshots)) |
| Resilience / offline | `context.setOffline`, service restarts, and SSE reconnect counts (§3, WHATWG SSE) |
| Security headers / CSP | Already: `csp-violations` invariant. Add a header snapshot test per route |
| i18n / text expansion | Playwright `locale` plus pseudo-localised strings to find clipping (the `chrome-clipped` invariant catches it) |
| Energy / data | Bytes and main-thread ms as the proxy. W3C WSG draft: minify, compress, split only bandwidth-heavy parts ([W3C WSG draft](https://w3c.github.io/sustainableweb-wsg/)) |
| Dependency weight | rollup-plugin-visualizer `list` diff per release (§4) |

---

## Proposal

### Add to `tools/perf/page-load.mjs`

- `--coverage`: `page.coverage` JS+CSS on the cold load. Per page: used/unused bytes. With
  `--minify false` + sourcemaps, it also gives unused bytes by source bucket, reusing `release-check`'s
  sourcemap attribution. Report-only at first.
- `--manifest tools/perf/manifests.json`: the §5.1 check, over the existing request records
  (`pattern`, `initiators`). `--write-manifest` seeds kinds from a run with empty `reason`s, which a
  person must fill before it passes.
- Rows gain `longFrames` (count, total `blockingDuration`, top 3 script sources) and the
  `Performance.getMetrics` deltas the harness already reads (`LayoutCount`, `RecalcStyleCount`,
  `ScriptDuration`).
- `--compare <base-url>`: interleave base and candidate per run, ≥ 5 runs, median delta and 95%
  CI per timing. Output beside `summary.json`.
- `--http2`: label the run's protocol (`nextHopProtocol` from Resource Timing) so h1/h2 rows
  compare.
- Swap `Network.emulateNetworkConditions` for `emulateNetworkConditionsByRule` (global rule, empty
  `urlPattern`) behind a fallback.
- Favicon: assert there is no `/favicon.ico` request once the inline icon lands.

### Add to the harness (`tools/devkit/harness`)

- Per step: `event`-timing INP candidate and LoAF entries, as new invariants: `interaction-latency`
  (warn > 200 ms per INP's "good" line, fail only vs the last release) and `long-frame`.
- Per step: `LayoutCount`/`RecalcStyleCount` and React commit deltas (install `COMMIT_COUNTER_SCRIPT`),
  logged in the trace group. A `layout-thrash` warning when one step forces many layouts.
- `leak` journey mode: repeat a journey's action/back N=10 times. Read the heap after double GC and
  `Memory.getDOMCounters` each loop. Fail on monotonic growth across the last 5. Save
  `HeapProfiler.takeHeapSnapshot` and `DOM.getDetachedDomNodes` on failure.
- `sse-resilience` journey: open a view, restart the sandbox service, write a change, and assert
  one reconnect, the update arriving, and no duplicate fetch storm afterwards.
- `a11y` invariant: axe on each journey's final state (quarterly or full runs only).

### What a reusable `archer-performance` skill should tell an agent

Keep it under ~60 lines. It complements `archer-ui-verification` and owns only performance:

1. **Rule: every request on a page has a reason.** Before adding a fetch, worker, font, image or
   stream, add or extend the page's manifest entry with the feature that needs it. A manifest
   failure means "explain or remove", never "raise the cap".
2. **Measure before and after any change to `ui/`, page serving or data loading.** Run
   `page-load.mjs --pages <affected> --runs 5 --compare <main sandbox> --coverage`. Quote the
   deltas (requests, bytes br, unused bytes, LCP, long frames) in the PR's Measured table.
3. **Deterministic numbers gate; timings compare.** Counts and bytes may only fall without a
   written reason. Timings are judged only as an interleaved median delta with a CI on a quiet
   host. Never run two labs at once on one machine.
4. **Split only with evidence**: the four conditions in §1, shown by coverage. Do not add a
   chunk to save under ~10 KB compressed (the repo's own 313-byte lazy-chat result).
5. **Interaction work**: if a journey step shows a long frame, read its LoAF script attribution and
   `forcedStyleAndLayoutDuration` first. Fix with batching reads before writes or with
   `scheduler.yield()`, then re-measure.
6. **Leaks**: after touching subscriptions, SSE, canvases or editors, run the leak journey.
7. **Don't ship measurement code**: telemetry stays behind `__ARCHER_DEBUG__`, and
   `check-prod-strip` must stay green.
8. **When a number moves, fold the finding into this skill or the manifest in the same PR**
   (per the skill-maintenance rule).

### Open questions

- Fonts: keep embedded Inter (bytes on every cold load), subset it, or use system UI fonts?
- Should HTTP/2 become the TLS default after the h1/h2 lab comparison?
- Is a quiet, dedicated host available for timing comparisons, or are timings report-only for good?
