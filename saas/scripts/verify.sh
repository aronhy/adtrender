#!/usr/bin/env bash
set -euo pipefail
saas_dir=$(cd "$(dirname "$0")/.." && pwd)
repo_dir=$(cd "$saas_dir/.." && pwd)
export PATH="$saas_dir/toolchain/node_modules/.bin:$saas_dir/app/node_modules/.bin:${PG_BIN:+$PG_BIN:}$PATH"
export WASP_TELEMETRY_DISABLE=1
export npm_config_audit=false

for binary in node npm; do
  [[ -x "$saas_dir/toolchain/node_modules/.bin/$binary" ]] || { echo "Missing project toolchain: run npm ci in saas/toolchain." >&2; exit 1; }
done
[[ $(node --version) == v24.14.1 ]] || { echo "Expected Node 24.14.1 from the project toolchain." >&2; exit 1; }
[[ $(npm --version) == 11.18.0 ]] || { echo "Expected npm 11.18.0 from the project toolchain." >&2; exit 1; }
[[ -x "$saas_dir/app/node_modules/.bin/vitest" ]] || { echo "Install saas/app dependencies before verification." >&2; exit 1; }
[[ -f "$saas_dir/scripts/build-worker.mjs" ]] || { echo "Missing independent worker build entry." >&2; exit 1; }
[[ -n "${REACT_APP_API_URL:-}" ]] || { echo "Set REACT_APP_API_URL explicitly. For local artifact checks only, use https://api.example.invalid; never deploy that placeholder." >&2; exit 1; }
node --input-type=module -e 'const value=process.env.REACT_APP_API_URL; let url; try { url=new URL(value); } catch { process.exit(1); } if(url.protocol!=="https:"||url.username||url.password||url.origin!==value)process.exit(1);' || { echo "REACT_APP_API_URL must be an HTTPS origin without credentials or path." >&2; exit 1; }

cd "$repo_dir"
printf '%s\n' 'Checking operations script syntax...'
bash -n "$saas_dir/scripts/backup.sh" "$saas_dir/scripts/restore-check.sh" "$saas_dir/scripts/verify.sh"
node --check "$saas_dir/scripts/prepare-release.mjs"
node --test "$saas_dir/deploy/prepare-release.test.mjs"
node --test "$saas_dir/deploy/health-monitor.test.mjs"
printf '%s\n' 'Checking the seed baseline without rewriting source files...'
node --import "$saas_dir/app/node_modules/tsx/dist/loader.mjs" "$saas_dir/scripts/generate-seed-baseline.ts" --check
printf '%s\n' 'Building shared contracts before the tests consume their package exports...'
"$saas_dir/app/node_modules/.bin/tsc" -p "$saas_dir/contracts/tsconfig.json"
node --test "$saas_dir/scripts/build-api.test.mjs" "$saas_dir/scripts/wasp-build-scope.test.mjs"
printf '%s\n' 'Generating and building Wasp before tests inspect its actual routes...'
cd "$saas_dir/app"
"$saas_dir/toolchain/node_modules/.bin/wasp" build
cd "$repo_dir"
printf '%s\n' 'Running SaaS tests, including migration inventory...'
"$saas_dir/app/node_modules/.bin/vitest" run --config "$saas_dir/vitest.config.ts"
cd "$saas_dir/app"
printf '%s\n' 'Bundling the generated API server...'
node "$saas_dir/scripts/build-api.mjs"
printf '%s\n' 'Building the static web client with the explicit API origin...'
node node_modules/vite/bin/vite.js build
printf '%s\n' 'Building the independent worker...'
node "$saas_dir/scripts/build-worker.mjs"
printf '%s\n' 'Verification finished. Skipped database tests, external services and real-user acceptance remain separate; review the test summary.'
