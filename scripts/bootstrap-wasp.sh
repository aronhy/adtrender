#!/usr/bin/env bash
# Prepares a fresh checkout for `wasp build` / `wasp start` without changing
# apps/web/package-lock.json. Wasp refuses to compile until `wasp install` has
# recorded the installed dependencies, but `wasp install` before the first
# compile prunes the generated workspaces from the lock. So: record, compile,
# then reinstall exactly from the committed lock.
set -euo pipefail
repo_dir=$(cd "$(dirname "$0")/.." && pwd)
lock="$repo_dir/apps/web/package-lock.json"
backup=$(mktemp)
trap 'cp "$backup" "$lock"; rm -f "$backup"' EXIT
cp "$lock" "$backup"
"$repo_dir/scripts/wasp.sh" install
"$repo_dir/scripts/wasp.sh" compile
cp "$backup" "$lock"
(cd "$repo_dir/apps/web" && npm ci)
