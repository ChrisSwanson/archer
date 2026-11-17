#!/usr/bin/env bash
# The docs-only classifier CI's `changes` job uses (scripts/ci-docs-only.sh), and a guard: no
# test or tool in ts/test, ui/tests or tools reads a path under docs/ or .agents/skills/ that would count as
# docs-only, since a change to it would then skip the gates that read it.
set -euo pipefail

cd "$(dirname "$0")/.."
root="$(pwd -P)"
classify() { printf '%s\n' "$@" | scripts/ci-docs-only.sh; }
is() { local want="$1"; shift; local got; got="$(classify "$@")"; [[ "$got" == "$want" ]] || { echo "ci-docs-only_test: expected $want for: $*" >&2; exit 1; }; }

is true docs/proposals/x.md
is true docs/guides/nested/NOTES.md docs/adr/0001-x.md
is true docs/prototypes/emphasis/index.html docs/prototypes/a.js docs/x.md
is true .agents/skills/archer-pr-flow/SKILL.md docs/proposals/x.md
for other in docs/supported-mermaid.md ts/src/a.ts ui/src/a.tsx tools/devkit/a.mjs scripts/ship.sh .forgejo/workflows/ci.yml \
  package.json package-lock.json README.md AGENTS.md .agents/skills/x/run.sh .agents/skills.md .claude/skills \
  docs/evaluations/baseline/small-agents.json docs/evaluations/pilot/summarise.mjs docs/a.mmd \
  docs/tls.md.bak docs/diagram.svg docs/install.md docs/tls.md; do
  is false docs/proposals/x.md "$other"
  is false "$other"
done
is false
is false ""

# --diff: a docs-only commit, a mixed one, and a missing base.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git init -q -b main "$tmp/repo"
(
  cd "$tmp/repo"
  git config user.name t; git config user.email t@example.invalid; git config commit.gpgsign false
  mkdir -p docs ts scripts && cp "$root/scripts/ci-docs-only.sh" scripts/ && echo a > docs/a.md && echo b > ts/b.ts && git add . && git commit -qm base
  base="$(git rev-parse HEAD)"
  echo a2 > docs/a.md && git commit -qam docs
  [[ "$("$root/scripts/ci-docs-only.sh" --diff "$base" 2>/dev/null)" == true ]]
  git mv ts/b.ts docs/b.md && git commit -qm 'move into docs'
  [[ "$("$root/scripts/ci-docs-only.sh" --diff "$base" 2>/dev/null)" == false ]]
  [[ "$("$root/scripts/ci-docs-only.sh" --diff 0123456789abcdef0123456789abcdef01234567 2>/dev/null)" == false ]]
  [[ "$("$root/scripts/ci-docs-only.sh" --diff "" 2>/dev/null)" == false ]]
  [[ "$("$root/scripts/ci-docs-only.sh" --diff HEAD 2>/dev/null)" == false ]] # empty change
) || { echo "ci-docs-only_test: --diff cases failed" >&2; exit 1; }

# The guard. A reference is a `docs/...` or `.agents/skills/...` path (or "docs", "a", "b" segments)
# outside a comment that names an existing file or folder under the repository's docs/ or .agents/skills/.
references() {
  python3 - "$root" "$@" <<'PY'
import os, re, sys
root, places = sys.argv[1], sys.argv[2:]
token = re.compile(r"(?<![\w./~-])[\w./~-]*?(?:docs|\.agents/skills)/[\w./*-]+")
segments = re.compile(r"""["']docs["']((?:\s*,\s*["'][\w.-]+["'])+)""")
found = set()
for place in places:
    for directory, subdirs, files in os.walk(place):
        # Not dependencies, nor the docs site's build output and cache (generated, not read by a gate).
        subdirs[:] = [d for d in subdirs if d not in ("node_modules", "dist", "cache")]
        for name in files:
            if not name.endswith((".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs")):
                continue
            for line in open(os.path.join(directory, name), encoding="utf-8", errors="replace"):
                stripped = line.lstrip()
                if stripped.startswith(("//", "*", "/*", "#")):
                    continue
                code = line.split(" // ")[0]
                candidates = [m.group(0) for m in token.finditer(code)]
                candidates += ["docs/" + "/".join(re.findall(r"""["']([\w.-]+)["']""", m.group(1))) for m in segments.finditer(code)]
                for candidate in candidates:
                    # ../docs/x is relative to the file; a bare docs/x could be relative to anything, so
                    # it counts as the repository's (the cautious reading).
                    # A checkout named archer (~/code/archer/docs/x) is this repository.
                    for inside in ("archer/docs/", "archer/.agents/skills/"):
                        if inside in candidate:
                            candidate = candidate[candidate.index(inside) + len("archer/"):]
                    if candidate.startswith("../"):
                        target = os.path.normpath(os.path.join(directory, candidate))
                    else:
                        target = os.path.normpath(os.path.join(root, candidate))
                    path = os.path.relpath(target, root).rstrip("/")
                    if path.startswith(("docs/", ".agents/skills/")) and os.path.exists(os.path.join(root, path)):
                        found.add(path)
print("\n".join(sorted(found)))
PY
}
# while-read, not mapfile: macOS ships bash 3.2, which has no mapfile (and errors on an empty "${a[@]}" under set -u).
found=()
while IFS= read -r line; do [[ -n "$line" ]] && found+=("$line"); done < <(references ts/test ui/tests tools site/scripts site/.vitepress)
bad=()
for path in ${found[@]+"${found[@]}"}; do
  [[ "$(classify "$path")" == false ]] || bad+=("$path")
done
if (( ${#bad[@]} )); then
  echo "ci-docs-only_test: tests or tools read these paths, which ci-docs-only.sh calls docs-only:" >&2
  printf '  %s\n' "${bad[@]}" >&2
  echo "narrow the allow-list in scripts/ci-docs-only.sh, or move the file out of docs/" >&2
  exit 1
fi
# Every page source the docs site publishes (site/scripts/documents.mts) runs the gates, and the guard sees them.
sources=()
while IFS= read -r line; do [[ -n "$line" ]] && sources+=("$line"); done < <(
  grep -oE 'source: *"(docs|\.agents/skills)/[^"]+"' site/scripts/documents.mts | sed -E 's/^source: *"//; s/"$//')
(( ${#sources[@]} )) || { echo "ci-docs-only_test: found no docs/ sources in site/scripts/documents.mts" >&2; exit 1; }
for path in "${sources[@]}"; do
  [[ "$(classify "$path")" == false ]] || { echo "ci-docs-only_test: the docs site publishes $path, which ci-docs-only.sh calls docs-only" >&2; exit 1; }
  printf '%s\n' "${found[@]}" | grep -qx "$path" || { echo "ci-docs-only_test: the guard does not see the site's read of $path" >&2; exit 1; }
done
# The guard would flag a .md read the same way as a data read.
mkdir -p "$tmp/probe"
cat > "$tmp/probe/reads.test.ts" <<'TS'
// docs/tls.md in a comment is not a read.
const baseline = readFileSync(join(ROOT, "docs/evaluations/baseline/small-agents.json"), "utf8");
const notes = readFileSync(join(ROOT, "docs", "evaluations", "eval-baseline.md"), "utf8");
const skill = readFileSync(join(ROOT, ".agents/skills/archer-pr-flow/SKILL.md"), "utf8");
TS
# The probe's targets exist in a tree of its own, so it does not depend on what this repository holds.
mkdir -p "$tmp/probe-root/docs/evaluations/baseline" "$tmp/probe-root/.agents/skills/archer-pr-flow"
touch "$tmp/probe-root/docs/evaluations/baseline/small-agents.json" "$tmp/probe-root/docs/evaluations/eval-baseline.md" \
  "$tmp/probe-root/.agents/skills/archer-pr-flow/SKILL.md"
probe=()
while IFS= read -r line; do [[ -n "$line" ]] && probe+=("$line"); done < <(root="$tmp/probe-root" references "$tmp/probe")
[[ "${probe[*]}" == ".agents/skills/archer-pr-flow/SKILL.md docs/evaluations/baseline/small-agents.json docs/evaluations/eval-baseline.md" ]] ||
  { echo "ci-docs-only_test: guard probe found: ${probe[*]}" >&2; exit 1; }
[[ "$(classify "${probe[0]}")" == true && "$(classify "${probe[2]}")" == true && "$(classify "${probe[1]}")" == false ]] ||
  { echo "ci-docs-only_test: the probe's .md read would not be flagged" >&2; exit 1; }

# (The checks of the CI workflow that runs this classifier live with that workflow, which is not part of this tree.)
echo "ci docs-only classifier and guard: PASS (${#found[@]} docs/ paths read by tests and tools, none docs-only)"
