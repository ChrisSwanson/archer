# Changelog

## 0.15.2 — 2026-11-19

Dependency updates from the first week of Dependabot: each one tested, and the four that failed
fixed or held for a recorded reason.

### Changed

- **Reading the text of a note's comments ran on parse5 7**, which could take seconds on very deeply
  nested Markdown. The service now uses parse5 8.1.1, which fixes those quadratic cases. (#15)
- **The service and the page ran on older libraries.** The service now parses with Mermaid 12.3.0 (the
  speed-up patch applies unchanged), and both lay out with ELK 0.12.1. The page uses React Flow 12.12.1 and
  the MCP Apps SDK 2.0.4, whose client and core packages are now pinned too. The diagram layout worker
  is 34 KB larger (ELK) and the MCP App page 82 KB (20 KB gzipped; ELK and the MCP Apps SDK). (#12, #13)
- **On a touchscreen, a one-finger drag in Select mode drew a marquee rectangle and panned at the same
  time, and selected nothing.** With React Flow 12.12.1 it now just pans. A tap still selects a node; a
  marquee by touch did not work before and does not now.
- **Contributors built and tested with TypeScript 5.9, jsdom 25 and Playwright 1.63.** They now use TypeScript
  6.0.3, jsdom 26.1.0 and Playwright 1.65.1. TypeScript 7 and jsdom 27+ are held in Dependabot, with the
  reasons in `docs/known-failures.md` (O276, O278). (#14, #16)
- **The Mermaid guide named 12.2.0 as the version Archer checks against.** It names 12.3.0.

### Fixed

- **Two UI tests could fail on a busy machine**: one looked for a new comment pin a render too early, the
  other cleared its record of selection posts while the click's own was still pending. Both now wait for
  what they assert on. (O280, O281)

### Removed

- **The diagram canvas accepted an `onSelectionChange` handler that the page never used**, and React
  Flow 12.12.1 stopped calling it on clicks. The handler is removed. Selection still comes from clicks
  and the marquee, as before. The drawing kept under a read-error banner still takes no clicks, as
  designed. (O275)

## 0.15.1 — 2026-11-18

Clearer errors for the Mermaid agents usually write, CLI and tool messages that say what to do next, a guide
for agents other than Claude Code and Codex, and fixes for two tests that failed on busy machines.

### Added

- **Agents other than Claude Code and Codex had no instructions.** A new guide on the documentation site, "Use Archer
  with another agent", gives the two steps (register `archer mcp`, write the skill with `archer skill
  --write`) and a listen loop for harnesses with no background tasks (also in `archer docs cli`). `archer setup` and
  `archer doctor` print the two steps when they find neither agent.
- **Dependabot watched only the workflow actions.** It now proposes npm updates too: minor and patch
  updates in one weekly pull request, majors one at a time, a release only once it is a week old.

### Changed

- **Moving from the docs site's landing page into the docs changed the top bar**: blue on the landing, plain on
  the docs, with search and the links in other places. Every page now has the same blue bar, with everything
  in the same place, in both themes. The search button is named by what it shows, for voice control.
- **Agents drew every box the same grey.** The skill and the authoring guide now say to give each node a
  kind or a keyed category, and which colours mean what.
- **The automatic edge-id fix left a chain (`a --> b --> c`) as a chain**, which still failed. The fix,
  and the hint on each of its errors, now split it into one edge per line, each with its id.
- **Opening Project Review with the chat open put the review underneath it.** Opening the review now
  closes the floating chat, as opening the chat already closed the review.
- **On a phone, the drawing's left edge sat under the toolbar** when the diagram was wider than the screen.
  The fit now keeps it clear.
- **`archer` with no arguments, and `archer setup --help`, were usage errors.** They print the usage and
  exit 0. `archer tools` and `archer call` now refuse an unknown tool with the same words and exit code.
- **`archer projects` printed a raw dump after its list**, with a second link that disagreed with the first.

### Fixed

- **`archer validate` printed warnings like errors**, multi-line hints on one line, and "21 errors" for 39.
  Each line now says `error` or `warning`, hints keep their lines, and past 20 it says "20 errors shown,
  more remain". `--json` carries the whole fixed source as `fix`, as `validate_diagram` does.
- **Plain-Mermaid mistakes got a raw parser error at line 1.** `end` as an id, a label starting with `/`,
  an empty label, a header from another diagram type, `option` in a sequence, `a--b`, a state named only
  with `state B`, a fork used before it is declared, an entity relationship with no label and a key with no
  type now each get a named refusal, at their own line, saying how to fix it. A diagram inside a note is
  counted in the note's lines.
- **An unsupported diagram type was reported as `expected_flowchart`.** It is `unsupported_diagram_type`,
  naming the header (`classDiagram`, `gantt`, `C4Code` and others).
- **`write_walkthrough` refused unknown arguments without naming `walkthrough`**, the one that holds the
  steps. It is listed now.
- **A stale revision was described backwards** ("changed since you read it") when the caller's number was
  too high. The refusal now says which number was sent and which the thread is at.
- **Tool results in plain text left out what the agent needed next.** Comment results state the thread's
  revision; listing results say how to get the full listing.
- **`present_diagram` called a diagram that never compiled "not found".** It is `diagram_not_compiled`.
- **A wide export was refused without saying how to fit it.** The refusal names the limits (16,000 px a
  side, 32 million pixels) and a `scale` that fits. A diagram-mode export says that highlights are drawn
  in presentation mode.
- **`archer draw --model` refused what `archer compile` writes.** It accepts it, and `draw`'s help says
  which diagram types it draws.
- **A bare name for a diagram inside a note was "not found".** The refusal suggests the full address.
- **One symlink in the notes folder changed the error for every missing note.** A missing note is "not
  found" again.
- **Two diagrams with the same `%% archer-id` in one note were renamed silently.** The write warns.
- **The first layout measurement on a busy machine was refused as over budget** for a diagram that lays out
  in milliseconds: starting the layout worker counted against the layout. The budget now starts when the
  worker is ready; the caller's deadline still covers the whole wait.
- **Messages and docs disagreed with the rules:** edge labels are 2 lines of 24 characters, an id starts
  with a letter or digit, `archer doctor` starts the service, `archer init` updates `CLAUDE.md` only when
  there is one, and plain HTTP works on this computer with no setup. The repository's old Mermaid profile,
  which taught the previous edge-id form, now points at the shipped guide. The package no longer calls
  itself a private build.

### Measured

| Change | Model | Effort | Runner | Runs | Measure (per run) | Before | After |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Colour guidance in the skill and authoring guide | gpt-6.1-sol | medium | `codex exec`, skill and authoring guide as context, a three-diagram task | 2 before, 3 after | flowchart nodes with a kind or category | 0/23 | 29/33 |

## 0.15.0 — 2026-11-11

The first public release: compatibility with never-published builds is retired, the code is formatted and
linted, the service and page are restructured where bugs kept recurring, and security review findings are
fixed. Read **Before you upgrade** if you ran 0.14 or earlier.

### Before you upgrade (machines that ran Archer 0.14 or earlier)

- **A development install** (from `ts/scripts/install-local.sh`): run `archer uninstall --legacy` with 0.14
  first, or remove `~/.local/share/archer-ts`, `~/.local/bin/archer-ts`, the `archer-ts@archer-local` plugin
  and `archer-local` marketplace, Codex `[mcp_servers.archer-ts]` and a skill link into archer-ts.
- **The `archer-ts@archer` Claude plugin**: `claude plugin uninstall archer-ts@archer && claude plugin
  marketplace remove archer`, then `archer setup --mcp`. Re-grant permission rules as `mcp__archer__*`.
- **Agent sessions started before 0.7**: restart them.
- **Diagrams in the Archer 0.3 dialect**: convert them with 0.14's `archer migrate --write`; 0.15 has no
  `archer migrate`.
- **Bookmarks** of `…/<token>/…`, `…/p/<name>/…` or a hash-slug name (`/projects/<name>-1a2b3c4d/`) no longer
  open: open a fresh link from the agent (`get_ui_url`) and bookmark the `/projects/<name>/…` address.
  `?search=` links open without the search (the page writes `?q=`).
- **Browser cookies** from before browser sessions: sign in again with the agent's link.
- **Files from before 0.5 / ADR 0030** are refused, each on its own: note-emphasis sidecars with amber, more
  than three groups or text over the legend bounds; version-1 `*.comments.json`; walkthrough steps without
  ids; early-0.7 `listeners.json`. Any write with 0.14 upgrades them first. A project whose saved service
  state holds such an emphasis fails to restore (`invalid_saved_state`): delete its
  `~/.local/state/archer/runtime/<key>.json`. Leftover in-repo `.<file>.writers/` directories can be deleted.
- **Scripts calling the HTTP API**: sign in through `?token=` and use the cookie, or use an access grant as
  Bearer; comment writes are operation envelopes (create, reply and submit).

### Added

- **Formatting and linting** (Biome): `npm run format`, a `format and lint` gate in pr-check and CI, and a
  pre-commit hook (`npm run hooks:install`).
- **Shift+F10 opens an element's menu on a Mac**, as the help overlay promised; Chromium and Safari there
  send no context-menu event for it.

### Changed

- **Selecting through a diagram sent one request per keypress, racing each other.** The page now publishes
  the selection as live state: a change after a pause goes at once, a burst coalesces to one request per
  150 ms ending on the last, a change of diagram or revision goes at once, and requests go in order. The
  service keeps it current at once and saves it within 250 ms instead of syncing to disk on every change
  (50 changes: 50 disk syncs before, at most 2 after); a hard crash can lose the last quarter-second of
  selection. Presenting and emphasis are still saved before they are answered.
- **One link form and one address scheme.** The agent's link is `/projects/?token=…`; path-token pages, `/p/`
  page addresses, hash-slug names and the `?search=` spelling are retired (ADRs 0014, 0015, 0017 amended).
- **The page no longer polls an open diagram every second**; a new revision arrives as an event.
- **Compatibility with builds before 0.15 is retired** (ADR 0015 amended: the support window starts at this
  release): the page's legacy mode, capability fallbacks, plain comment posts, pre-0.15 storage readers,
  `archer migrate`, the development-install switch-over and the relay-shell plugin.
- **The service and page are restructured where bugs kept recurring**, with no change to what they answer:
  every API route is one declared table (a 56,650-request route matrix is identical before and after);
  `ProjectState`'s reads, publications and saves are their own modules; `startService` is composed of a
  management handler, page serving, background artifact jobs and lazily opened stores; the page's six request
  caches are one store (request counts unchanged in every pinned case). Tests run against the real service:
  the hand-maintained fake server, whose drift caused past test failures, is gone.

### Fixed

- **A present refused because its state could not be saved still moved the exploration counters**, so the
  agent lost the reader's exploration. They roll back with the rest. (O285)
- **Two Archer processes in different time zones disagreed about whether a lock's owner was alive** (macOS),
  so a second service could take over a running one's lock. Start times are read in UTC. (O282)
- **A tab that stopped reading its event stream grew the service's memory without bound.** A stream more than
  4 MB behind is closed; the page reconnects. (O283)
- **Requests sent on a connection whose upload was refused still ran** during its 2 s drain. They are dropped.
  (O283)
- **macOS: changes could be missed after the set of watched folders changed**; the rescan now runs within 1 s
  and at most once a second under constant churn. (O284)
- **A failed state-file write could report the cleanup's error instead of its own.**
- **The project tabs moved as their counts arrived** with macOS's system font.
- **On a Mac, the editor's selection panel could cover the Source toggle** when the Source drawer was open: it
  now stops above the toggle and scrolls. (O287)
- **A catalog read stuck on a stalled response kept every other reader of it waiting**; it now ends for all
  when its deadline passes.
- **The dev sandbox could not start on macOS** (socket path too long).
- Three elements had accessibility attributes their role does not allow.

### Measured

| Change | Runner | Runs | Measure | Before (0.14.3) | After |
|---|---|---|---|---|---|
| Selection while arrowing through 50 boxes | jsdom (selection-sender) | 1 | POSTs to api/selection | 50 | ≤ 8 |
| Selection saved | service test (fsync spy) | 1 | disk syncs per 50 selection changes | 50 | ≤ 2 |
| A 16 MiB relay line in macOS's 8 KiB reads | macOS, node | 1 | event-loop time | ~15 s | 0.2 s |
| Leak journey (production page, 20 loops) | macOS | 2 | main heap slope, MB/loop (95% CI) | 0.099–0.101 (Linux) | 0.102–0.104 (0.079–0.126); PASS |
| Scale M, attach and diagram | macOS | 3 | worst event-loop stall | 263–391 ms (O12) | 170–173 ms |

Page size grew by about 0.8 KB gzip (the read store). release-check on macOS: every budget passes except one
705 ms event-loop stall seen once in scale-M after the journeys and monkeys (not reproduced in three isolated
runs); it is not allow-listed.

### Security

- **The public release workflow** builds in a read-only job; only a separate publish job, which installs and
  checks out nothing, can write. Every action is pinned to a commit; Dependabot proposes updates.
- **Cookies holding a raw service token or link secret** (before browser sessions) are refused.

## 0.14.3 — 2026-11-11

Archer on macOS: the test suites pass there, and the problems only macOS showed are fixed.

### Fixed

- **On macOS a change could fail to reach the page when one service watched several projects.**
  macOS serves all of a process's folder watchers from one stream and remakes it whenever a folder
  is added or removed, losing what changes meanwhile (6–13 of 60 writes in a measurement). Every
  project now rescans once, a quarter second after the watched folders change. (O276)
- **An upload over a size limit could end in a broken connection instead of "too large".** The
  service now answers, lets the rest of the upload drain for up to 2 s, then closes; on macOS 20 of
  20 oversized uploads get the answer, against 4 of 20 before. (O277)
- **On macOS an old service lock whose process number was reused blocked every start**, and a
  comment lock could be taken from a running writer when two Archer processes used different
  languages. Process start times are read without `/proc`, in one locale. (O278)
- **On macOS a `readme.md` counted as the project's `README.md`.** Only the exact name is
  admitted, as the discovery docs say. (O279)
- **`archer uninstall --legacy` on macOS refused without saying what still used the install.** It
  now names the shim, Codex entry and skill links first. (O279)
- **A long message to the service stalled it.** Each piece of a message that arrived made the
  service re-read everything received so far; a 16 MB agent message took about 15 s on macOS, which
  reads sockets in small pieces, and nothing else ran meanwhile. It now takes a fifth of a second.
  (O280)
- **`npm run pr-check` failed on macOS** with "mapfile: command not found": macOS ships bash 3.2.
  (O281)
- **The unit suites failed on macOS** on assumptions about Linux (`/proc`, `/usr/bin/cp`, a short
  temporary folder without links). They pass there now, as the public CI's macOS job runs them.
  (O275)

## 0.14.2 — 2026-11-10

Faster checks: pr-check takes 16 min instead of 24, CI's heavy jobs no longer queue behind each
other, and tests that covered nothing the product runs are gone.

### Changed

- **A PR's CI run spent about a quarter of its time queued.** Five test jobs competed for three
  runners, so the second browser shard waited a median 9.2 min before it started (87 runs, 232–368).
  A 1.5 min `quick` job (typechecks, build, contract tests) now fails fast and gates exactly three
  heavy jobs, one per runner: `unit` (ui, ts, then the ts service browser tests) and the two browser
  shards. The two cache steps, which never hit across PRs, are gone.
- **Every browser job installed the same system libraries.** The CI image now has Chromium's
  libraries and the DejaVu fonts baked in. Its build fails if the image's Playwright version differs
  from the lockfile.
- **The serial `xss-mcp-host` file finished the browser suite alone**, on one worker for about 3 min.
  It now runs first, in its own project, and changed e2e files run next. The browser suite takes
  12m32s instead of 15m00s.
- **pr-check ran each step in turn.** The two typechecks run side by side, and so do the ui and ts unit
  suites (`ARCHER_PR_CHECK_UNIT_WORKERS`, default 6). Each step keeps its own log and fails the gate
  by name. pr-check passed in 16m03s instead of 23m39s, with the same test counts.

### Removed

- **25 tests and helpers that nothing in the product reaches**, or that repeat a longer test. Three
  audits traced each test to the production code it exercises. A Codex adversarial review then
  approved 25 cuts, rejected 48, and returned 56 as reworks for later slices
  (`docs/wayfinder/test-and-ci/`).
- **`reconcileReviewArtifacts`**, which no production path ever called, together with its tests
  (owner decision; ADR 0027 amended 2026-11-10). A review artifact is rewritten by the next
  materialisation of its review.

### Fixed

- A CI script check failed with no output in any shell without a UTF-8 locale, because a `sed`
  pattern matched only the last byte of `─` (O274).

## 0.14.1 — 2026-11-10

Archer works on macOS: the project catalog, the change store, review artifacts and launch no longer
need Linux's `/proc`.

### Fixed

- **On a Mac the project page would list no diagrams or notes.** The catalog walk, the change
  store, review artifacts and the launcher open files through `ConfinedFileSystem`, which refused to
  start without a verified descriptor filesystem. macOS's `/dev/fd` cannot open through a directory
  descriptor, so discovery stopped with an empty catalog, and reads through it failed with
  `confinement_unavailable`. The class now runs on the path anchor that file reads and writes
  already used there: every segment is checked by `lstat` before and after each open, links are
  refused, and the descriptor must be the file the walk found (ADR 0018, amended 2026-11-10;
  `docs/security/known-limits.md` §1). Linux with `/proc` is unchanged (O272).
- A security review of that change found writers that went further than that limit on such hosts. The
  change store and review artifacts could fill a temporary in a folder swapped once, outside the
  project. A failed publication's cleanup could delete a same-named file there. A scan could read a
  swapped-in folder whole. Each create now checks the folder before the open and again before
  writing, cleanup removes only what the bound folder holds, and scans check as they read. A folder
  whose descriptor probe failed after the platform probe could also write a nested file at the
  project root, on Linux too; it now uses the path anchor (O273).
- A browser test read a dimmed relationship's label before it was drawn (O271).

### Added

- `ARCHER_TEST_PATH_ANCHORS=1` runs the ts suite on the macOS confinement, so a Linux machine can
  test it. All 7,036 tests pass that way, as in a plain run. The public CI gains a macOS job
  (`macos-15`: page build, bundle, ui and ts unit tests).

## 0.14.0 — 2026-11-07

Ready to open source: the repository builds a public copy of itself, with its own CI, release
workflow and contributor guides, and with no personal or environment-specific details in the
files that ship.

### Added

- **There was no public way to build, test or release Archer.** `scripts/oss-export.sh` builds the
  public tree from a commit: the files that ship, the public variants of the entry docs, and one
  fresh commit. It then fails on any personal or environment detail (`scripts/oss-scrub-check.mjs`)
  and on any link into a file that does not ship. GitHub Actions run the unit gates, a reported
  `npm audit` and both browser suites in two shards on every pull request and push to main; a
  `v*` tag builds the package, checks it and publishes a GitHub Release with the `.tgz`,
  `SHA256SUMS` and this changelog's section.
- Security and conduct reports go through GitHub private vulnerability reporting
  (`SECURITY.md`, `CODE_OF_CONDUCT.md`). The install guide downloads from GitHub Releases, or
  builds from a clone.
- Contributor guides for the public repository: `AGENTS.md`, `CLAUDE.md`, the pull-request flow
  skill and `docs/known-failures.md` (new ids from O271).

### Changed

- **Docs and comments named the machine, services and projects Archer was developed on.** Paths,
  addresses, host load figures, private tracker numbers, project names and personal attributions
  are gone from what ships; decisions read "(decided DATE)". Internal work logs, review records
  and planning notes stay out of the public tree.
- The perf lab's second network profile is `remote-link`. The sandbox and eval runner keep port
  40399 free unless `ARCHER_RESERVED_PORTS` lists others. The R7 artifact-chain check reads its
  forge from `ARCHER_FORGE_URL`, `ARCHER_FORGE_REPO`, `ARCHER_FORGE_USER` and `ARCHER_FORGE_CA`.
- The Rust implementation's tool-call limits are stated in `docs/supported-mermaid.md`.

### Fixed

- The export shipped its overlay twice (once in place, once under `scripts/oss-export.overlay/`).
- A project note was over its 4,000-character cap, and the docs index was stale (O262).
- Four browser tests failed under `pr-check --stress`: three raced the page (a wait started before the page opened, a right-click aimed at a layout that was still growing, a launcher used while the drawing loaded) and one ran out of time (O263–O266; the launcher swap itself is O266, open).
- Three more under load: a page left unsynced by a test's missing routes, a test that rebuilt the project model twice per view, and an embedded page given 10 s to start (O267–O269).
- `pr-check` stops before running when TMPDIR has too little free space (`ARCHER_MIN_TMP_GB`, 6 GB): a full `/tmp` failed four browser tests at random (O270, as O261).

## 0.13.0 — 2026-11-07

Rename suggestions: checking a diagram now names the ids it spells differently from the rest of
the project (`shopApi` where every other diagram says `api`), with the rename to make. An agent
tidying that diagram makes them as part of the change; renames anywhere else wait for your yes.

### Added

- **An agent tidying a diagram was never told which ids other diagrams already spell differently.**
  Advice flags only ids a draft introduces, so a diagram that called the Shop API `shopApi` while
  every other one called it `api` kept its drifted ids. Checking an existing diagram
  (`validate_diagram`, `archer validate <view>`) now lists up to 5 of them as rename suggestions,
  apart from the advice, and says when there are more; `suggest: true` (`--suggest`) lists them all,
  `suggest: false` (`--no-suggest`) none. Each gives the id, the id it probably should be, the
  matching names, a similarity score, the views involved and the rename to make, or "ambiguous"
  when two ids fit. A rename only in the diagram you asked
  the agent to change is part of that change (`withinView`); renames in other diagrams wait for
  your yes. The suggestions taken together always make a rename plan that dry-runs clean: an id
  already used in a view, two ids of one view competing for one survivor, or an id drawn as both a
  table and a person is listed for you to decide, with the reason, never as a rename. A project
  of hundreds of look-alikes answers in well under a second (800 in 67 ms, from 11 s): past its
  budget the list says it is incomplete. Asked of a diagram that does not compile, the answer is
  an empty list with `suggestionsUnavailable`. New diagrams are checked as before.

### Fixed

- **A rename plan refused every rename in a flowchart drawn as a C4 view.** The plan compared the
  view's model with the renamed text compiled as a plain flowchart and saw a change of type, so
  `shop → pageturner` in the demo's system context was "cannot be renamed by text".
- Found in review before release and fixed: R13-01 to R13-06 (Codex). Test and harness: O260; the
  normalisation report names its two sides (`--before`, `--after`, `--about`).

### Measured

| Change | Model | Effort | Runner | Runs | Measure (per run) | Before | After |
|---|---|---|---|---|---|---|---|
| Rename suggestions, shown by default on an existing diagram | claude-sonnet-5-5 | medium | Claude Code CLI, `ts/scripts/evals/v1` `--sealed`, 6 tasks × 8 | 8 + 8 (T6) | drifted ids renamed | 0/8 | 2/8, p = 0.23 |
| | | | | 48 + 48 | renames taken from a suggestion that were wrong, or outside the diagram asked about | — | 0 of 6 runs |
| | | | | 32 + 32 | every seeded element kept by its id | 28/32 (88%) | 32/32 (100%), p = 0.057 |
| | | | | 48 + 48 | runs passing every must | 35/48 (73%) | 38/48 (79%), p = 0.32 |
| | | | | 48 + 48 | runs passing every check | 29/48 (60%) | 31/48 (65%), p = 0.42 |
| | | | | 43 + 45 | C4 views not mixing levels | 42/45 (93%) | 37/43 (86%), p = 0.93 |
| | | | | 48 + 48 | cost per run, median | $0.190, 37.6 s | $0.193, 35.6 s |

Before is 0.12.0's round-2 arm, after is this release (round 3 of 3); Fisher exact p, one-sided for
the improvement. Write-up and records: `docs/evaluations/normalisation-suggest-2026-11-06.md`,
`docs/evaluations/baseline/normalisation.json`. Not met: T6 still fails every run. The two that
renamed all three ids kept one view mixing levels, and from round 2 on T6 kept one view in 12 of
16 runs against 4 of 16 before (p = 0.012), plausibly anchored by "the diagram you were asked to
change"; to measure in the next round.

## 0.12.0 — 2026-11-04

Expand: grow a diagram from any box into the diagrams related to it, on one canvas you and the
agent share. Archer now keeps one model of the whole project, so agents can find what is already
drawn before drawing it again, and are told when a diagram strays from it. The open-source export
of the tree is ready to review.

### Added

- **A box's menu: Comment or Expand.** Right-click a box, press the context-menu key or Shift+F10,
  or long-press on a touch screen. Expand lists what is inside the box, the diagrams that draw or
  open it, and its neighbours this diagram leaves out. Pointing at an entry shows it faintly in a
  frame beside the box; choosing it adds only the part that touches the box, with "open the full
  diagram" a click away. Up to 5 diagrams and about 60 boxes; × removes one. Comments on a frame's
  parts go to the diagram they came from. Readers can expand too.
- **The agent can present an exploration.** `present_diagram` takes `expand: [{ element, source }]`
  and draws the same grown canvas; a bad entry refuses the whole call and names every reason.
  `get_presentation_context` reports what is added, whether the agent or you added it last, and
  which frame parts are selected. The exploration survives a service restart and follows a source
  that changes.
- **Links to an exploration.** "Copy link" in Added to This View, and the agent's link, reopen the
  same picture (`?expand=`), down to the one neighbour you added. A link holds up to 24 additions:
  the menu says when the next one would not fit, Copy link says whether it copied the additions or
  only the view, and an agent's exploration too large to share returns the view's own link and
  says why. An older page shows the base diagram with a line saying parts were added.
- **`find_elements`**: one read-only lookup over every diagram in the project, by name, id, kind,
  parent or diagram (a short query such as `Go` matches technology too), so an agent reuses an id
  instead of inventing a second one. The skill tells agents to look before they draw.
- **Advice when a diagram is checked or written.** `validate_diagram` and `write_diagram` list
  advisory findings (too many boxes for the level, a box that looks like one drawn elsewhere under
  another id, a view that mixes levels) with how to fix each; `validate_diagram` with `project: true`
  reports the whole project. A draft's advice is computed on the project as it will be once the
  draft is written. Advice never refuses a write.
- **`archer call … --source <file.mmd>`** takes a diagram's Mermaid from a file, so an agent does not
  have to fit multi-line source into one line of JSON.

### Changed

- **`archer validate` and `archer present` printed "ok" and hid the warnings and advice the tools
  give.** They print the label warnings and the advice; `--json` carries them as `lint`.
- A `status: proposal` diagram reads as proposed and adds nothing to the project's model.
- Archer's own `.archer/` diagrams follow the rename plan: one id per thing across its views.
- The tool descriptions changed, so **agent sessions restart once** after the upgrade.
- The open-source export (`scripts/oss-export.sh`, not shipped) checks every exported link resolves,
  rewrites private names, and ships a public summary of the performance evidence.

### Fixed

- **One comment made the page read the comments twice.** A page's write and its publish now tell the
  page once. (O250)
- Test and harness: O251–O253. Found in review before release and fixed: O254–O259.

### Measured

| Change | Model | Effort | Runner | Runs | Measure (per run) | Before | After |
|---|---|---|---|---|---|---|---|
| Expand: project model ids, `find_elements`, advisory lint, CLI shows lint, `--source` | claude-sonnet-5-5 | medium | Claude Code CLI, `ts/scripts/evals/v1` `--sealed`, 6 tasks × 8 | 48 + 48 | seeded ids not reused for something else | 32/37 (87%) | 40/40 (100%), p = 0.022 |
| | | | | 48 + 48 | runs passing every check | 20/48 (42%) | 29/48 (60%), p = 0.051 |
| | | | | 48 + 48 | runs passing every must | 31/48 (65%) | 35/48 (73%), p = 0.25 |
| | | | | 45 + 48 | runs leaving no lint findings | 34/45 (76%) | 43/48 (90%), p = 0.064 |
| | | | | 5 + 8 (T6) | lint findings left after a refactor, median | 22 | 1 |
| | | | | 48 + 48 | cost per run, median | $0.170, 32.8 s | $0.190, 37.6 s |

Before is the released 0.11.0 package, after is this release; Fisher exact p, one-sided for the
improvement. Write-up and records: `docs/evaluations/normalisation-expand-2026-11-04.md`,
`docs/evaluations/baseline/normalisation.json` (round 2 of 2). Not met: renaming ids that already
drifted (T6) fails on both sides, since the advice cannot see an id already in the source.

## 0.11.0 — 2026-11-04

The fourth v1 quality round (performance): eleven pages opened cold and warm on two networks,
measured against 0.10.0 in the same run, and checked by two independent reviewers against a frozen
rubric through four reviews until it passed. Pages make about 40% fewer requests, read only what the view
on screen needs, stop holding on to every page you visited, and hold still while they open.

### Changed

- **Pages read data for views they were not showing.** Each per-view read (emphasis, threads, notes,
  walkthroughs) is now for the view on screen. The bell counts agent answers without reading every
  thread, and reads them when you reach for it. A note's threads are read only where the activity
  says it has some. The eleven measured pages make 180 requests on a cold load, against 299 in
  0.10.0, and none reads a view the page does not show.
- **Every project page fetched the first 12 diagram thumbnails (about 160 KB)**, though only the
  Diagrams tab shows them. They are fetched once you point at or focus that tab.
- **The diagram layout worker (about 350 KB) loaded on pages that never draw a graph.** It starts on
  the first graph that needs it: sequence diagrams, their editor, the empty new diagram and the
  lists never fetch it, and a graph hidden behind the editor is not laid out.
- **Pages jumped while they opened.** The stage, file rows, header, frame, note text and project
  tabs keep their place from the first frame: tab counts show "…" in a fixed-width box until they
  are known, and the editor's tool cluster and the header's presence line hold their final size.
  The worst layout shift score (CLS) on opening a page fell from 0.445 to 0.004. (O176, O209,
  O220, O223)
- **The page is smaller.** The export painter's glyphs no longer pull React's server renderer into
  the page, the settings dialogs' styles load when a dialog first opens, and a new diagram shows its
  starter without asking the service. The page download is 946,488 B brotli, against 962,043.
  (O194, O195)
- Opening a page no longer publishes a selection to the agent; only a selection or a view change you
  make does.
- With `ARCHER_DEBUG=1`, every project read, the page and its assets, search, emphasis and
  walkthroughs name their phases in `Server-Timing`. Each page sets an `archer:route-ready`
  performance mark when what it shows is ready. (O196, O225)

### Fixed

- **Memory grew with every page visited.** Navigation kept each page it left (old renders, focus
  waits, media lists, the in-place editor's callbacks). After 20 navigation loops 0.10.0 held 184
  kinds of object and about 1,000 more page elements a loop; 0.11.0 keeps none of them. (O185)
- A note said it was ready before its figures were drawn. (O193)
- Source moved under the pointer when the drawing arrived, so a click could open the tools launcher
  instead. (O186)
- **Text typed while a Send, Save, Add comment or highlight Save waited for its answer was lost**
  when the answer came. It stays in the box, and the box says what was saved. Name, Save as and a
  visibility choice wait with the Save that carries them. (O189, O207, O208)
- An unsent reply or edit had two copies, one in Project Review and one on the diagram, and the
  older could overwrite the newer; Use it here could copy an older draft over newer text; Discard on
  the kept-edit notice left the copy in the hidden editor. (O188, O190, O191)
- An edit's or reply's late answer removed the warning about a later change, or hid an agent reply
  the page had already shown. (O208, O210)
- A kept reply did not reopen after Back past Projects and Forward in one tab, and Forward to a
  diagram while the project's listing loaded opened the project page. (O179, O192)
- Leaving a view while its emphasis loaded logged an error. (O211)
- The Export, compare menu, opened while a diagram was still loading, closed when the drawing arrived. It stays open, with focus where it was. (O242)
- At a 200% text size the header's tools row stayed 40 px tall, so the header did not grow with the text. (O240)
- Test and harness: O73–O75, O183, O184, O187, O197–O205, O212–O219, O221, O222, O224,
  O226–O234, O241, O243.

### Measured

Performance round 1, rubric `docs/quality/rubrics/performance.md` v2.1 with its amendments
v2.2–v2.5, on the devkit corpus: 11 pages × cold, warm × default and remote-link networks × 3 runs,
against 0.10.0 built and measured in the same run. Reviewers: `claude-opus-5-5` and `gpt-6.1-sol`,
independently: a review, a cross-critique and three re-scores. Verdict: PASS WITH APPROVED
EXCEPTIONS. The one exception, PERF-EX-1, is the layout worker's unused bytes on the flow diagram
over remote-link (up to 935,465 B): 0.11.0 skips a warm-up layout 0.10.0 runs, so less of the same
file executes; it is reviewed again at 0.12.0. Timing against 0.10.0 was measured but not scored,
because the measuring host was shared.

| Measure | 0.10.0 | 0.11.0 |
|---|---|---|
| Requests, 11 pages, cold, default network | 299 | 180 |
| Duplicate or failed requests | 0 | 0 |
| Retained after 20 navigation loops | 184 kinds of object, +989 elements a loop | none |
| Worst layout shift score (CLS) on opening a page | 0.445 | 0.004 |
| Page download, brotli | 962,043 B | 946,488 B |

## 0.10.0 — 2026-11-03

The third v1 quality round (user flows): twenty-one journeys a person takes through Archer, scripted
and checked by hand by two independent reviewers against a frozen rubric, and fixed until neither found
a blocker. Typed work now survives reloads, closed tabs, lost answers and going offline, and every
message, comment and save takes effect once.

### Changed

- **Unsent comments, replies, comment edits and chat messages were lost on reload.** They are kept in
  this browser like editor drafts: across reload, closing the tab, Escape and leaving the diagram,
  restored only to their own place, and removed only by sending or Discard. Two tabs keep their own
  drafts; one says when the other is writing.
- **A save made offline is kept in this browser and sent once when the connection returns**, checked
  against the revision it was edited from; a changed file gives the conflict notice, never an
  overwrite. A closed tab's held save is offered in the next tab that edits the diagram, named as a
  save, and sent only on Resume. If the file was deleted or renamed meanwhile, the editor shows your
  Mermaid with Copy, Save as a new diagram, Save as a proposal and Discard.
- **Other unsaved copies of a diagram are listed** ("N other unsaved copies"), each saying what it
  changes; Discard asks first. A copy that was sent, cleared, or whose text the file already holds
  (also after an outside write) leaves the list in every open tab; the next copy that still differs
  is offered in its place.
- **The link the agent hands over opens that diagram**, with what it showed, even after the agent moves
  on; following the agent is a separate link (`followUrl`). Agent sessions restart once on upgrade
  (the tool descriptions changed, ADR 0032).
- **Pairing returns you to the page you were refused on**, checked so it never leaves the instance or
  the project.
- The page says it is offline as soon as the browser does, and within 45 s of a silent stall or at the
  first failed read or write. Opening the editor while offline says so, offers Try again, and opens by
  itself when Archer answers.
- After Save the editor says "Saved · time"; anyone else's change says "Changed on disk".
- The overview opens a project in place; Back and Forward restore each view without a reload.
- An agent's emphasis inside a closed group opens it once; a walkthrough step links its note; a search
  match opens at its passage; empty-search recovery clears the search, not the project.
- `get_comments` names the diagram revision each thread was written on.
- Comment files that carry receipts are version 5; 0.9.x reads them as malformed (no downgrade).

### Fixed

- **A comment, reply, chat message or queued Send whose answer was lost could be stored twice, or
  shown as failed after it went through.** Every write carries an operation id kept in the browser and
  a receipt on disk (ADR 0016), so a resend or a reload takes effect once and says what happened. A
  resolve, delete or dismiss whose answer was lost says it is not known yet and settles on the next
  listing. (O67, O69, O83, O100, O102, O160)
- "Save as a proposal privately" from the conflict notice always failed. (O84)
- A deleted diagram still opened as current with Edit. (O110)
- Projects kept their order across a service restart. (O97)
- A success notice was drawn as an error, the conflict banner was announced twice, and a compile
  notice outlived its source. (O155–O157)
- `archer restart` could reach the old service while it finished an agent's call, and report its old
  version or fail with "the Archer service closed the connection". It now waits for the old service to
  let go. (O181)
- A figure just below the visible part of a note started drawing only once scrolled into sight, and one
  passed in a quick scroll could stay undrawn until scrolled back. (O182)
- Phones: walkthrough steps frame the current step, and the canvas toolbar is one row.
- Test and harness: O70–O72, O76–O82, O89–O91, O96, O98, O99, O101, O103, O104, O111–O113, O123,
  O126, O137, O138, O150–O153, O158, O164, O165, O167, O169–O178.

### Measured

User-flows round 1, rubric `docs/quality/rubrics/user-flows.md` v1.1 (rulings dated
2026-11-02), on the devkit corpus. Reviewers: `claude-opus-5-5` and `gpt-6.1-sol`, independently: a
review, a cross-critique, five re-scores and a confirmation. Verdict: PASS from both, no exceptions.

| Measure | round 1 | final |
|---|---|---|
| Journey cells passing 3/3 on their pins | 25 of 25 | 30 of 30 |
| Lost work or duplicate effects | 1 class | 0 over 540 checks |
| Unrequested reloads | not measured | 0 over 645 loads |
| Unseeded errors | not measured | 0 over 90 runs |
| Offline notice after a silent stall | 44.4–44.7 s | 43.9–44.2 s (≤ 45 s) |
| Seeded-fault proofs | 16 | 51 + 23 collector proofs |
| Open S1 / S2 findings | 3 (S1 1, S2 2) | 0 |

## 0.9.0 — 2026-11-01

The second v1 quality round (security): the service, the page, the agent surfaces and the release chain
reviewed by two independent reviewers against a frozen rubric and fixed until neither found a blocker;
and a person's message now reaches an agent in a set order, launching one when none is listening.

### Changed

- **A person's message waited until someone pressed Launch.** It now goes to a listening agent, else
  waits `next_turn_wait` (2 minutes) for a live session's next turn, else starts the configured launcher.
  With a launcher set, `launch` defaults to `"auto"`; set `launch = "ask"` or `"off"` to keep the old
  behaviour. Only the owner's messages launch unless `launch_for = "anyone"`. A project's `archer.toml`
  may only narrow these. The chat bubble tells the owner which step a message is on.
- **The sign-in link's secret was the browser's cookie.** Each sign-in now mints a per-browser session;
  the cookie never holds the link's secret, and sign-ins are paced at 20 a minute per link.
- **The pairing code form is a real form post** answered with one redirect; a code is never all digits.
- **A loose override directory, another account's socket, or an account `archer.toml` with a second
  name is refused**, and `archer doctor` prints the `chmod` line that fixes the directory.
- Archiving or showing a project follows its edit switch; a Bearer token never archives.
- The debug metrics need the service token. Debug events from anyone but the owner keep no text: each
  string becomes its length, and the session becomes an opaque mark.
- Every HTML page has a strict Content Security Policy (scripts by hash, `base-uri 'none'`,
  `form-action`), HSTS on HTTPS except for localhost names, and `nosniff` everywhere.

### Fixed

- **A file or folder swapped for a link mid-save could write outside the project.** Reads and writes
  go through one confined seam that holds the folder open; hard links are refused as sources and broken
  by writers. A folder moved out of the project by another program during a save is a known limit
  (`docs/security/known-limits.md`).
- **Logs and debug downloads could keep a secret.** Tokens, session secrets and pairing codes are hidden
  in every spelling, request lines name the route instead of the path, and hex runs of 16 or more are
  hidden.
- The launcher starts in the folder it checked; the MCP relay checks the socket on every connect; the
  socket is `0600`.
- A layout save checks its write rule; a comment on a linked file is refused, not a 500.
- The thumbnail guard reads markup, not label text, and refuses any namespace but SVG's.
- An emphasis id is text, not a replacement pattern, on export.
- A hot swap sends the calls the old service never ran to the new one. (O56)
- An agent's activity report checks the project's rule before it counts; a network-access restart that
  lost its stop request still stops; setting up network access over the MCP relay finishes the calls
  in flight before the relay stops, and a failed setup restarts the service.
- Pressing `1` right after opening a diagram fits it once it is drawn, however long that takes;
  opening another diagram cancels it. (O59)
- A refused CLI or MCP diagram write no longer tells the page a write is coming.
- A comments file saved by another process at the moment it was read was skipped, so a reply could
  fail with "no thread". The read is taken again. (O65)
- Dependencies: every advisory decided; dompurify, body-parser, zod, vite and vitest upgraded.
- Test flakes O48–O55, O57 (a focus watch that outlived its page), O58, O60–O63 and O66.

### Measured

Security round 1, rubric `docs/quality/rubrics/security.md` v1, against 0.8.0 on the devkit corpus.
Reviewers: `claude-opus-5-5` (Claude Code subagent) and `gpt-6.1-sol` (Codex CLI), independently, a review
and five to seven re-scores. Verdict: PASS WITH APPROVED EXCEPTIONS (EX-S1-01, EX-S1-05) from both, on
condition that the R7 check on this tag passes.

| Measure | 0.8.0 | 0.9.0 |
|---|---|---|
| open findings S1–S2, Claude / Codex | 1 / 4 | 0 / 0 |
| high/critical advisories without a decision | 4 | 0 |
| authority-matrix cells, mismatches | n/a | 2,020, 0 |
| CSP unsafe script sources on the page | 2 | 0 |
| hostile-corpus executions (page, MCP host) | 0 / not run | 0 / 0 |
| secret-scan hits across four channels | 7 | 0 |

## 0.8.0 — 2026-10-31

The first v1 quality round (UI/UX): every surface reviewed by two independent reviewers against a frozen
rubric and fixed until neither found a blocker; and editing is now decided by the project, not the link.

### Changed

- **Editing needed a special link, and a reading link showed Edit as a dead button.** Any signed-in
  browser can now create and edit. `edit = false` in a project's `archer.toml` makes that project
  read-only in the page; in the account's `archer.toml` it does so for every project (the project's own
  setting wins). Agents' writes are unaffected. New and Edit grey out with a tooltip naming the file.
- **Comments waited in a drafts tray.** A comment now goes to the agent when added
  (`comment_submission = "queued"` keeps drafts). On a diagram page the project review opens in the
  diagram panel's place.
- **Edit and New moved:** Edit sits on the drawing's top right, New on the header's right, and both are
  styled the same whether or not the editor has loaded.
- **Titles and element names are Title Case**, labels and steps sentence case, in the page, the skill and
  the demo project; a test catches page titles that miss it.
- C4 relationship technology and description are drawn on the line; the ⓘ control is gone.
- Agent instructions moved from `AGENTS.md` into `docs/agents/`, with `UI_UX.md` as the page's
  behaviour contract.

### Fixed

- **A diagram's nodes could only be moved by dragging.** Alt+arrow and "Move selected" move them
  from the keyboard.
- **Focus could land on controls hidden under the review panel, Chat, the accuracy panel or a phone
  sheet**, and some panels returned focus to the wrong place on close. Focus now stays visible and
  returns to what opened the panel.
- **Fit view drew labels at 5.6–9 px**, off-path text read at 2:1 contrast, and pressed or selected
  states showed by fill alone. Labels at the opening view are now at least 11 px, text keeps 4.5:1, and
  pressed and selected states have a second cue.
- **Single-letter shortcuts fired from anywhere in the window**, and Help listed keys that did nothing.
  Shortcuts can be switched off, and Help is generated from the live keymap.
- **Edit reloaded the page**, a renamed label was drawn under its neighbours, and Cancel then Discard
  asked "Leave page?" twice. Edit switches in place, the text box draws on top, and Discard asks once.
- **Lines crossed box names and labels** in an opened frame. They are now routed clear of captions and
  detail plates.
- A comment's discussion trailed its node by a frame while panning; it now moves with it.
- Smaller fixes: off-scale font sizes (21 → 0), 44 px touch targets on desktop, a blank 404, motion
  under "reduce motion", the not-found and access pages' styling.
- A dev-server reload leaked one of the link's eight event-stream connections. (Dev server only.)
- `nest-motion.test.tsx` failed now and then in whole-suite runs: it could read the canvas between two
  of React Flow's commits (a test bug). (O46)

### Measured

UI/UX round 1, rubric `docs/quality/rubrics/ui-ux.md` v1/v1.1, against 0.7.2 on the devkit corpus,
Chromium 153 headless, axe-core 4.13.0. Reviewers: `claude-opus-5-5` (Claude Code
subagent) and `gpt-6.1-sol` (Codex CLI), independently, a review and seven re-scores. Verdict: pass with
four approved exceptions (phones best-effort for v1, editing desktop-only at 320 px, faint disabled
controls, off-path fading during a walkthrough), pending three manual checks (Orca announcements, Orca
reading the diagram facts, Firefox native text zoom).

| Measure | 0.7.2 | 0.8.0 |
|---|---|---|
| axe WCAG violations (nodes) | 16 | 0 |
| distinct off-scale font sizes | 21 | 0 |
| focus stops wholly hidden (all widths) | 156 | 0 |
| label runs below 11 px at the opening view | 260 / 502 | 0 / 494 |
| touch-target failures, desktop, without an exception | 16 | 0 |
| chrome transitions under reduce motion | 3 | 0 |
| open findings, Claude / Codex (S1–S3) | 12 / 13 at review | 0 / 0 |

## 0.7.2 — 2026-10-28

Fixes from the 0.7.1 post-ship check: the home link works on this computer with network access on,
upgrades never pull files from under a running session, and the skill draws C4 views at one level.

### Changed

- **C4 diagrams copied the source's boxes, wrong levels and all.** The skill's C4 section now asks,
  per box, what starts it (in-process code is a component, not a container), for a written check of
  each claim against the code, and for separate views per level.
- The C4 syntax page names the Mermaid version Archer pins, 12.2.0 (it said 12.1.0).

### Fixed

- **With network access on, the home link gave "Open the link Archer gave you" on this computer,
  and `archer doctor` said the page did not load.** The home page now opens from this computer's
  own network address. Other machines still need a link. (O42)
- **`archer doctor` passed a copied skill whose reference pages were older.** It now compares
  every file of the skill and names the ones that differ. (O43)
- **The second upgrade after a session started could remove the copy that session still ran.**
  Setup now keeps a copy while any session started on it runs, however it was started. (O44)
- **A session open across an upgrade could restart an older Archer** when it found none
  running. It now starts the installed one. (O45)
- **"Comment on selection" stopped working when the agent re-sent a note's highlights.** The
  selection is kept. (O40)
- **A diagram's highlights could empty** when the agent set them while the page was reading
  them. (O41)

### Measured

The C4 section, on the diagram-normalisation eval (round 6): nine source diagrams from four
projects rewritten as C4 views, each run reading only frozen copies of the skill files under test,
scored mechanically against a register of facts in the code. Before is the skill in 0.7.1.

| Change | Model | Effort | Runner | Runs | Measure (per run) | Before | After |
|---|---|---|---|---|---|---|---|
| C4 section | `claude-haiku-5-5` | default | Claude Code subagent | 3 + 3 | wrong-level boxes | 6.7 | 0.3 |
| | | | | | invented arrows | 0.7 | 0.3 |
| | | | | | stale claims kept | 4.3 | 2.3 |
| | | | | | reversed arrows | 8.3 | 0.3 |
| | | | | | headline arrows kept | 100% | 97% |
| C4 section | `gpt-6-luna` | medium | `codex exec` 0.165.0 | 5 + 5 | wrong-level boxes | 5.6 | 3.4 |
| | | | | | invented arrows | 0.2 | 1.6 |
| | | | | | stale claims kept | 3.2 | 1.6 |
| | | | | | reversed arrows | 9.6 | 0.0 |
| | | | | | headline arrows kept | 94% | 81% |

The cost: Luna invents more arrows and leaves more sources as flowcharts (fewer headline arrows
kept). The same words in the task prompt instead of the skill give Luna 0.6 wrong-level boxes, so
the skill is not yet the ceiling. Eval: the round-6 trial of 2026-10-28, which recorded the model, effort, file hashes and read audit of
every run.

## 0.7.1 — 2026-10-27

Fixes found after 0.7.0: upgrades keep what running sessions use, and the network messages say
what is true.

### Fixed

- Stopping Archer while it drew a diagram thumbnail could abort the whole service; thumbnails are
  now compressed outside the drawing worker.
- After a restart or upgrade, "Reconnecting to Archer" clears about a second after Archer is back
  (it followed the service's retry hint), not up to 16 seconds later.
- A project's own files show on its page when the list of other projects cannot be read; the page
  says that list is incomplete instead of showing an empty project.
- After saving a reply, focus returns to Reply.
- An upgrade no longer deletes an older installed copy that an agent session still runs; it keeps
  it, names the session, and removes it once the session has restarted. Sessions still on an MCP
  server from before the relay are listed at every upgrade, not only the first.
- `get_ui_url` no longer calls an HTTPS page on your network "plaintext HTTP".
- Turning on network access no longer leaves an unused certificate (with its key) behind when a
  try fails, and removes a certificate it replaces.
- Setup's last line says when the page is already open to your network.

## 0.7.0 — 2026-10-27

Agent surfaces: one way for agents to use Archer (the `archer` command), and messages from the page's
chat that reach a listening agent while it is idle.

### Added

- "Listen to me in Archer": the agent runs `archer listen --claim` and `archer wait`, and what you
  write in the chat reaches it straight away, even when its session is idle. The chat says who
  receives your messages ("Listening · Claude Code", "Waiting for the agent's next turn", away, or
  nobody), and on this computer the **To** list picks another session.
- A turn-start hook (`archer inbox --brief`) tells Claude Code and Codex at the start of a turn
  that you wrote to them in Archer. It prints nothing otherwise and never starts Archer.
- Launch (optional): with `[agents] launcher` set in your global `archer.toml`, the chat can start
  an agent for a message when nobody is listening. Only you, signed in on this computer, can pin a
  session or Launch.
- `archer projects`, `inbox`, `skill`, `doctor` and `present` commands.

### Changed

- One small skill, CLI first, linked to the installed version so an upgrade reaches it at once.
  The slash commands are gone.
- MCP is optional (`archer setup --mcp`) and is a thin relay to the running Archer, so its tools
  update without restarting the agent session. An installed `archer-ts` plugin is reduced to that
  relay.
- Setup installs each version side by side under `~/.local/share/archer/versions/` and leaves a
  settings file it cannot write (for example a read-only home-manager link) untouched, naming what
  to add there.
- The chat no longer says "Saved · the agent sees this the next time it checks"; it says who will
  receive the message.

### Fixed

- A person comment is never lost between the page and the agent: each one is recorded as
  delivered and re-sent if it changed, so delivery may repeat but does not drop a comment.

## 0.6.4 — 2026-10-27

Diagram modes: a diagram is in one mode at a time, walkthroughs always show the same picture for a
step, and every way out puts the view back.

### Added

- One side panel on the right of a diagram: walkthrough steps or Highlights groups at the top, the
  Diagram key always at the bottom. `»` folds it to a rail and `↗` pops the key out as a floating box.
  On a phone it is the bottom sheet. It replaces the floating Highlights legend and the separate
  walkthrough box.
- New and Edit are always visible on desktop project, diagram and note pages. Without an editing
  link they say why and how to get one; who may edit is unchanged.
- The chat bubble says plainly that a sent message waits for the agent's next check.

### Changed

- A diagram is in one mode at a time (Explore, Highlights, Walkthrough or Edit). Entering a mode
  saves the view it changes; leaving restores it.
- A walkthrough step always shows the same picture, whether reached by Next, Previous, a jump, a
  replay or reopening the page.
- Leaving a walkthrough with ✕, Escape or the mode switcher restores the view from before it. A
  click on the path jumps to that step; a click off it (Select mode only, never the hand tool) leaves
  the walkthrough, keeps the camera where it is and selects that element, ready to comment. The
  comment keeps the walkthrough and step it came from.
- When the agent replaces highlights during a walkthrough, the panel offers "Show highlights"
  instead of switching on its own.

### Fixed

- Leaving a page while a nested view was still being laid out started a second layout engine on the
  closing page. Back from the browser cache now redraws instead of showing an error.
- The phone toolbar stays clear of the header and of an open bottom sheet, and the follow camera
  frames the drawing above it.

## 0.6.3 — 2026-10-26

The UI half of the agent-surfaces wave, then three performance passes with the existing size caps and
DOM budgets kept as the limit.

### Added

- Projects tree: arrow toggles, names that are links, full keyboard navigation, and Back restores
  where you were. Folders start closed in projects over 200 files.
- Diagrams inside notes are listed in the gallery, folder pages and search, labelled "in <note>",
  with an "In notes" filter. Search matches a note's diagram by its own source, not the whole note,
  and notes over 256 KiB work.
- One project conversation: the chat bubble on project, folder and search pages, and a "This
  diagram / Whole project" switch on diagram and note pages. Every message tells the agent which
  page and file it came from.
- The diagram toolbar sits at the bottom left with Source in it, so Source stays reachable when a
  diagram fails to draw. The Diagram key and the Highlights legend (formerly "Emphasis") can be
  dragged, and moved with the keyboard.
- Network access status moved from the header into Archer's settings panel.

### Changed

- Much less to download: the layout engine is its own cached file, loaded only where a diagram is
  drawn; the browser page leaves out the AI-assistant code, and the assistant page leaves out the web
  interface. Reader pages download about 30 % less, a medium project 39–56 % less, and each tab uses
  16–41 MB less memory.
- An idle page barely touches the network: the project list is compressed and an unchanged one is
  answered "nothing changed" (4.2 MB a minute to 1.2 KB at medium scale), and the notification bell
  re-reads comments only when something changed (193 requests a minute to 7).
- The service no longer stalls about once a minute on large projects (~350 ms), or when a large
  project is attached (~650 ms).
- A checkout serves the web build as its default page; run `npm run build` first. Requires Node 22.18
  or newer.

### Fixed

- A click on a shape button (State, Decision…) while the previous change was still being checked was
  silently dropped. It now runs once the change settles.
- Opening an old `-/edit/?viewId=` link loaded the page's data twice.
- A read the browser drops when the machine's network changes is asked again, instead of leaving
  "Could not read the notes." or an empty walkthrough list.
- A tab from the previous build keeps laying out diagrams across an upgrade and a later restart.
- A visibility change saved in Settings shows at once.
- Reduced motion is honoured everywhere; a closed walkthrough clears for every page following it.
- Release check: service warnings reach the gate again (they never did), and requests are classified
  per poll tick.

## 0.6.2 — 2026-10-24

First wave of the performance plan.

### Fixed

- `archer upgrade` works on a package inside an npm project (such as a checkout's `dist/`): npm
  resolved the file against the project root and found nothing. `scripts/ship.sh --here` now
  upgrades from a copy outside the checkout, so it also works with an installed 0.6.1.
- A project with more than 256 diagrams (embedded ones included) no longer freezes: before, every
  present, selection and emphasis change failed with "saved state exceeds the view limit". Recovery
  now keeps the 256 most relevant views (presented, selected, emphasised, then newest).
- One oversized or unreadable project no longer empties the whole project list. It is listed under
  "Not listed:" with the reason, and the other projects show as usual.
- The first page load after a start or upgrade is compressed. It used to send the full 4.2 MB for
  about 9 s while compression ran. Packaged installs now ship the page pre-compressed.

### Changed

- Faster on large projects: a selection or emphasis change no longer re-reads every saved diagram
  (at 250 diagrams, 1 file instead of 251); restore, search and `write_diagram` stop re-scanning the
  folder per diagram (search with no match at 1,000 diagrams: 0.3 s instead of 1.7 s).
- The page loads a project's comments in one batch (4,096 targets: 86 ms instead of 1.75 s), skips
  work when the 15-second project-list refresh finds nothing new, and keeps fewer old reads in memory.
- The page is 28 KB smaller (gzip): unused zod translations are left out.
- Release check: a new scale step builds small and medium test corpora (a large one on request) and
  gates request, comment-read, catalog-size and DOM counts (after a warm load; the quick run does the
  small corpus only).

## 0.6.1 — 2026-10-24

### Changed

- Flow animation is **On** by default. Before, it was Auto, which stops the moving arrows whenever the
  system asks for reduced motion. Auto and Off are still in the diagram key.
- In a walkthrough, the words on boxes and lines that are not part of it now dim with their shapes,
  so the path stands out. Line captions had stayed at full strength before.
- Space plays, pauses, or (at the last step) plays a walkthrough again from the start, wherever focus
  is in the walkthrough: a step row, a Sequence message, the step controls or a box on the diagram.

## 0.6.0 — 2026-10-23

### Added

- **Walkthroughs** (ADR 0034): named, step-by-step flows over a
  diagram, stored beside it as `<name>.walkthroughs.json` and pinned to the revision they were written
  for. A "Walkthroughs · N" button opens a resizable panel: a picker, the steps (from → to, what, why,
  code) and a Sequence tab; walked steps stay quietly marked, the current step is lit with moving
  arrows, the rest fade (labels stay readable). Step with the wheel or arrow keys over the panel,
  ←/→, Home/End, Space to play, `F` to follow. "Follow steps" glides the view to each step and opens
  nested boxes a step needs. Links carry `?walkthrough=<id>&step=<n>`.
- Agents: `list_walkthroughs`, `write_walkthrough`, `present_diagram` with `walkthrough: {id, step}`,
  the reader's step in `get_presentation_context`, and `archer walkthrough list|show|write|delete`.
  A diagram change that breaks steps is reported in `write_diagram`, `list_stale_diagrams` and
  `list_diagrams`; broken steps show "Out of date", and a walkthrough with no matching step is
  archived and can be played on the diagram version it was written for.
- **Comments on walkthroughs**: right-click (long-press, Shift+F10) or `C` comments on a box, line,
  step or sequence message, the same gesture everywhere; step and walkthrough threads, and element
  comments that note the step they were made on. The comments file is version 3 only when a thread
  uses these.
- **Chat bubble**: a movable launcher for talking to the agent about the whole diagram, walkthrough or
  note. It expands into a sidebar and collapses back to the bubble; Enter sends that conversation.

### Fixed

- The nested view's "+" and "−" are the rounded-square marks of the approved design again, and a box
  that opens or an open frame looks like any other box or frame: no blue tint, no forced blue
  outline. An emphasised frame shows its emphasis colour.
## 0.5.1 — 2026-10-23

### Fixed

- Only a person at a terminal can open Archer to the network from the CLI: without a terminal (an
  agent's shell, `archer call` included) `archer network-access` refuses, it has no `--yes`, and it
  takes no `personConfirmed`. Fixes and warnings no longer suggest `--yes`. At the terminal it prints
  four lines: address, pairing code, certificate, how to turn it off.

## 0.5.0 — 2026-10-23

### Changed

- Local use needs no setting: with no TLS configured, a loopback bind (the default `127.0.0.1`)
  serves plain HTTP; the link never leaves the machine (ADR 0017,
  amended). A network bind still needs HTTPS or explicit `force_http`.
- `setup_network_access` (CLI `archer network-access [on|off]`) opens Archer to the person's devices
  after their yes (asked by the client itself where it supports MCP elicitation): a local certificate
  (reused when it still fits), the LAN address only, the `[service]` settings merged into the global
  `archer.toml` (others kept, the old file backed up), a restart, and the address, a pairing code and
  the CA-trust step. The page shows "Open to your network at … · Turn off"; `enabled: false` turns it
  off. Codex keeps asking for it even when Archer's other tools are approved. Access and TLS refusals
  carry a stable code and a `fix` the agent follows.
- `present_diagram` takes an optional `emphasis` (set_emphasis's payload) and sets it in the same
  call; a problem in it is refused as `invalid_emphasis`, naming that argument. Against an older
  service that ignores it, the emphasis is set just after presenting (accepted: upgrades hot-swap).
- `archer restart` is a warm hand-over (ADR 0032): the
  new version starts and warms first, then takes over the same port, socket and token as the
  running one lets go (gap well under a second). Open pages are told to reconnect at once and show
  no "lost" state; a page reloads itself to a new version when nothing is being edited, else shows
  "Archer was updated · Reload". A replacement that cannot start leaves the running service as it
  was. Front doors wait for a hand-over (up to 10 s) instead of starting a service of their own.
- An agent session older than the running service is told once to restart for the new tools.
- Thumbnails are cached by what draws them, not by Archer's version: an upgrade that leaves drawing
  alone redraws nothing.
- A restart keeps the files-changed baseline and pending agent-write attribution, so a file edited
  while Archer was down still shows "<file> updated".

- Front doors look across running copies (ADR 0031).
  The current main Archer is used as before; an older main build, one speaking another protocol, or
  a copy on another default state directory is refused as `instance_choice_needed`, listing the
  copies and a command per option, until `~/.archer/preferences.md` records `instances: reuse-main`
  or `reuse-any`. A caller with its own `ARCHER_STATE_DIR` only ever uses its own copy.
- An isolated copy (own `ARCHER_STATE_DIR`) stops after 30 idle minutes (`ARCHER_IDLE_TIMEOUT_MS`,
  0 never); any copy stops when its state directory is removed. The main one never stops on idle.

- Agent emphasis is colour only (ADR 0030):
  an emphasised box is its border in the group's colour, an emphasised line and its arrowheads take
  the same colour, and a flow adds moving arrows (both ways on a two-way line, still under reduced
  motion). Groups are coloured by order (teal, violet, coral), at most three.
- The emphasis legend is a chart legend: tap a row to toggle its group; One / All, with All only
  when groups share nothing; groups that share parts show one at a time.
- Edge captions wrap at about 14 characters on at most two lines, and the layout keeps line visible
  on both sides. A C4 relationship's technology moves behind a ⓘ on its caption.

### Breaking

- `set_emphasis` refuses `palette` and `state`, more than three groups, a missing label, and legend
  text over its limits; each refusal names the fix. Saved emphases with more than three groups are
  dropped on restart.
- `write_diagram` refuses a source that introduces an edge label needing a third
  line, or an unexplained line pattern; `validate_diagram` reports both as warnings.
- `write_diagram` refuses a source that adds a structural nesting-profile warning; warnings the
  file already had are only reported. architecture-beta groups nest at most 24 levels, as every
  other family does.

### Added

- `archer upgrade <archer-x.y.z.tgz>` installs a package (keeping the previous copy), hot swaps the
  running main Archer to it, and says whether agent sessions need a restart.

- `archer status` lists every running copy (main or isolated, version, pid, age, idle time, URL,
  state directory). `archer stop --stale [--include-main]` stops isolated idle copies, copies whose
  state directory is gone and older versions, signalling only processes verified by owner identity.
- `archer preferences [set instances <ask|reuse-main|reuse-any> --note "…"]` shows or records the
  person's choice in `~/.archer/preferences.md`; `start_service` names the note once it exists.

- Nested view (experimental, on by default; ADR 0029): a diagram
  with C4 boundaries, subgraphs, architecture groups or composite states opens at its top level. A
  closed box (light blue, "N … inside") has a `+` that opens it one level, growing in place without
  reshuffling the rest; every open frame (blue outline) has a `−` that closes it. Connections to a
  closed box are one line, "N connections" when there are several. The controls and frame outlines
  keep their size at any zoom; the Nested view switch in the canvas controls draws the whole diagram.
  `?zoom=full|nested` and `?open=<id>,<id>` in a page link ask for a view; presses never change the
  address. `nested_view = false` in `archer.toml` turns it off for a project.
- Nesting profile: `validate_diagram` reports uniform-nesting findings (C4 levels in their boundary
  kinds, at most 4 deep, subgraph/node id clashes; advisories for single-child and crowded levels).
- Line patterns with authored meanings: `%% archer-key <pattern>: <meaning>`, flowchart edge classes
  `dashed` and `dashdot`, and `%% archer-line` for C4, architecture and state diagrams. The meaning
  appears in the Diagram key (or the legend's Key while an emphasis is up).

## 0.4.0 — 2026-10-18

The first release of the TypeScript implementation. It replaces the Rust 0.3.0 application, serves
the page over HTTPS at new addresses, and adds notes with embedded diagrams, browser drawing of
flowcharts, and agent review of saved changes. Read "Breaking" and "Operators" before upgrading.

### Breaking

- Archer is now the TypeScript application in `ts/`, installed as the `archer-ts` Claude plugin
  with an `archer` CLI and a per-user background service. The Rust 0.3.0 implementation, its
  release binaries and its docs moved to the `rust` branch.
- The service defaults to HTTPS and never falls back to HTTP. Provision a certificate with
  `archer tls setup --host <host-or-LAN-IP>` ([docs/tls.md](docs/tls.md)), or set
  `force_http = true` for development only. Moving from HTTP to HTTPS changes the page's origin,
  so open tabs cannot reconnect.
- Page addresses are `/projects/<name>/…`: a folder ends in `/`, a note or diagram is its path, an
  embedded diagram is `<note.md>#<archer-id>`, and `?follow` follows the agent's presentation.
  Older `/p/…`, `/views/…`, hash-slug and `/<token>/…` addresses redirect, keeping the query.
  (ADR 0017)
- A token in a link is exchanged once for an HttpOnly, SameSite=Strict cookie and then dropped
  from the address. A private browser link comes from `issue_access_link`; links can be listed and
  revoked one by one.
- A view id may be a note address, `notes/auth.md#login-flow`, wherever a view id is accepted.
  (ADR 0012)
- `set_ui_binding` is gone; the service owns the listener, configured globally
  (ADR 0013).

### Added

- **Notes with embedded diagrams.** Every ```` ```mermaid ```` block in a Markdown note is a
  diagram: drawn inline, opened in the canvas, commented on, emphasised, and read and written in
  place by the agent.
- **Drawing in the browser.** With a project authoring link from `issue_authoring_access`, choose
  **New diagram** or **Edit diagram**: place blank flowchart shapes, drag, connect handles and
  label them inline, then **Save** or **Cancel**. Other families edit as source; phones are
  review-only. (ADR 0025,
  ADR 0027)
- **Review of saved changes.** Repeated Saves keep one diff from the oldest unreviewed version to
  the current one. New tools `list_changes`, `read_change` and `resolve_change` let the agent read
  it and clear its exact revision with a summary of what it understood.
  (ADR 0026)
- Project discovery: projects, folders and search in one browser with filters, cards or tables,
  and selectable columns. Projects can be hidden without detaching them and carry a description
  from `archer.toml` or their README. Projects get readable names (`archer`, `pageturner`) that are
  never reassigned. (ADR 0021,
  ADR 0022)
- Diagrams and notes carry created and edited dates and a description (`description:` front
  matter, or a `%% description:` line).
- Discussions on note passages and named highlights; notifications; a settings panel, including
  whether comments are queued or sent at once.
- Tools for comments (`create_comment`, `get_comments`, `reply_comment`, `resolve_comment`), note
  emphasis, `read_note`, `compare_diagrams`, `export_diagram`, `read_diagram_at_commit`,
  `list_stale_diagrams`, project attachment and service control.
  (ADR 0018,
  ADR 0020)
- A compiled `write_diagram` returns `modelRevision`, ready for `present_diagram`.
  (ADR 0019)
- `archer restart` replaces a running service, keeping its address and projects; open pages
  reconnect. (ADR 0015)
- Global configuration in `~/.config/archer/archer.toml`, including `[feedback]` preferences.
  (ADR 0023)

### Project page redesign

- A project's page opens with its name, description and facts: diagram and note counts, open
  threads, folder, Git branch and commit, and last edit. The project's root `README.md` shows as a
  collapsible card.
- Tabs **Folders**, **Diagrams** and **Notes** (in the address as `?tab=`) replace the cards and
  tables view, on a project's page and the overview. Folders is a tree with sortable, reorderable
  columns; Diagrams is a card gallery with type filters and a **New diagram** action; Notes is a
  sortable table including each note's author.
- A settings gear opens **Project settings**: name and description are edited in `archer.toml`
  in place (every other byte kept; refused if the file changed meanwhile), and visibility
  (Automatic, Always show, Archive) moves there from the page. Other settings are shown read-only.
- Diagram previews are drawn once by the service and cached by revision, so galleries no longer
  repaint while scrolling.

### Changed

- The page's address follows every navigation, so a reload or shared link opens what was on
  screen, and Back walks the history.
- Graphs open in Hand mode, with tools beside the canvas controls.
- Filters, notifications, table columns and the sidebar were reworked after live review.
- Agent guidance puts new diagrams in `diagrams/`, new notes in `notes/`, and embeds a discussion
  diagram in its note by default.

### Fixed

- Reloading a note's comments dropped the text selection, so "Comment on selection" did nothing.
- A page signed in by cookie could not delete a comment.
- A Save click in the editor could be lost while the preview settled.

### Operators

- Back up `~/.local/state/archer` before upgrading.
- New private state under the state directory: `project-names.json`, `authoring-grants.json`,
  `runtime/authoring/`, `runtime/authoring-presentations/`, `writers/` and `cache/thumbnails/`. Comment writer locks
  move there from `.<file>.writers/` folders in the repository, which are removed.
- The first `resolve_change` upgrades the change-store index from version 1 to version 2. Older
  builds cannot read it afterwards.
- Ordinary links stay read and comment only. Drawing needs a new link from
  `issue_authoring_access`.
- Use HTTPS on a LAN. Saves write `.review/*.diff` files under the authoring folder; Git ignores
  them.
- Private storage has fixed capacity limits and no automatic pruning yet. Status reports usage,
  and new work is refused when full.

## 0.3.0 — 2026-10-02

The first release since 0.2.1. It changes the wire contract and several tool results, so an agent
or script written against 0.2.x needs the changes under "Breaking" below.

### Breaking

- The diagram envelope is `schemaVersion: 2`; version 1 payloads are rejected. No stored data is
  affected. (ADR 0009)
- `read_diagram` returns `modelRevision`, `sourceRevision`, `envelope`, `source` and `compile`.
  The top-level `revision` and `model` keys are gone.
- `write_diagram`'s `expectedRevision` is the view's **source** revision, checked against the
  bytes on disk at write time.
- `present_diagram` no longer accepts `transition`.
- Every tool refuses unknown, missing or mistyped arguments with `invalid_arguments`.
- Errors carry codes from one enumerated list
  (ADR 0002). `register_diagram` returns
  `duplicate_view_id`, `duplicate_source_path` or `path_outside_workspace` where it returned
  `invalid_request`.
- Inputs are bounded: a source at 256 KiB, a label at 512 characters, a title at 200, a workspace
  at 256 views, the manifest at 1 MiB.
- Fragment and subgraph nesting are limited to 24 levels. A label, class or operand may not
  continue onto the next line. Duplicate node, edge and subgraph IDs are rejected.
- `GET /api/events` no longer replays the presentation on connect; a page reads state from the
  routes.
- A marquee selects the edges between the nodes it covers as well as the nodes.

### Added

- Mermaid profile: `direction` is honoured; `cylinder`, `hexagon` and `subroutine` shapes; dotted
  and thick links; sequence `Note`, `actor`, `autonumber` and `+`/`-` activation. The profile is
  served as the resource `archer://docs/supported-mermaid`.
- The parser reports every independent problem in one pass, each with line and column.
- The sequence canvas is interactive: hover, click, Shift-click, keyboard traversal, select-all.
- `set_emphasis` works on sequence diagrams; a stored emphasis or focus follows its message across
  an edit instead of its positional id.
- A notice over the last valid drawing when a diagram's file stops compiling, listing each
  problem (ADR 0010).
- The reader's selection reaches the agent from any tab, and the page says when the reader is on a
  different diagram from the one presented
  (ADR 0011).
- `present_diagram`'s `annotation` is shown as a caption under the drawing.
- A second visual design, Line map, selectable beside the default.
- `validate_diagram` and `write_diagram` print the line and column of each diagnostic.

### Fixed

- `write_diagram` could write through a planted `<stem>.tmp` symlink, outside the workspace.
- A stale `expectedRevision` could overwrite a newer file on disk.
- One unreadable directory under the working directory stopped the server from starting; the
  server now watches only the directories that hold registered sources.
- Sequence fragments were clipped and overlapped; graphs opened cropped and ignored their
  direction; node shapes and semantic classes were not drawn.
- Clicking a graph edge with a mouse did not select it.
- An agent's focus scrambled nested groups on the second draw.
- After a reconnect the page could go on showing a diagram the server had retired.
- A source deleted and restored with identical bytes stayed marked missing.
- SIGINT and SIGTERM now stop the server promptly; a FIFO named `*.mmd` no longer hangs it; one
  bad view in `archer.toml` no longer empties the inventory.
