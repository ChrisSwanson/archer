#!/usr/bin/env bash
# Build the Archer package, and optionally install it here or on another machine.
#
#   scripts/ship.sh                 build dist/archer-<version>.tgz
#   scripts/ship.sh --check         run the quick release check first
#   scripts/ship.sh --here          build, then install it on this machine
#   scripts/ship.sh --to <ssh-host> build, copy it to <ssh-host>:~ and install it there
#   scripts/ship.sh --out <dir>     put the tgz in <dir> instead of dist/
#
# Installing runs `archer upgrade <tgz>` where the package is already installed (a hot swap:
# open pages stay open), and `npx --yes --package <tgz> archer setup` the first time (which also moves a
# development install over). Rebuilding the same version is fine: each build installs as new.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
out="$repo/dist" check=0 here=0 to=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) check=1 ;;
    --here) here=1 ;;
    --to) to=${2:?--to needs an ssh host}; shift ;;
    --out) out=${2:?--out needs a folder}; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

cd "$repo"
step() { printf '\n== %s\n' "$*"; }

if [ "$check" = 1 ]; then
  step "quick release check"
  npm run release-check:quick
fi

step "building the package"
mkdir -p "$out"
log="$out/build.log"
if ! npm --workspace ts run package -- "$out" >"$log" 2>&1; then tail -40 "$log"; echo "build failed; full log: $log" >&2; exit 1; fi
tail -2 "$log"
tgz="$out/archer-$(node -p 'require("./ts/package.json").version').tgz"
[ -f "$tgz" ] || { echo "no package at $tgz" >&2; exit 1; }

# Upgrade when the package is installed, otherwise first-time setup. Runs locally or over ssh.
install_cmd='set -e
tgz=$1
PATH="${ARCHER_BIN_DIR:-$HOME/.local/bin}:$PATH"
if [ -e "${XDG_DATA_HOME:-$HOME/.local/share}/archer/.archer-setup" ]; then
  # From a copy outside this checkout: an installed 0.6.1 `archer upgrade` runs npm in the
  # package folder, and inside an npm project npm resolves the file against the project root.
  stage=$(mktemp -d "${TMPDIR:-/tmp}/archer-ship-XXXXXX")
  cp "$tgz" "$stage/"
  status=0
  archer upgrade "$stage/$(basename "$tgz")" || status=$?
  rm -rf "$stage"
  [ "$status" = 0 ] || exit "$status"
else
  # Absolute, and run outside any npm project: inside one (this checkout) npm resolves a relative
  # file spec against that project root, not the current folder, and finds no package.
  tgz=$(cd "$(dirname "$tgz")" && pwd)/$(basename "$tgz")
  cd "${TMPDIR:-/tmp}" && npx --yes --package "$tgz" archer setup
fi
archer status'

if [ "$here" = 1 ]; then
  step "installing on this machine"
  bash -c "$install_cmd" install "$tgz"
fi

if [ -n "$to" ]; then
  step "copying to $to"
  scp -q "$tgz" "$to:"
  step "installing on $to"
  # A login shell, so node and ~/.local/bin are on PATH there.
  ssh "$to" bash -lc "$(printf '%q' "$install_cmd")" install "\$HOME/$(basename "$tgz")"
fi

step "done: $tgz"
