# Aggregate quality gates

On a fresh clone run `npm ci` first.

How work reaches main (one PR per release: `release/X.Y.Z` from today's main, ending in the version
bump and CHANGELOG entry, the full gates once, merged in order, main fast-forwarded after):
`.agents/skills/archer-pr-flow/SKILL.md`.

Run all of these before opening a pull request:

```sh
npm run typecheck
npm run build
npm test
npm --workspace ts run typecheck
npm --workspace ts test
npm --workspace ts run bundle
npm --workspace ts run test:browser
npm --workspace ui run test:browser:ts
npm run docs:build
npm run docs:test:browser
npm --workspace ui run test:playground
```

Before pushing a PR branch, `npm run pr-check` runs these (and CI's contract tests) on the exact
commit and stamps it; the pre-push hook (`npm run hooks:install`) refuses an unstamped branch, and
the pre-commit hook formats and lints the staged files with Biome (`biome.jsonc`; fix with `npm run format`).
Format and lint (`npm run biome:ci`) is also a gate of its own, before the typechecks, in pr-check and CI,
beside the shell lint (`npm run lint:shell`: ShellCheck at warning severity over every tracked shell
script outside docs/, `scripts/shellcheck.sh`). Without shellcheck installed it skips with a message
(`brew install shellcheck`); CI's image has it and sets `ARCHER_SHELLCHECK_REQUIRED=1`, so it never skips there.
It runs the ts, ui and site typechecks at once (`npm run typecheck` is ui's then the docs site's,
`npm run typecheck:site`: vue-tsc over `site/tsconfig.json`, so the theme's `.vue` templates and props are checked with the rest), then the ui and ts unit suites at once, each on
`ARCHER_PR_CHECK_UNIT_WORKERS` workers (default 6, sized for a 24-thread host; CI keeps 2 and 3).
Each of a pair writes its own log, printed whole when both finish; a failing one fails the gate by
name and its log is kept. The browser suite starts with `xss-mcp-host.e2e.ts` (a 3-minute serial
file, its own Playwright project so it heads the run and shard 1 rather than ending them), then the
e2e files the branch changed (`ARCHER_E2E_FIRST`), then the rest; each file still runs once.
The last three (the docs build and the site and playground browser suites) are pr-check's last
gates; CI does not run them yet (the public tree's Pages workflow runs `docs:build` only).
Every runner holds off macOS idle sleep while it runs (`tools/keep-awake.mjs`); on a Mac a run that
seems to hang for minutes was suspended (see [UI testing](ui-testing.md#where-the-test-time-goes)).
CI (`.github/workflows/ci.yml`) runs the same list on every pull request and push to main: the unit
gates in one job, the two browser suites in a second job split into two shards.

Build before testing: both suites start services that serve the page build in `ui/dist`, and
bundle it.

To serialize the full UI suite, use `npm --workspace ui test -- --maxWorkers=1`. The root
`npm test -- --maxWorkers=1` forwards the flag to its nested npm command, which consumes it
as npm configuration instead of passing it to Vitest. Check the logged Vitest invocation.

`npm run lint` is not a separate gate: it is ui's `tsc --noEmit` (see `ui/package.json`), which
`npm run typecheck` already runs. The linters are Biome (`npm run biome:ci`) and ShellCheck
(`npm run lint:shell`); reporting `npm run lint` as well claims a check that does not exist.

Run focused tests during development; do not substitute them for the aggregate gates before opening a pull request.

## Unused code (report only)

`npm run knip` lists unused files, exports and dependencies across the root (`scripts/`, `tools/`, `site/`),
`ts/` and `ui/`, using the entries in `knip.json`. It is **not a gate**: it exits non-zero while findings
remain, and they are triaged by hand. Before deleting an export it reports, check that nothing reaches it in a
way Knip cannot see: a Vite alias (`page-shell-web.ts`/`page-shell-mcp.ts`), a worker loaded through
`new URL(...)`, a fixture page's `<script src>`, or an env-gated `setupFiles` entry. When you find one, add it to
`knip.json` as an entry instead of keeping the file alive another way.

## Python scripts (not a gate)

The repository's only maintained Python is `deploy/governance-check.py` and `ui/scripts/fira-fonts.py`
(the rest is research under `docs/`). `npm run lint:py` type-checks them with Pyright through `uv`, which
brings the scripts' own dependencies so imports resolve (`pyrightconfig.json` scopes it to those folders).
Run it when you change either script; it needs `uv` and is not part of `pr-check`.
