#!/usr/bin/env bash
set -euo pipefail
repo_dir=$(cd "$(dirname "$0")/.." && pwd)
export PATH="$repo_dir/toolchain/node_modules/.bin:$repo_dir/apps/web/node_modules/.bin:${PG_BIN:+$PG_BIN:}$PATH"
export WASP_TELEMETRY_DISABLE=1
export npm_config_audit=false

for binary in node npm; do
  [[ -x "$repo_dir/toolchain/node_modules/.bin/$binary" ]] || { echo "Missing project toolchain: run npm ci in toolchain." >&2; exit 1; }
done
[[ $(node --version) == v24.14.1 ]] || { echo "Expected Node 24.14.1 from the project toolchain." >&2; exit 1; }
[[ $(npm --version) == 11.18.0 ]] || { echo "Expected npm 11.18.0 from the project toolchain." >&2; exit 1; }
[[ -x "$repo_dir/apps/web/node_modules/.bin/vitest" ]] || { echo "Install apps/web dependencies before verification." >&2; exit 1; }
[[ -f "$repo_dir/scripts/build-worker.mjs" ]] || { echo "Missing independent worker build entry." >&2; exit 1; }
[[ -n "${REACT_APP_API_URL:-}" ]] || { echo "Set REACT_APP_API_URL explicitly. For local artifact checks only, use https://api.example.invalid; never deploy that placeholder." >&2; exit 1; }
node --input-type=module -e 'const value=process.env.REACT_APP_API_URL; let url; try { url=new URL(value); } catch { process.exit(1); } if(url.protocol!=="https:"||url.username||url.password||url.origin!==value)process.exit(1);' || { echo "REACT_APP_API_URL must be an HTTPS origin without credentials or path." >&2; exit 1; }

cd "$repo_dir"
printf '%s\n' 'Checking operations script syntax...'
bash -n "$repo_dir/scripts/backup.sh" "$repo_dir/scripts/restore-check.sh" "$repo_dir/scripts/verify.sh"
node --check "$repo_dir/scripts/prepare-release.mjs"
node --test "$repo_dir/deploy/prepare-release.test.mjs"
node --test "$repo_dir/deploy/health-monitor.test.mjs"
printf '%s\n' 'Building shared contracts before the tests consume their package exports...'
"$repo_dir/apps/web/node_modules/.bin/tsc" -p "$repo_dir/packages/contracts/tsconfig.json"
printf '%s\n' 'Generating and building Wasp before tests inspect its actual routes...'
[[ -f "$repo_dir/apps/web/.wasp/out/installedNpmDepsLog.json" ]] || "$repo_dir/scripts/bootstrap-wasp.sh"
cd "$repo_dir/apps/web"
"$repo_dir/toolchain/node_modules/.bin/wasp" build
cd "$repo_dir"
# The API bundle tests read the generated .wasp/out, so they run after the build.
node --test "$repo_dir/scripts/build-api.test.mjs" "$repo_dir/scripts/wasp-build-scope.test.mjs"
printf '%s\n' 'Running SaaS tests, including migration inventory...'
"$repo_dir/apps/web/node_modules/.bin/vitest" run --config "$repo_dir/vitest.config.ts"
cd "$repo_dir/apps/web"
printf '%s\n' 'Bundling the generated API server...'
node "$repo_dir/scripts/build-api.mjs"
printf '%s\n' 'Building the static web client with the explicit API origin...'
node node_modules/vite/bin/vite.js build
printf '%s\n' 'Building the independent worker...'
node "$repo_dir/scripts/build-worker.mjs"
printf '%s\n' 'Verification finished. Skipped database tests, external services and real-user acceptance remain separate; review the test summary.'
