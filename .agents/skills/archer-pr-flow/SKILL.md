---
name: archer-pr-flow
description: How Archer work reaches main on GitHub — one pull request per release, cut as `release/X.Y.Z` (or a fork branch) from the current main at a stopping point, ending in a version bump and a CHANGELOG entry in a fixed format (problem → fix bullets, a Measured table for evals), iterating with focused tests and running `npm run pr-check` once per batch, rebased before it opens, merged in order. Use when deciding whether work needs its own PR, starting a branch or worktree, before opening or updating a PR, when CI fails on one, after a PR merges, and whenever a PR's commit count or diff looks larger than its own change.
---

# Getting work to main

Main changes only through a pull request, and every PR that touches code costs a full CI run. So
**one PR per release**: work collects on one branch from the current main, one commit per fix,
until a stopping point (a set of fixes done, a finished slice); the PR then ends with the release
commit (step 3). A contributor's single fix is its own PR and needs no release commit: the
maintainer folds it into the next release's CHANGELOG.

Semantic versions: a patch for fixes, a minor for new behaviour. A separate PR only with a reason:
something must be on main first, it needs its own decision or must be revertible on its own, or it
would mix a release with unrelated work.

Batching is commits on one branch cut from main. **Stacking** (a branch on another unmerged branch)
is out: releases built on unmerged ones once grew a PR to 700+ commits that every review and every
rebase had to recompute. Start the next release once the previous PR has merged; if it must start
early, move it with `git rebase --onto` after the merge.

**Iterate small, gate once.** While working, run only what the change touches
(`npx vitest run <file>` in `ui/` or `ts/`, `npx playwright test <file>`, or
`node ui/scripts/repeat-suite.mjs` for a suspected flake). Run `npm run pr-check` once, when the
batch is complete, not per commit, and one gate run at a time per machine: two side by side
overload the host and fail on timeouts that pass alone.

## 1. Start from the current main

```sh
git fetch origin
git switch -c release/X.Y.Z origin/main     # or a topic branch on your fork
```

A new worktree needs `npm ci` first.

## 2. Before opening or updating a PR

```sh
git fetch origin && git rebase origin/main
git rev-list --count origin/main..HEAD          # this PR's commits only
git diff --shortstat origin/main...HEAD         # this PR's change only
npm run pr-check                                # every gate, on this exact committed HEAD
npm run pr-check -- --stress                    # when test files changed
```

If the count or diff includes other work, the base is wrong: fix it before pushing. Leave the
worktree alone while pr-check runs (an edit voids its stamp). `npm run hooks:install` once per clone
makes `git push` refuse an unstamped branch. A change only to `docs/**/*.md`
or `.agents/skills/**/*.md` skips the code gates (`scripts/ci-docs-only.sh`). After a rebase push
with `git push --force-with-lease`, never plain `--force`.

## 3. The PR

- Title `X.Y.Z — <its point>` (or what the change does). Body: the CHANGELOG section as written, then
  **Verified**: the pr-check run on this HEAD (gates, test counts), manual checks, open decisions.
- The release commit is the PR's last commit: the CHANGELOG entry and the version in
  `ts/package.json`, `ts/plugin/.claude-plugin/plugin.json`, the `ts` entry of `package-lock.json`
  and `docs/install.md`. The entry is the release notes, in [Keep a Changelog](https://keepachangelog.com/)
  form, newest first, written for the person using Archer, no file paths unless they type them:

  ```md
  ## X.Y.Z — YYYY-MM-DD

  One sentence: what this release is for.

  ### Added | Changed | Fixed | Removed | Security   (only those that apply, in this order)

  - **What the person saw or could not do.** What happens now, in one sentence. (#123)

  ### Measured   (only when guidance, prompts or performance changed)

  | Change | Model | Effort | Runner | Runs | Measure (per run) | Before | After |
  ```

  Each bullet is one problem and its fix, linked to its issue or its `docs/known-failures.md` row.
  Every commit since the last tag is covered (`git log vX.Y.Z..HEAD`).
- **CI fails on the PR.** Read the job's log, not its status line. If the failure is the PR's own,
  fix it there as a commit. If it is an unrelated flake, rerun the job and fix the flake in the next
  batch. Either way it is root-caused and gets a row in `docs/known-failures.md` before the fix is
  pushed.

## 4. After the merge

The maintainer merges, then tags the merge commit on main (never a branch commit):

```sh
git fetch origin --tags && git switch main && git merge --ff-only origin/main
git tag -a vX.Y.Z -m "X.Y.Z" origin/main && git push origin vX.Y.Z
```

The tag runs the release workflow (`.github/workflows/release.yml`), which builds the package and
publishes the GitHub Release (`.tgz`, `SHA256SUMS`, the CHANGELOG section); check that run. Then
delete the merged branch, remove its worktree (check `git status` first, never `--force`), and
rebase the next release onto the new main and recheck its count and diff as in step 2.
