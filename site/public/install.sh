#!/bin/sh
# Download a verified GitHub Release package, then run Archer's own setup.
set -eu

fail() {
  printf 'Archer install: %s\n' "$*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail 'Install Node 22.18 or newer, then run this command again.'
node_version=$(node --version)
node_major=${node_version#v}
node_major=${node_major%%.*}
node_minor=${node_version#*.}
node_minor=${node_minor%%.*}
case "$node_major:$node_minor" in
  *[!0-9:]*|:*|*:) fail "Node 22.18 or newer is required (found $node_version)." ;;
esac
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 18 ]; }; then
  fail "Node 22.18 or newer is required (found $node_version)."
fi
for required in curl npx mktemp awk; do
  command -v "$required" >/dev/null 2>&1 || fail "Install $required, then run this command again."
done
if command -v sha256sum >/dev/null 2>&1; then
  checksum=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  checksum=shasum
else
  fail 'Install sha256sum or shasum to verify the download.'
fi

release=https://github.com/chrisswanson/archer/releases/latest/download
if [ -n "${ARCHER_VERSION:-}" ]; then
  case "$ARCHER_VERSION" in *[!A-Za-z0-9._-]*) fail 'ARCHER_VERSION must be a release version, such as 0.15.0.' ;; esac
  version=${ARCHER_VERSION#v}
  release="https://github.com/chrisswanson/archer/releases/download/v$version"
fi
release=${ARCHER_RELEASE_BASE:-$release}
release=${release%/}

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/archer-install.XXXXXXXX")
trap 'rm -rf "$work_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$work_dir"
printf 'Downloading Archer from %s\n' "$release"
curl -fsSL "$release/archer.tgz" -o archer.tgz
curl -fsSL "$release/SHA256SUMS" -o SHA256SUMS
# Check only the package we downloaded; never follow filenames from the manifest.
awk '$2 == "archer.tgz" || $2 == "*archer.tgz" { print $1 "  archer.tgz"; found++ } END { if (found != 1) exit 1 }' SHA256SUMS > package.sha256 || fail 'SHA256SUMS must contain exactly one archer.tgz checksum.'
if [ "$checksum" = sha256sum ]; then
  sha256sum -c package.sha256 || fail 'Checksum verification failed. No setup was run.'
else
  shasum -a 256 -c package.sha256 || fail 'Checksum verification failed. No setup was run.'
fi
printf 'Verified archer.tgz. Running setup with Node %s.\n' "$node_version"
npx --yes ./archer.tgz setup "$@"
printf 'Archer setup completed. Follow any remaining steps printed above.\n'
