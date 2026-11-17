# Contributing to Archer

Thanks for helping. This page covers building, testing and sending a change.

Status, plans and open questions live in GitHub issues; the newest entry of
[`CHANGELOG.md`](CHANGELOG.md) says what shipped last. Pick an issue, or open one before a large
change so its direction can be agreed first.

## Build and test

Archer needs Node 22.18 or newer. The product is the TypeScript implementation in `ts/` and the
browser page in `ui/` (one npm workspace).

```sh
npm ci                                 # install exactly what package-lock.json pins
npm run build                          # the page: ui/dist
npm --workspace ts run bundle          # the CLI and service: ts/dist (node ts/dist/archer.js --help)
```

While you work, run the tests that cover your change; they are quick:

```sh
cd ui && npx vitest run tests/<file>.test.ts        # a page test (jsdom)
cd ts && npx vitest run test/<file>.test.ts         # a CLI, MCP or service test
cd ui && npx playwright test <file>.e2e.ts          # a browser test (needs npm run build first)
```

The browser tests need Chromium once: `npx playwright install chromium`.

Before you open a pull request, run every gate once on your final commit:

```sh
npm run pr-check
```

It runs, cheapest first and stopping at the first failure: the scripts' contract tests, the ts and
ui typechecks, the page build, the ts bundle, the ui and ts unit tests, and the two browser suites.
It wants a clean working tree and a branch based on the current `origin/main`. The full run takes a
while; that is why it runs once per pull request, not per commit.

## Sending a change

1. Fork the repository and branch from the current `main`.
2. Keep one pull request to one coherent change, with tests that fail without it.
3. Write commit messages that say what changed and why.
4. User-visible changes get a line in `CHANGELOG.md` under the next version.
5. Run `npm run pr-check`, then open the pull request against `main` and say how you checked it.

A maintainer reviews every pull request before it merges, and releases collect merged changes into
one version bump and CHANGELOG section (the `archer-pr-flow` skill in `.agents/skills/` has the
details).

A test or CI job that fails for a reason other than your change is still worth a note: say so in
the pull request, and record it in `docs/known-failures.md` with its root cause once found.

Some decisions are settled: the frozen boundaries in `docs/agents/frozen-boundaries.md` and the
supported Mermaid profile. A change that needs one of them to change should say so and argue it in
the pull request, rather than work around it.

Coding agents should start with [`AGENTS.md`](AGENTS.md); it points to the project's working notes.

## Reporting bugs and security issues

Open an issue for a bug, with the steps that show it and the Archer version (`archer --version`).
Report a security vulnerability privately instead, as [`SECURITY.md`](SECURITY.md) describes.

By contributing you agree that your contribution is licensed under the Apache License 2.0
([`LICENSE`](LICENSE)).
