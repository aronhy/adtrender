#!/usr/bin/env bash
set -euo pipefail
saas_dir=$(cd "$(dirname "$0")/.." && pwd)
export PATH="$saas_dir/toolchain/node_modules/.bin:$PATH"
export WASP_TELEMETRY_DISABLE=1
# Install and security auditing are separate operations.
export npm_config_audit=false
node --import "$saas_dir/app/node_modules/tsx/dist/loader.mjs" "$saas_dir/scripts/generate-seed-baseline.ts"
if [[ -x "$saas_dir/app/node_modules/.bin/tsc" ]]; then
  "$saas_dir/app/node_modules/.bin/tsc" -p "$saas_dir/contracts/tsconfig.json"
fi
cd "$saas_dir/app"
exec "$saas_dir/toolchain/node_modules/.bin/wasp" "$@"
