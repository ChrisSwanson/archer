#!/usr/bin/env bash
# scripts/pr-check.sh and .githooks/pre-push in a throwaway repository with a local origin: the
# size refusal, the gate order and fail-fast, the steps run at once (overlapping, logged apart, failing by
# name), the stamp, the dirty-tree refusal, --stress,
# --ci-speed, and the hook's verdict per pushed ref. npm, node and the contract tests are fakes that record calls.
set -euo pipefail

source_root="$(cd "$(dirname "$0")/.." && pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() { echo "pr-check_test: $*" >&2; exit 1; }

git init -q --bare -b main "$tmp/origin.git"
repo="$tmp/repo"
git init -q -b main "$repo"
cd "$repo"
git config --local user.name 'PR Check Test'
git config --local user.email 'pr-check@example.invalid'
git config --local commit.gpgsign false
git config --local tag.gpgsign false
git remote add origin "$tmp/origin.git"
mkdir -p scripts .githooks ui/tests/browser-ts ts/test bin
cp "$source_root/scripts/pr-check.sh" scripts/
cp "$source_root/.githooks/pre-push" .githooks/
cp "$source_root/scripts/ci-docs-only.sh" scripts/
for test in ci-flake-hunt github-mirror ci-local ci-browser ci-docs-only pr-check release; do
  printf '#!/usr/bin/env bash\necho "contract %s" >> "$TRACE"\n' "$test" > "scripts/${test}_test.sh"
done
printf '#!/usr/bin/env bash\necho img:test\n' > scripts/ci-image.sh
chmod +x scripts/*.sh
printf 'bin/\nnode_modules/\n' > .gitignore
printf 'it("a")\n' > ui/tests/a.test.tsx
git add . && git commit -qm initial && git push -q origin main
mkdir node_modules # untracked, as npm ci leaves it

# Fakes, outside the tree the stamp describes.
cat > bin/npm <<'SH'
#!/usr/bin/env bash
echo "npm $* throttle=${ARCHER_E2E_CPU_THROTTLE:-}${ARCHER_E2E_FIRST:+ first=$ARCHER_E2E_FIRST}" >> "$TRACE"
# MEET='<glob a>|<glob b>': the calls matching a and b each wait (5 s at most) for the other to start,
# so both pass only if they overlap; each prints a line before and after, to show any interleaving.
if [[ -n "${MEET:-}" ]]; then
  me='' other=''
  if [[ "$*" == ${MEET%%|*} ]]; then me=a other=b; elif [[ "$*" == ${MEET#*|} ]]; then me=b other=a; fi
  if [[ -n "$me" ]]; then
    echo "out 1: $*"
    touch "$TRACE.meet.$me"
    for _ in $(seq 50); do [[ -e "$TRACE.meet.$other" ]] && break; sleep 0.1; done
    [[ -e "$TRACE.meet.$other" ]] || { echo "ran alone: $*"; exit 1; }
    echo "out 2: $*"
  fi
fi
[[ -z "${FAIL_ON:-}" || "$*" != *"$FAIL_ON"* ]] || { echo "fake failure of npm $*"; exit 1; }
[[ "$*" != *--repeat-each* ]] || printf 'Running 10 tests\n  ✘  3 tests/browser-ts/b.e2e.ts:1:1 › b (1.0s)\n  1 failed\n  9 passed (2.0s)\n'
[[ "$*" != *test:browser* || "$*" == *--repeat-each* ]] || printf '  ✓  1 tests/browser-ts/a.e2e.ts:1:1 › a (1.5s)\n  1 passed (2.0s)\n'
SH
cat > bin/node <<'SH'
#!/usr/bin/env bash
echo "node $*" >> "$TRACE"
SH
printf '#!/usr/bin/env bash\nexit 1\n' > bin/docker
# taskset records the CPUs it pins to and runs the rest.
printf '#!/usr/bin/env bash\necho "taskset $1 $2" >> "$TRACE"; shift 2; exec "$@"\n' > bin/taskset
printf '#!/usr/bin/env bash\necho 8\n' > bin/nproc
chmod +x bin/*
export PATH="$repo/bin:$PATH" TRACE="$tmp/trace" TMPDIR="$tmp" ARCHER_MIN_TMP_GB=0

run() { : > "$TRACE"; rm -f "$TRACE".meet.*; set +e; "$@" > "$tmp/out" 2>&1; status=$?; set -e; }
expect_status() { [[ "$status" -eq "$1" ]] || { cat "$tmp/out" >&2; fail "expected exit $1, got $status: ${*:2}"; }; }
stamps="$repo/.git/archer-pr-check"

# A branch with one commit that changes a test file.
git switch -q -c feature
printf 'it("a2")\n' > ui/tests/a.test.tsx
git commit -qam 'change a test'

# Passes: every gate in order, cheapest first, then a stamp for the tree. The two linters, the three
# typechecks, the two unit suites and the site and playground browser suites each run at once, so
# within a pair the trace's order is not fixed.
# Each pair is sorted in place of its first line, found by what it runs rather than by line number (the
# public tree runs fewer contract tests, so the lines move).
in_order() {
  LC_ALL=C awk '
    { k = "" }
    /run (biome:ci|lint:shell) throttle=/ { k = "lint" }
    /run typecheck(:site)? throttle=/ { k = "typecheck" }
    / test -- --maxWorkers=/ { k = "unit" }
    /run (docs:test:browser|test:playground) throttle=/ { k = "docs" }
    k == "" { out[++n] = $0; next }
    !(k in at) { at[k] = ++n; slot[n] = k }
    { g[k, ++size[k]] = $0 }
    END {
      for (i = 1; i <= n; i++) {
        if (!(i in slot)) { print out[i]; continue }
        # A group of any size (the three typechecks too), sorted line by line.
        k = slot[i]
        for (a = 2; a <= size[k]; a++)
          for (b = a; b > 1 && g[k, b] < g[k, b - 1]; b--) { t = g[k, b]; g[k, b] = g[k, b - 1]; g[k, b - 1] = t }
        for (a = 1; a <= size[k]; a++) print g[k, a]
      }
    }' "$TRACE"
}
MEET='--workspace ui test *|--workspace ts test *' run scripts/pr-check.sh
expect_status 0 "clean branch"
grep -q '^pr-check: 1 commit(s) on origin/main; 1 file changed' "$tmp/out" || fail "size line missing"
in_order | diff -u - <(cat) <<'EOF' || fail "gate order"
contract ci-docs-only
contract pr-check
npm run biome:ci throttle=
npm run lint:shell throttle=
npm --workspace ts run typecheck throttle=
npm --workspace ui run typecheck throttle=
npm run typecheck:site throttle=
npm run build throttle=
npm --workspace ts run bundle throttle=
node ts/dist/archer.js --version
npm --workspace ts test -- --maxWorkers=6 throttle=
npm --workspace ui test -- --maxWorkers=6 throttle=
npm --workspace ts run test:browser -- --forbid-only throttle=
npm --workspace ui run test:browser:ts -- --forbid-only --max-failures=3 throttle=
npm run docs:build throttle=
npm --workspace ui run test:playground throttle=
npm run docs:test:browser throttle=
EOF
# The unit suites overlapped (MEET), and each one's output is whole under its own header.
grep -q '^==> \[9-10/15\] in parallel: ui tests, ts tests (logs in ' "$tmp/out" || fail "no parallel header"
diff -u - <(grep -A 2 -E '^==> \[(9|10)/15\] ' "$tmp/out" | sed -E 's/ \([0-9]+m[0-9]+s\)$//') <<'EOF' || fail "unit suites' output interleaved"
==> [9/15] ui tests
out 1: --workspace ui test -- --maxWorkers=6
out 2: --workspace ui test -- --maxWorkers=6
==> [10/15] ts tests
out 1: --workspace ts test -- --maxWorkers=6
out 2: --workspace ts test -- --maxWorkers=6
EOF
grep -qE '^ui tests +[0-9]+m[0-9]{2}s$' "$tmp/out" && grep -qE '^ts tests +[0-9]+m[0-9]{2}s$' "$tmp/out" || fail "step summary"
tree="$(git rev-parse 'HEAD^{tree}')"
test -f "$stamps/$tree" || fail "no stamp for $tree"
grep -q "^commit $(git rev-parse HEAD)$" "$stamps/$tree"
grep -q 'npm run pr-check -- --stress' "$tmp/out" || fail "no --stress suggestion"

# Fails fast: nothing after the failing gate runs, and nothing is stamped. The typechecks overlap too.
git commit -q --allow-empty -m 'empty'
MEET='--workspace ts run typecheck|--workspace ui run typecheck' FAIL_ON='run typecheck' run scripts/pr-check.sh
expect_status 1 "failing gate"
grep -q 'FAILED at ts typecheck, ui typecheck, site typecheck after' "$tmp/out" || { cat "$tmp/out" >&2; fail "the failing typechecks named"; }
! grep -q 'ran alone' "$tmp/out" || fail "the typechecks did not overlap"
! grep -q 'run build' "$TRACE" || fail "ran past the failing gate"
# One failing step of a pair fails the gate by name; the other still finishes; its log stays readable.
FAIL_ON='ts test' run scripts/pr-check.sh
expect_status 1 "failing ts tests"
grep -q '^pr-check: FAILED at ts tests after' "$tmp/out" || { cat "$tmp/out" >&2; fail "failing step not named"; }
grep -q '^npm --workspace ui test -- --maxWorkers=6 ' "$TRACE" || fail "ui tests did not run beside ts tests"
! grep -q 'test:browser' "$TRACE" || fail "ran past the failing unit suites"
grep -A 1 '^==> \[10/15\] ts tests' "$tmp/out" | grep -q '^fake failure of npm --workspace ts test' || fail "failing log not under its header"
log="$(sed -n 's/^pr-check: ts tests failed (exit 1); its log: //p' "$tmp/out")"
[[ -n "$log" ]] && grep -q 'fake failure of npm --workspace ts test' "$log" || fail "failing step's log not kept"
! grep -q '^pr-check: ui tests failed' "$tmp/out" || fail "a passing step reported as failed"
# The unit suites' worker count is ARCHER_PR_CHECK_UNIT_WORKERS.
ARCHER_PR_CHECK_UNIT_WORKERS=3 run scripts/pr-check.sh
expect_status 0 "ARCHER_PR_CHECK_UNIT_WORKERS=3"
grep -q '^npm --workspace ui test -- --maxWorkers=3 ' "$TRACE" && grep -q '^npm --workspace ts test -- --maxWorkers=3 ' "$TRACE" || fail "unit workers knob"
ARCHER_PR_CHECK_UNIT_WORKERS=0 run scripts/pr-check.sh
expect_status 2 "ARCHER_PR_CHECK_UNIT_WORKERS=0"
[[ ! -s "$TRACE" ]] || fail "gates ran with a bad worker count"
git commit -q --allow-empty -m 'empty 2'
FAIL_ON='run build' run scripts/pr-check.sh
expect_status 1 "failing build"
! grep -q 'bundle' "$TRACE" || fail "bundled after a failed build"

# A dirty tree is refused before any gate.
printf 'dirty\n' >> ui/tests/a.test.tsx
run scripts/pr-check.sh
expect_status 1 "dirty tree"
[[ ! -s "$TRACE" ]] || fail "gates ran on a dirty tree"
grep -q 'uncommitted changes' "$tmp/out"
git checkout -q ui/tests/a.test.tsx

# Not based on the current origin/main: refused, unless --allow-large.
other="$tmp/other"
git clone -q "$tmp/origin.git" "$other"
git -C "$other" -c user.name=o -c user.email=o@example.invalid -c commit.gpgsign=false commit -q --allow-empty -m 'main moved'
git -C "$other" push -q origin main
run scripts/pr-check.sh
expect_status 1 "stale base"
grep -q 'git rebase origin/main' "$tmp/out"
[[ ! -s "$TRACE" ]] || fail "gates ran on a stale base"
run scripts/pr-check.sh --allow-large
expect_status 0 "--allow-large"
git rebase -q origin/main

# No node_modules (a new worktree): refused before any gate, naming npm ci.
mv node_modules node_modules.off
run scripts/pr-check.sh
expect_status 1 "no node_modules"
grep -q 'npm ci' "$tmp/out" || fail "no npm ci hint"

[[ ! -s "$TRACE" ]] || fail "gates ran without node_modules"
mv node_modules.off node_modules

# Too little free space in TMPDIR (O270): refused before any gate, naming the floor.
printf '#!/usr/bin/env bash\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfake 100 99 1048576 99 /tmp\\n"\n' > bin/df
chmod +x bin/df
ARCHER_MIN_TMP_GB=2 run scripts/pr-check.sh
expect_status 1 "TMPDIR below the floor"
grep -q "ARCHER_MIN_TMP_GB" "$tmp/out" || { cat "$tmp/out" >&2; fail "no floor named"; }
! grep -q '^npm ' "$TRACE" || fail "a gate ran with TMPDIR below the floor"
ARCHER_MIN_TMP_GB=1 run scripts/pr-check.sh
expect_status 0 "TMPDIR at the floor"
rm bin/df

# --stress: only the changed test files, repeated, loaded and throttled; the failure rate.
printf 'test("b")\n' > ui/tests/browser-ts/b.e2e.ts
printf 'test("c")\n' > ts/test/c.test.ts
git add ui/tests/browser-ts/b.e2e.ts ts/test/c.test.ts && git commit -qm 'a browser test and a ts test'
ARCHER_STRESS_WORKERS=7 run scripts/pr-check.sh --stress
expect_status 1 "--stress with a failure"
grep -q '^node ui/scripts/repeat-suite.mjs --runs 5 --load [0-9]* --log-dir .* -- npx vitest run --maxWorkers=7 tests/a.test.tsx$' "$TRACE" || fail "unit stress call"
grep -q '^npm --workspace ui run test:browser:ts -- --forbid-only --repeat-each=5 --workers=7 --timeout=90000 tests/browser-ts/b.e2e.ts throttle=2$' "$TRACE" || fail "browser stress call"
grep -q '^node ui/scripts/repeat-suite.mjs --runs 5 --load [0-9]* --log-dir .*/ts -- npx vitest run --root ../ts --maxWorkers=7 test/c.test.ts$' "$TRACE" || fail "ts stress call"
grep -q '1 of 10 test runs failed (10%)' "$tmp/out" || fail "failure rate"
grep -q '1 tests/browser-ts/b.e2e.ts:1:1 › b' "$tmp/out" || fail "failed test tally"
test ! -f "$stamps/$(git rev-parse 'HEAD^{tree}')" || fail "--stress stamped"
git switch -q -c nothing-changed origin/main
run scripts/pr-check.sh --stress
expect_status 0 "--stress, nothing changed"
grep -q 'nothing to stress' "$tmp/out"
git switch -q feature

# --ci-speed: the build, then both CI shards and the ts service suite, pinned, loaded, throttled,
# at CI's worker count and timeouts; a verdict from every part; no stamp.
run scripts/pr-check.sh --ci-speed
expect_status 0 "--ci-speed"
grep -q '^npm run build throttle=$' "$TRACE" || fail "--ci-speed did not build the page"
grep -q '^npm --workspace ts run test:browser -- --forbid-only throttle=$' "$TRACE" || fail "--ci-speed ts suite call"
grep -q '^npm --workspace ui run test:browser:ts -- --forbid-only --workers=2 --shard=1/2 throttle=2$' "$TRACE" || fail "--ci-speed shard 1 call"
grep -q '^npm --workspace ui run test:browser:ts -- --forbid-only --workers=2 --shard=2/2 throttle=2$' "$TRACE" || fail "--ci-speed shard 2 call"
[[ "$(grep -c '^taskset -c 4-7$' "$TRACE")" -ge 3 ]] || fail "--ci-speed did not pin to the last 4 of 8 CPUs"
grep -q '^node -e .*process.ppid' "$TRACE" || fail "--ci-speed started no CPU hog"
grep -q '^==> ui-2: ' "$tmp/out" && grep -q 'pr-check --ci-speed: PASS' "$tmp/out" || fail "--ci-speed verdict"
test ! -f "$stamps/$(git rev-parse 'HEAD^{tree}')" || fail "--ci-speed stamped"
# Tuned by environment; arguments after -- filter both suites; a failing suite fails the run.
ARCHER_CI_SPEED_CPUS=2 ARCHER_CI_SPEED_LOAD=0 ARCHER_CI_SPEED_THROTTLE=3 ARCHER_CI_SPEED_WORKERS=1 \
  ARCHER_CI_SPEED_REPEAT=4 FAIL_ON='ts run test:browser' run scripts/pr-check.sh --ci-speed -- hot-swap
expect_status 1 "--ci-speed with a failing ts suite"
grep -q 'shard=1/2' "$TRACE" || fail "a failing ts suite skipped the first half"
grep -q '^npm --workspace ui run test:browser:ts -- --forbid-only --repeat-each=4 --pass-with-no-tests hot-swap --workers=1 --shard=2/2 throttle=3$' "$TRACE" || fail "--ci-speed tuned call"
grep -q '^npm --workspace ts run test:browser -- --forbid-only --repeat-each=4 --pass-with-no-tests hot-swap throttle=$' "$TRACE" || fail "--ci-speed filtered ts call"
grep -q '^taskset -c 6-7$' "$TRACE" || fail "ARCHER_CI_SPEED_CPUS"
! grep -q '^node -e' "$TRACE" || fail "ARCHER_CI_SPEED_LOAD=0 started a hog"
grep -q 'pr-check --ci-speed: FAIL' "$tmp/out" || fail "--ci-speed failure verdict"
ARCHER_CI_SPEED_CPUS=9 run scripts/pr-check.sh --ci-speed
expect_status 2 "--ci-speed on more CPUs than there are"
run scripts/pr-check.sh -- hot-swap
expect_status 2 "a filter without --ci-speed"

# A changed vitest file beside the browser tests (support/*.test.ts) is a unit test, never an e2e file:
# handed to Playwright it is loaded as a test and the whole browser suite fails to start (O298).
mkdir -p ui/tests/browser-ts/support
printf 'it("s")\n' > ui/tests/browser-ts/support/s.test.ts
git add ui/tests/browser-ts/support/s.test.ts && git commit -qm 'a vitest file beside the browser tests'
# The hook, installed as hooks:install does.
git config --local core.hooksPath .githooks
run scripts/pr-check.sh
expect_status 0 "stamp the feature tip"
# The changed e2e file goes first in the browser suite (its config reads ARCHER_E2E_FIRST); only e2e files.
grep -q '^npm --workspace ui run test:browser:ts -- --forbid-only --max-failures=3 throttle= first=b.e2e.ts$' "$TRACE" || fail "changed e2e file not first, or a non-e2e file passed to the browser suite"
run git push -q origin feature
expect_status 0 "push a stamped branch"
printf 'it("a3")\n' > ui/tests/a.test.tsx && git commit -qam 'unstamped'
run git push -q origin feature
expect_status 1 "push an unstamped branch"
grep -q 'has not passed pr-check' "$tmp/out"
grep -q 'npm run pr-check' "$tmp/out"
grep -q 'git push --no-verify' "$tmp/out"
run git push -q --no-verify origin feature
expect_status 0 "--no-verify"
git tag -a v9.9.9 -m v9.9.9
run git push -q origin v9.9.9
expect_status 0 "push a tag"
run git push -q origin --delete feature
expect_status 0 "delete a branch"
# Two refs at once: the stamped one passes, the unstamped one refuses the push.
git branch stamped "$(git log -1 --format=%H HEAD~1)"
run git push -q origin stamped feature
expect_status 1 "one unstamped ref among two"
# A worktree shares the stamps (git-common-dir).
git worktree add -q "$tmp/wt" -b wt-branch feature
mkdir "$tmp/wt/node_modules"
(cd "$tmp/wt" && run scripts/pr-check.sh && expect_status 0 "pr-check in a worktree" && run git push -q origin wt-branch && expect_status 0 "push from a worktree")
# A docs-only branch (CI's rule) needs no stamp; one code file among docs does.
git switch -q -c docs-only origin/main
mkdir -p docs && printf '# x\n' > docs/x.md && git add docs/x.md && git commit -qm 'docs only'
run git push -q origin docs-only
expect_status 0 "push an unstamped docs-only branch"
printf 'it("d")\n' > ui/tests/d.test.tsx && git add ui/tests/d.test.tsx && git commit -qm 'and a test'
run git push -q origin docs-only
expect_status 1 "push an unstamped branch with docs and code"
git switch -q feature
git config --local --unset core.hooksPath

echo "pr-check and pre-push hook: PASS"
