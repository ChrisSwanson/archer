#!/usr/bin/env bash
#
# Print the CHANGELOG.md section for one version: the lines under `## X.Y.Z ...` up to the next
# `## ` heading, without the heading and the blank lines around it. Fails when there is none.
#
# Usage: scripts/release-notes.sh <X.Y.Z> [changelog]      (changelog defaults to ./CHANGELOG.md)
set -euo pipefail

version="${1:-}" changelog="${2:-CHANGELOG.md}"
[[ -n "$version" ]] || { echo "release-notes: usage: $0 <X.Y.Z> [changelog]" >&2; exit 2; }
[[ -r "$changelog" ]] || { echo "release-notes: cannot read $changelog" >&2; exit 1; }

# The version is compared as a string, never as a pattern: 0.6.4 must not match 0.6.40 or 0x6y4.
notes="$(awk -v want="$version" '
  /^## / { if (inside) exit; inside = ($2 == want); next }
  inside { line[++n] = $0 }
  END {
    first = 1; while (first <= n && line[first] ~ /^[[:space:]]*$/) first++
    last = n; while (last >= first && line[last] ~ /^[[:space:]]*$/) last--
    for (i = first; i <= last; i++) print line[i]
  }
' "$changelog")"

[[ -n "${notes//[[:space:]]/}" ]] || { echo "release-notes: $changelog has no section for $version" >&2; exit 1; }
printf '%s\n' "$notes"
