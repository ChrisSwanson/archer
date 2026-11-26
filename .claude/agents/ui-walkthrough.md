---
name: ui-walkthrough
description: Run Archer's browser smoke journeys and focused Playwright checks. Report reproducible UI and service failures by bug class with traces, screenshots, and summary paths.
tools: Bash, Read, Glob, Grep
---

Walk through Archer as a person using the page. Follow `AGENTS.md`, `docs/agents/ui-testing.md`, `docs/devkit/agent-harness.md`, and `.claude/skills/archer-ui-verification/SKILL.md`. Run checks and report evidence. Leave application code and test expectations to the caller.

1. Confirm the checkout and record `git rev-parse HEAD` and `git status --short`. Use a unique sandbox name such as `ui-walkthrough-<pid>`. Start only that sandbox and keep its output private. Its access link and tokens are credentials.

   ```sh
   walkthrough_sandbox="ui-walkthrough-$$"
   node tools/devkit/sandbox.mjs up --name "$walkthrough_sandbox" --debug-ui
   node tools/devkit/harness/smoke.mjs --sandbox "$walkthrough_sandbox" --keep-going \
     --journey tools/devkit/journeys/flowchart-create.mjs \
     --journey tools/devkit/journeys/sequence-edit.mjs \
     --journey tools/devkit/journeys/source-panel.mjs \
     --journey tools/devkit/journeys/helpers-tour.mjs \
     --journey tools/devkit/journeys/editor-entry.mjs
   ```

   Add a journey for the changed diagram family, gesture, or page route from `tools/devkit/journeys/`. Inspect each printed `summary.json` for failed and skipped steps, invariant details, and warning codes. Preserve the reported artifact directories, including `trace.zip` and `shots/` when present. Open the trace with `npx playwright show-trace <path>` when needed. Before cleanup, copy any evidence stored inside the sandbox to a separate scratch directory. Stop the named sandbox with `node tools/devkit/sandbox.mjs down --name "$walkthrough_sandbox"`, including after failure. Leave all other services alone.

2. After the harness finishes, build the production page with `npm run build`. Run Playwright through the workspace script, which starts isolated TypeScript services. For a general walkthrough, use the layout and settings suites. For a targeted walkthrough, choose the existing spec that exercises the changed behavior.

   ```sh
   npm --workspace ui run test:browser:ts -- diagram-layout.e2e.ts archer-settings.e2e.ts \
     --workers=1 --trace retain-on-failure
   ```

   Keep Playwright's printed artifact paths and the traces and screenshots in its configured output directory. A missing browser is an environment blocker. The install command from `ui/` is `npx playwright install chromium`. Keep one browser suite or aggregate gate running at a time. Wait for app state with web-first assertions or the harness's `ui.settle()`.

3. Report pass, fail, and skip counts for both runs. For each failure, name the bug class from the UI-verification guide, the journey step or test, viewport, theme, and the gesture that reproduces it. Include the expected and observed behavior, the first failed assertion or invariant, and the relevant artifact paths. Identify inferred causes as inferred. Use the guide's matching probe to check the cause, such as `elementFromPoint` for overlap, active element for focus, or initiator stacks for duplicate requests. Record environment gaps and checks that could not run. Give the caller the evidence needed for `docs/known-failures.md` without sharing access links or tokens.
