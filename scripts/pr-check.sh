#!/usr/bin/env bash
#
# The gates CI's required jobs run, on this exact commit, before it is pushed for a PR.
#
# Usage:
#   npm run pr-check                  size check, then every gate; stamps the commit's tree
#   npm run pr-check -- --allow-large run although HEAD is not based on the current origin/main
#   npm run pr-check -- --stress      rerun only the test files changed vs origin/main, under load
#   npm run pr-check -- --ci-speed [-- <playwright args>]
#                                     both browser suites whole, at CI's pace
#
# Run it once per batch, when the PR's work is complete, not per commit: while iterating, run the
# changed test files directly (.agents/skills/archer-pr-flow).
#
# Why: CI's browser suite takes ~30 min on the shared runner. O26 failed there because the full
# suite had never run on the pushed commit; O20-O25 read the page one step too early and failed
# only under runner load (docs/known-failures.md).
#
# Gates, cheapest first, stopping at the first failure: the scripts' contract tests, format and
# lint (Biome, biome.jsonc) and shell lint (ShellCheck, at once), ts, ui and site typechecks (at once), ui build, ts bundle, ui tests and ts tests (at once, each
# on ARCHER_PR_CHECK_UNIT_WORKERS workers, default 6), the ts service browser suite, the full browser
# suite (the changed e2e files first). Steps run at once write their own logs, printed whole when
# both end; a failing one fails the gate by name and keeps its log.
# The commands are ci.yml's (keep them in step), run directly rather than in its container.
#
# On success it writes a stamp named by the HEAD tree hash under
# $(git rev-parse --git-common-dir)/archer-pr-check/, which .githooks/pre-push looks for. A dirty
# tree is refused: the stamp must describe a commit.
#
# --stress runs ui and ts unit files 5 times under CPU hogs and browser files with --repeat-each=5,
# more workers than CPUs and Chromium's CPU throttled (ARCHER_E2E_CPU_THROTTLE), and reports
# the failure rate. It writes no stamp. Tune with ARCHER_STRESS_WORKERS, ARCHER_STRESS_THROTTLE.
#
# Every mode first checks that TMPDIR has ARCHER_MIN_TMP_GB free (6 GB; a plain run ran out at 2.5)
# and stops if not: a full TMPDIR fails tests at random (O261, O270).
#
# --ci-speed runs CI's browser suites (the ts service suite, which CI runs in its unit job, and the
# ui suite in two shards of 2 workers each, at the suites' own timeouts) at about CI's speed, for timing bugs that only the
# slow, shared runner shows: O181 (a race in the service) and O182 (a figure drawn late) failed a CI
# run after pr-check and --stress passed. The two shards run at once, as CI's runners do, all
# pinned with taskset to the last ARCHER_CI_SPEED_CPUS CPUs (4) beside ARCHER_CI_SPEED_LOAD CPU
# hogs (1), so the service and the test processes slow too, not only the page; Chromium is also
# throttled ARCHER_CI_SPEED_THROTTLE times (2). ARCHER_CI_SPEED_WORKERS (2) is per shard, and
# ARCHER_CI_SPEED_REPEAT (1) is --repeat-each. Arguments after -- go to both suites (a file filter,
# --grep). It builds the page, reports each part and the median test time, and writes no stamp:
# it is evidence about timing, not the gate. It uses 4 of the machine's CPUs, so other work here
# slows it further (the whole suite takes most of an hour beside other test runs).
# Calibration (2026-11-03, 142 tests of 5 files against one CI shard, durations per test): the
# local default ran at 0.44x CI's time, 2 hogs at 1.18x, 1 hog at 1.06x; the whole suite on a busy
# host at 1.2x-2.9x. Proof: before the O181 fix `ARCHER_CI_SPEED_REPEAT=20 ... -- hot-swap` failed
# 3 of 20 with CI's "the Archer service closed the connection", and 0 of 20 after it. O182 did not
# recur (0 of 20 either way). Retune when the runner or the suite changes.
set -euo pipefail

allow_large=0
stress=0
ci_speed=0
filters=()
while (( $# )); do
  case "$1" in
    --allow-large) allow_large=1 ;;
    --stress) stress=1 ;;
    --ci-speed) ci_speed=1 ;;
    --) shift; filters=("$@"); break ;;
    -h|--help) sed -n '3,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "pr-check: unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
if (( ${#filters[@]} && ! ci_speed )); then
  echo "pr-check: arguments after -- are for --ci-speed only" >&2; exit 2
fi
if (( stress && ci_speed )); then
  echo "pr-check: --stress and --ci-speed are separate runs; pick one" >&2; exit 2
fi
# The two unit suites run at once, each on this many workers (CI runs them apart at 2 and 3).
unit_workers="${ARCHER_PR_CHECK_UNIT_WORKERS:-6}"
if [[ ! "$unit_workers" =~ ^[1-9][0-9]*$ ]]; then
  echo "pr-check: ARCHER_PR_CHECK_UNIT_WORKERS must be a positive number, not '$unit_workers'" >&2; exit 2
fi

cd "$(dirname "$0")/.."
base=origin/main

say() { printf '%s\n' "$*"; }
seconds() { date +%s; }
elapsed() { local s=$(( $(seconds) - $1 )); printf '%dm%02ds' $((s / 60)) $((s % 60)); }
# Each process and everything under it (npm, vitest, Playwright, the service, Chromium), leaves first.
# pgrep prints one pid per line: the unquoted expansion splits them into arguments.
# shellcheck disable=SC2046
stop_tree() { local pid; for pid in "$@"; do stop_tree $(pgrep -P "$pid" || true); kill "$pid" 2>/dev/null || true; done; }

if ! git fetch -q origin main; then
  say "pr-check: WARNING: could not fetch origin; checking against the last fetched $base" >&2
fi

# --- Size ---------------------------------------------------------------------------------
commits="$(git rev-list --count "$base..HEAD")"
shortstat="$(git diff --shortstat "$base...HEAD")"
say "pr-check: $commits commit(s) on $base;${shortstat:- no change}"
if [[ "$(git merge-base HEAD "$base")" != "$(git rev-parse "$base")" ]]; then
  if (( allow_large )); then
    say "pr-check: HEAD is not based on the current $base (--allow-large: going on)" >&2
  else
    say "pr-check: HEAD is not based on the current $base. Rebase first: git rebase $base" >&2
    say "          (the count above then shows this PR's commits only; --allow-large overrides)" >&2
    exit 1
  fi
fi

changed_tests() {
  git diff --name-only --diff-filter=d "$base" -- 'ui/tests/**' 'ts/test/**' |
    grep -E '^(ui/tests/(.*\.test\.tsx?|browser-ts/.*\.e2e\.ts)|ts/test/.*\.test\.ts)$' || true
}

# A new worktree has no node_modules: every gate would fail at once with "tsc: not found".
if [[ ! -d node_modules ]]; then
  say "pr-check: no node_modules here (a new worktree or clone?). Run npm ci first." >&2
  exit 1
fi

# Every browser profile, trace and test project lives in TMPDIR: a run that fills it fails tests at
# random with ENOSPC, crashed pages and closed contexts (O261, O270). Refuse before starting.
min_tmp_gb="${ARCHER_MIN_TMP_GB:-6}"
free_tmp_kb="$(df -Pk "${TMPDIR:-/tmp}" | awk 'NR == 2 { print $4 }')"
if (( free_tmp_kb < min_tmp_gb * 1024 * 1024 )); then
  say "pr-check: only $(( free_tmp_kb / 1024 )) MB free in ${TMPDIR:-/tmp}; this run needs ${min_tmp_gb} GB (ARCHER_MIN_TMP_GB)." >&2
  say "          Free space first: tests fail at random when it runs out (O261)." >&2
  exit 1
fi

# --- Stress ---------------------------------------------------------------------------------
if (( stress )); then
  # while-read, not mapfile: macOS ships bash 3.2.
  files=()
  while IFS= read -r line; do [[ -n "$line" ]] && files+=("$line"); done < <(changed_tests)
  if (( ${#files[@]} == 0 )); then
    say "pr-check --stress: no test file changed vs $base; nothing to stress"
    exit 0
  fi
  cpus="$(getconf _NPROCESSORS_ONLN)"   # nproc is GNU coreutils; getconf is on Linux and macOS
  # Calibrated on a many-core host: 1.5 workers per CPU at 4x throttling failed about half the runs,
  # mostly on the 45 s timeout (overload, not ordering); CPUs + 2 at 2x with the timeout doubled
  # passed every run.
  workers="${ARCHER_STRESS_WORKERS:-$(( cpus + 2 ))}"
  throttle="${ARCHER_STRESS_THROTTLE:-2}"
  units=() browsers=() ts_units=()
  for file in "${files[@]}"; do
    case "$file" in
      ui/tests/browser-ts/*) browsers+=("${file#ui/}") ;;
      ts/test/*) ts_units+=("${file#ts/}") ;;
      *) units+=("${file#ui/}") ;;
    esac
  done
  status=0
  stress_dir="$(mktemp -d "${TMPDIR:-/tmp}/archer-pr-stress.XXXXXX")"
  say "pr-check --stress: logs in $stress_dir"
  if (( ${#units[@]} )); then
    say "==> ui unit, 5 runs, load $cpus, $workers workers: ${units[*]}"
    started="$(seconds)"
    node ui/scripts/repeat-suite.mjs --runs 5 --load "$cpus" --log-dir "$stress_dir/unit" \
      -- npx vitest run --maxWorkers="$workers" "${units[@]}" > "$stress_dir/unit.log" 2>&1 || status=1
    grep -E '^(run [0-9]+: FAILED|FAILED TESTS|  +[0-9]+  |RATE|VERDICT)' "$stress_dir/unit.log" || true
    say "    ($(elapsed "$started"))"
  fi
  if (( ${#ts_units[@]} )); then
    # repeat-suite runs its command in ui/, so vitest is pointed at ts/ and its config.
    say "==> ts unit, 5 runs, load $cpus, $workers workers: ${ts_units[*]}"
    started="$(seconds)"
    node ui/scripts/repeat-suite.mjs --runs 5 --load "$cpus" --log-dir "$stress_dir/ts" \
      -- npx vitest run --root ../ts --maxWorkers="$workers" "${ts_units[@]}" > "$stress_dir/ts.log" 2>&1 || status=1
    grep -E '^(run [0-9]+: FAILED|FAILED TESTS|  +[0-9]+  |RATE|VERDICT)' "$stress_dir/ts.log" || true
    say "    ($(elapsed "$started"))"
  fi
  if (( ${#browsers[@]} )); then
    say "==> browser, --repeat-each=5, $workers workers on $cpus CPUs, CPU throttled ${throttle}x: ${browsers[*]}"
    started="$(seconds)"
    ARCHER_E2E_CPU_THROTTLE="$throttle" npm --workspace ui run test:browser:ts -- --forbid-only \
      --repeat-each=5 --workers="$workers" --timeout=$(( 45000 * throttle )) "${browsers[@]}" > "$stress_dir/browser.log" 2>&1 || status=1
    passed="$(grep -a -m 1 -oE '^ +[0-9]+ passed' "$stress_dir/browser.log" | tr -dc 0-9 || true)"
    failed="$(grep -a -m 1 -oE '^ +[0-9]+ failed' "$stress_dir/browser.log" | tr -dc 0-9 || true)"
    total=$(( ${passed:-0} + ${failed:-0} ))
    if (( total == 0 )); then
      say "    no test ran (see $stress_dir/browser.log)"; status=1
    else
      (( ${failed:-0} == 0 )) || status=1
      say "    $(( ${failed:-0} )) of $total test runs failed ($(( 100 * ${failed:-0} / total ))%)"
      grep -a -E '^ +✘ ' "$stress_dir/browser.log" | sed -E 's/^ +✘ +[0-9]+ //; s/ \([0-9.]+m?s\)$//; s/ \(retry #[0-9]+\)//' |
        sort | uniq -c | sort -rn | sed 's/^/    /' || true
    fi
    say "    ($(elapsed "$started"))"
  fi
  (( status == 0 )) && say "pr-check --stress: PASS" || say "pr-check --stress: FAIL (logs in $stress_dir)"
  exit "$status"
fi

# --- CI speed -------------------------------------------------------------------------------
if (( ci_speed )); then
  # Calibrated against a CI shard's timings (see the header).
  cpus="${ARCHER_CI_SPEED_CPUS:-4}"
  load="${ARCHER_CI_SPEED_LOAD:-1}"
  throttle="${ARCHER_CI_SPEED_THROTTLE:-2}"
  workers="${ARCHER_CI_SPEED_WORKERS:-2}"
  repeat="${ARCHER_CI_SPEED_REPEAT:-1}"
  available="$(nproc)"
  if (( cpus < 1 || cpus > available )); then
    say "pr-check --ci-speed: ARCHER_CI_SPEED_CPUS=$cpus, but $available CPU(s) are available" >&2; exit 2
  fi
  # The run and its hogs stay on the last $cpus CPUs; the rest of the machine stays free for other work.
  pinned="$(( available - cpus ))-$(( available - 1 ))"
  dir="$(mktemp -d "${TMPDIR:-/tmp}/archer-pr-ci-speed.XXXXXX")"
  say "pr-check --ci-speed: both CI shards at once on CPUs $pinned with $load CPU hog(s), $workers workers each, Chromium throttled ${throttle}x${filters[*]:+, filter: ${filters[*]}}; logs in $dir"
  started="$(seconds)"
  npm run build > "$dir/build.log" 2>&1 || { say "pr-check --ci-speed: ui build failed (see $dir/build.log)" >&2; exit 1; }
  extra=(--forbid-only)
  (( repeat > 1 )) && extra+=(--repeat-each="$repeat")
  # A filter may match nothing in one of the two suites.
  (( ${#filters[@]} )) && extra+=(--pass-with-no-tests "${filters[@]}")
  # The hog of ui/scripts/repeat-suite.mjs: it exits once its parent (this script) is gone.
  hog='const parent = process.ppid; for (;;) { const until = Date.now() + 250; while (Date.now() < until); if (process.ppid !== parent) process.exit(0); }'
  children=()
  stop() { stop_tree "${children[@]}"; }
  trap stop EXIT
  trap 'stop; trap - EXIT; say "pr-check --ci-speed: interrupted; no verdict" >&2; exit 130' INT TERM
  for (( i = 0; i < load; i++ )); do taskset -c "$pinned" node -e "$hog" & children+=($!); done
  # CI's browser suites: the ts service suite (CI's unit job), then the first half; and the second
  # half. A failing ts suite does not skip the first half: every part reports.
  part() { # name, then the command; its log and exit status land in $dir
    local name="$1" code=0; shift
    taskset -c "$pinned" "$@" > "$dir/$name.log" 2>&1 || code=$?
    echo "$code" > "$dir/$name.status"
  }
  ui_suite=(env ARCHER_E2E_CPU_THROTTLE="$throttle" npm --workspace ui run test:browser:ts -- "${extra[@]}" --workers="$workers")
  { part ts npm --workspace ts run test:browser -- "${extra[@]}"; part ui-1 "${ui_suite[@]}" --shard=1/2; } & children+=($!); first=$!
  part ui-2 "${ui_suite[@]}" --shard=2/2 & children+=($!); second=$!
  wait "$first" "$second" || true
  stop; trap - EXIT INT TERM
  status=0 ran=0
  for part in ts ui-1 ui-2; do
    log="$dir/$part.log"
    passed="$(grep -a -m 1 -oE '^ +[0-9]+ passed' "$log" | tr -dc 0-9 || true)"
    failed="$(grep -a -m 1 -oE '^ +[0-9]+ failed' "$log" | tr -dc 0-9 || true)"
    # The median test's time, to compare with CI's (about 5 s per test in a CI shard).
    median="$(grep -a -oE '^ +[✓✘] +[0-9]+ .* \(([0-9.]+)(ms|s|m)\)$' "$log" |
      sed -E 's/.*\(([0-9.]+)(ms|s|m)\)$/\1 \2/' |
      awk '{ print ($2 == "ms" ? $1 / 1000 : $2 == "m" ? $1 * 60 : $1) }' | sort -n |
      awk '{ a[NR] = $1 } END { if (NR) printf "%.1fs", a[int((NR + 1) / 2)] }' || true)"
    ran=$(( ran + ${passed:-0} + ${failed:-0} ))
    [[ "$(cat "$dir/$part.status" 2>/dev/null)" == 0 ]] || status=1
    say "==> $part: ${passed:-0} passed, ${failed:-0} failed${median:+, median test $median}"
    grep -a -E '^ +✘ ' "$log" | sed -E 's/^ +✘ +[0-9]+ //; s/ \([0-9.]+m?s\)$//' | sort | uniq -c | sort -rn | sed 's/^/    /' || true
  done
  (( ran > 0 )) || { say "    no test ran"; status=1; }
  say "pr-check --ci-speed: $( (( status == 0 )) && echo PASS || echo "FAIL (logs in $dir)") in $(elapsed "$started")"
  exit "$status"
fi

# --- Gates ----------------------------------------------------------------------------------
if [[ -n "$(git status --porcelain)" ]]; then
  say "pr-check: the working tree has uncommitted changes. Commit them first: the stamp names a commit." >&2
  git status --short >&2
  exit 1
fi
tree="$(git rev-parse 'HEAD^{tree}')"
head="$(git rev-parse HEAD)"

# `set -e` does not apply inside `if ! gate`, so each step returns on its own failure.
contract_tests() {
  local test
  for test in ci-docs-only pr-check; do
    scripts/${test}_test.sh || return 1
  done
}
ts_bundle() { npm --workspace ts run bundle && node ts/dist/archer.js --version; }
# The changed e2e files go first (ARCHER_E2E_FIRST, read by the browser suite's config): a likely
# failure shows minutes earlier. Only the order changes; every file still runs once.
# Only e2e files: a vitest file beside them (support/*.test.ts) handed to Playwright stops the suite (O298).
first_e2e="$(changed_tests | sed -n 's|^ui/tests/browser-ts/\(.*\.e2e\.ts\)$|\1|p' | tr '\n' ' ' | sed 's/ $//')"
browser_suite() { ARCHER_E2E_FIRST="$first_e2e" npm --workspace ui run test:browser:ts -- --forbid-only --max-failures=3; }

# A step starting with "+" runs alongside the one before it. Steps in a group are independent: the
# two typechecks, and the two unit suites at local worker counts (CI's caps are for its container's
# memory; this host has the CPUs). Each writes its own log, printed whole once the group ends, so
# their output never interleaves.
gates=(
  "scripts contract tests|contract_tests"
  "format and lint|npm run biome:ci"
  "+shell lint|npm run lint:shell"
  "ts typecheck|npm --workspace ts run typecheck"
  "+ui typecheck|npm --workspace ui run typecheck"
  "+site typecheck|npm run typecheck:site"
  "ui build|npm run build"
  "ts bundle|ts_bundle"
  "ui tests|npm --workspace ui test -- --maxWorkers=$unit_workers"
  "+ts tests|npm --workspace ts test -- --maxWorkers=$unit_workers"
  "ts browser suite|npm --workspace ts run test:browser -- --forbid-only"
  "browser suite|browser_suite"
  "docs build|npm run docs:build"
  "site browser suite|npm run docs:test:browser"
  "+playground browser suite|npm --workspace ui run test:playground"
)
total_started="$(seconds)"
summary=()
logs="$(mktemp -d "${TMPDIR:-/tmp}/archer-pr-check.XXXXXX")"
pids=()
trap 'stop_tree "${pids[@]}"; trap - EXIT; say "pr-check: interrupted; no stamp" >&2; exit 130' INT TERM
fail() { # what failed, when the step started
  say "pr-check: FAILED at $1 after $(elapsed "$2") (total $(elapsed "$total_started")); no stamp" >&2
  exit 1
}
# One step, in the background, into its log; its exit status and seconds land beside it.
step() { # index, then the command
  local index="$1" started code=0; shift
  started="$(seconds)"
  eval "$*" > "$logs/$index.log" 2>&1 < /dev/null || code=$?
  echo "$code $(( $(seconds) - started ))" > "$logs/$index.status"
}
index=0
while (( index < ${#gates[@]} )); do
  group=("${gates[index]}")
  while (( index + ${#group[@]} < ${#gates[@]} )) && [[ "${gates[index + ${#group[@]}]}" == +* ]]; do
    group+=("${gates[index + ${#group[@]}]#+}")
  done
  first=$((index + 1))
  index=$((index + ${#group[@]}))
  started="$(seconds)"
  if (( ${#group[@]} == 1 )); then
    name="${group[0]%%|*}" command="${group[0]#*|}"
    say "==> [$first/${#gates[@]}] $name"
    eval "$command" || fail "$name" "$started"
    summary+=("$(printf '%-24s %s' "$name" "$(elapsed "$started")")")
    continue
  fi
  names=() pids=()
  for (( i = 0; i < ${#group[@]}; i++ )); do
    names+=("${group[i]%%|*}")
    step $((first + i)) "${group[i]#*|}" & pids+=($!)
  done
  say "==> [$first-$index/${#gates[@]}] in parallel: $(IFS=,; echo "${names[*]}" | sed 's/,/, /g') (logs in $logs)"
  wait "${pids[@]}" || true
  pids=()
  failed=()
  for (( i = 0; i < ${#group[@]}; i++ )); do
    read -r code took < "$logs/$((first + i)).status" || { code=1 took=0; }
    say "==> [$((first + i))/${#gates[@]}] ${names[i]} ($(elapsed $(( $(seconds) - took ))))"
    cat "$logs/$((first + i)).log"
    if [[ "$code" != 0 ]]; then
      failed+=("${names[i]}")
      say "pr-check: ${names[i]} failed (exit $code); its log: $logs/$((first + i)).log" >&2
    fi
    summary+=("$(printf '%-24s %s' "${names[i]}" "$(elapsed $(( $(seconds) - took )))")")
  done
  (( ${#failed[@]} == 0 )) || fail "$(IFS=,; echo "${failed[*]}" | sed 's/,/, /g')" "$started"
done
trap - INT TERM
rm -rf "$logs"

if [[ -n "$(git status --porcelain)" || "$(git rev-parse 'HEAD^{tree}')" != "$tree" ]]; then
  say "pr-check: the tree changed while the gates ran; no stamp. Run it again on the commit to push." >&2
  exit 1
fi
stamps="$(git rev-parse --git-common-dir)/archer-pr-check"
mkdir -p "$stamps"
{
  printf 'tree %s\ncommit %s\nbase %s\ndate %s\ntotal %s\n' "$tree" "$head" "$(git rev-parse "$base")" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(elapsed "$total_started")"
  printf '%s\n' "${summary[@]}"
} > "$stamps/$tree"
printf '%s\n' "${summary[@]}"
say "pr-check: PASS in $(elapsed "$total_started"); stamped tree ${tree:0:12} ($stamps/$tree)"
if [[ -n "$(changed_tests)" ]]; then
  say "pr-check: test files changed; also run: npm run pr-check -- --stress"
fi
