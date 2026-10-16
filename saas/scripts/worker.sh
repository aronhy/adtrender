#!/usr/bin/env bash
set -euo pipefail
saas_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$saas_dir/app"
exec "$saas_dir/toolchain/node_modules/.bin/node" --env-file=.env.server dist-worker/index.mjs "$@"
