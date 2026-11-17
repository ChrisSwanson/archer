#!/usr/bin/env bash
#
# ShellCheck over every tracked shell script, at warning severity: scripts/, the Git hooks,
# .forgejo/'s helpers, the public install script and the ts eval helper. docs/ is left out: its
# scripts are kept research evidence, run once.
#
# Usage: npm run lint:shell
#
# Skips with a message when ShellCheck is not installed (brew or apt-get install it),
# unless ARCHER_SHELLCHECK_REQUIRED=1, as CI sets it: its image has ShellCheck.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v shellcheck >/dev/null; then
  if [[ "${ARCHER_SHELLCHECK_REQUIRED:-}" == 1 ]]; then
    echo "shellcheck: not installed, and ARCHER_SHELLCHECK_REQUIRED=1" >&2
    exit 1
  fi
  echo "shellcheck: not installed; shell lint skipped (brew install shellcheck)"
  exit 0
fi

# while-read, not mapfile: macOS ships bash 3.2.
files=()
while IFS= read -r file; do
  case "$file" in
    docs/*) ;;
    *.sh | .githooks/*) files+=("$file") ;;
  esac
done < <(git ls-files)
shellcheck -S warning "${files[@]}"
echo "shellcheck: ${#files[@]} scripts, no warnings"
