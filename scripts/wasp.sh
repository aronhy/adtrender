#!/usr/bin/env bash
set -euo pipefail
repo_dir=$(cd "$(dirname "$0")/.." && pwd)
export PATH="$repo_dir/toolchain/node_modules/.bin:$PATH"
export WASP_TELEMETRY_DISABLE=1
# Install and security auditing are separate operations.
export npm_config_audit=false
node --import "$repo_dir/apps/web/node_modules/tsx/dist/loader.mjs" "$repo_dir/scripts/generate-seed-baseline.ts"
if [[ -x "$repo_dir/apps/web/node_modules/.bin/tsc" ]]; then
  "$repo_dir/apps/web/node_modules/.bin/tsc" -p "$repo_dir/packages/contracts/tsconfig.json"
fi
cd "$repo_dir/apps/web"
exec "$repo_dir/toolchain/node_modules/.bin/wasp" "$@"
