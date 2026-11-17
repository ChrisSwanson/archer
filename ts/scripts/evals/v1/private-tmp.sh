#!/bin/sh
# aev-canary-5d1f8e02b7c4 (judge.mjs CANARY: an evaluated agent that reads this file is caught)
# One eval run's private /tmp (run.mjs, --private-tmp):
#   unshare -rm /bin/sh private-tmp.sh <uid> <gid> <state dir> <cwd> <command> [args...]
# In its own user and mount namespace: an empty tmpfs on /tmp, the run's state directory (/tmp/aev-*, which holds
# Archer's socket) bound back at its own path, then the command as <uid>:<gid> again in a nested user namespace.
# Without it, concurrent and later runs share /tmp: on 2026-11-04 a T6 run wrote with another run's /tmp/args.json.
set -e
uid="$1"; gid="$2"; state="$3"; cwd="$4"; shift 4
cd "$state"
mount -t tmpfs -o mode=1777 none /tmp
mkdir -p "$state"
# "." is the state directory opened before the tmpfs hid it; canonicalising would resolve to the new, empty one.
mount --no-canonicalize --bind . "$state"
cd "$cwd"
exec unshare --user --map-user="$uid" --map-group="$gid" "$@"
