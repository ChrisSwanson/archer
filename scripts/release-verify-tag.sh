#!/usr/bin/env bash
#
# Refuse to release a tag unless it is the release the owner meant. Prints X.Y.Z on success.
#
# Usage: scripts/release-verify-tag.sh [--fetch <remote>] <tag> [main-ref]
#   main-ref defaults to <remote>/main, or origin/main without --fetch.
#
# The tag must be an annotated vX.Y.Z (a lightweight tag is a typo or a tool, never the flow in
# .agents/skills/archer-pr-flow step 4), its commit must be on main and checked out here (HEAD), and
# that commit's ts/package.json must say X.Y.Z, or `archer --version` contradicts the release it
# came from. --fetch first fetches the tag and main from <remote> as the server has them: a CI
# checkout may hold neither, or the tag as a lightweight one pointing at the commit.
set -euo pipefail

remote=""
if [[ "${1:-}" == --fetch ]]; then remote="${2:?--fetch needs a remote}"; shift 2; fi
tag="${1:-}" main="${2:-${remote:-origin}/main}"
fail() { echo "release-verify-tag: $*" >&2; exit 1; }

[[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
  fail "'$tag' is not a release tag (vX.Y.Z)"
version="${tag#v}"

if [[ -n "$remote" ]]; then
  git fetch -q --no-tags --force "$remote" "+refs/tags/$tag:refs/tags/$tag" "+refs/heads/main:refs/remotes/$remote/main" ||
    fail "could not fetch $tag and main from $remote"
fi

kind="$(git cat-file -t "refs/tags/$tag" 2>/dev/null)" || fail "no tag $tag here (fetch it first)"
[[ "$kind" == tag ]] || fail "$tag is a lightweight tag; release tags are annotated (git tag -a $tag -m $version)"

commit="$(git rev-parse "refs/tags/$tag^{commit}")"
git rev-parse --verify -q "$main^{commit}" >/dev/null || fail "no $main here (fetch it first)"
git merge-base --is-ancestor "$commit" "$main" ||
  fail "$tag points at ${commit:0:12}, which is not on $main; tag main's merge commit"

head="$(git rev-parse HEAD)"
[[ "$head" == "$commit" ]] || fail "HEAD is ${head:0:12}, not $tag's commit ${commit:0:12}; check the tag out first"

manifest="$(git show "$commit:ts/package.json" 2>/dev/null)" || fail "$tag has no ts/package.json"
declared="$(printf '%s' "$manifest" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version",""))')" ||
  fail "$tag's ts/package.json is not JSON"
[[ "$declared" == "$version" ]] ||
  fail "$tag says $version but its ts/package.json says '$declared'; the package would report '$declared'"

echo "$version"
