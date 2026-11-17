#!/usr/bin/env bash
#
# Install a built package into a throwaway prefix and check that `archer --version` says X.Y.Z.
#
# Usage: scripts/release-smoke.sh <archer-X.Y.Z.tgz> <X.Y.Z>
#
# HOME, the npm cache and config, and the XDG folders all point into a temporary folder, and npm
# runs --offline (the package has no dependencies), so nothing reads or writes the runner's real
# HOME and nothing is fetched. `--version` starts no service.
set -euo pipefail

tgz="${1:-}" version="${2:-}"
[[ -f "$tgz" && -n "$version" ]] || { echo "release-smoke: usage: $0 <archer-X.Y.Z.tgz> <X.Y.Z>" >&2; exit 2; }
tgz="$(cd "$(dirname "$tgz")" && pwd -P)/$(basename "$tgz")"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/archer-release-smoke.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home" "$tmp/prefix"
isolated=(env HOME="$tmp/home" XDG_CONFIG_HOME="$tmp/home/.config" XDG_STATE_HOME="$tmp/home/.local/state"
  XDG_DATA_HOME="$tmp/home/.local/share" XDG_CACHE_HOME="$tmp/home/.cache" ARCHER_STATE_DIR="$tmp/state"
  npm_config_cache="$tmp/npm-cache" npm_config_userconfig="$tmp/npmrc" npm_config_globalconfig="$tmp/npmrc-global")

(cd "$tmp" && "${isolated[@]}" npm install --global --prefix "$tmp/prefix" --offline --no-audit --no-fund \
  --loglevel=error "$tgz") >"$tmp/install.log" 2>&1 ||
  { cat "$tmp/install.log" >&2; echo "release-smoke: npm could not install $(basename "$tgz")" >&2; exit 1; }

archer="$tmp/prefix/bin/archer"
[[ -x "$archer" ]] || { echo "release-smoke: the package installed no archer command" >&2; exit 1; }
got="$(cd "$tmp" && "${isolated[@]}" "$archer" --version)" || { echo "release-smoke: archer --version failed" >&2; exit 1; }
[[ "$got" == "$version" ]] || { echo "release-smoke: archer --version says '$got', expected $version" >&2; exit 1; }
echo "release-smoke: $(basename "$tgz") installs and reports $got"
