#!/usr/bin/env bash
set -euo pipefail
repo_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_dir/apps/web"
exec "$repo_dir/toolchain/node_modules/.bin/node" --env-file=.env.server dist-worker/index.mjs "$@"
