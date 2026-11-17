#!/usr/bin/env bash
#
# Whether a change touches only documentation that no gate reads, so CI may skip its gates.
#
#   scripts/ci-docs-only.sh < paths      one changed path per line; prints true or false
#   scripts/ci-docs-only.sh --diff BASE  the change BASE...HEAD; prints true or false
#
# Docs-only means every path matches the allow-list below (docs/ and the repo skills'
# Markdown), and nothing else does: not other
# files under docs/ (ts/test/evals reads docs/evaluations/baseline/*.json, and
# docs/evaluations/pilot/summarise.mjs is a script), and not a page the docs site publishes (docs/install.md,
# docs/tls.md: site/scripts/documents.mts). An empty list, a failed diff or a missing
# base is false, so in doubt everything runs. scripts/ci-docs-only_test.sh pins it and checks
# that no test reads a path it would call docs-only.
set -uo pipefail

# The pages the docs site builds from docs/ (the `source:` entries of site/scripts/documents.mts): a change to one
# changes the published site, so it runs the gates. Read from the inventory itself, so a new page needs no edit here.
site_sources="$(grep -oE 'source: *"[^"]+"' "$(dirname "$0")/../site/scripts/documents.mts" 2>/dev/null |
  sed -E 's/^source: *"//; s/"$//')"

docs_only_path() {
  if [[ -n "$site_sources" ]] && grep -qxF -- "$1" <<<"$site_sources"; then return 1; fi
  case "$1" in
    # Shares its name with ts/docs/supported-mermaid.md, which tests read as "docs/supported-mermaid.md"
    # relative to ts/ or the bundle; the guard cannot tell the two apart, so it runs everything.
    docs/supported-mermaid.md) return 1 ;;
    # Frozen rubrics are test specifications: the round tools and tests name them, so a change runs CI.
    docs/quality/rubrics/*) return 1 ;;
    docs/prototypes/*) return 0 ;;
    docs/*.md) return 0 ;; # any depth: `*` crosses `/` in a case pattern
    .agents/skills/*.md) return 0 ;; # repo skills: instructions for agents; no gate reads them
    *) return 1 ;;
  esac
}

classify() {
  local path seen=0
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    seen=1
    docs_only_path "$path" || { echo false; return; }
  done
  (( seen )) && echo true || echo false
}

if [[ "${1:-}" == --diff ]]; then
  base="${2:-}"
  if [[ -z "$base" ]] || ! git rev-parse -q --verify "$base^{commit}" >/dev/null; then
    echo "ci-docs-only: no base commit '${base}'; running everything" >&2
    echo false; exit 0
  fi
  # --no-renames: a file moved into docs/ also shows the path it left.
  if ! paths="$(git diff --name-only --no-renames "$base...HEAD")"; then
    echo "ci-docs-only: the diff against $base failed; running everything" >&2
    echo false; exit 0
  fi
  printf '%s\n' "$paths" >&2
  printf '%s\n' "$paths" | classify
  exit 0
fi
classify
