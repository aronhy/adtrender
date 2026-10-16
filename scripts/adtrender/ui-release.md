# AdTrender runtime-only UI release

This driver prepares and publishes one fixed, clean, complete application artifact. It does not migrate, grant database privileges, edit app.env, rotate credentials, edit/reload Nginx, or change external worker runtime. It updates only this application's release ID, API/worker image and application/public/previous pointers. The shared growth publisher lock serializes both release tools.

`ui_release.py`, `ui_release_remote.py` and `test_ui_release.py` use the existing sibling `ssh_connection.py`. All tools resolve siblings relative to their own file, with no personal path embedded. Existing SSH configuration/known-hosts/askpass stay external, as described in the adjacent README.

## Fixed source and artifact

Build from an isolated clean Git checkout of the intended full commit, never the shared workspace. For the 2026-10-07 account/workspace/Spy release this is `55883e31ff3d9bf26ba6d6ab4bf29cd111655dfe`. Build Wasp production, server bundle, worker and Vite with `REACT_APP_API_URL=https://adtrender.com`, the existing public GA4 ID and Clarity ID. Run `prepare-release.mjs` outside the checkout; require clean manifest provenance, matching release ID, every file checksum/size, exact inventory, and recomputed artifactHash. Do not add real env files to the artifact.

The live baseline for this release was independently reread as app `/opt/ad-research-test/releases/20261007-growth-3` and web `/www/wwwroot/adtrender/releases/20261007-growth-3`, source `b904c1a`, eight finished migrations. These are historical values: prepare and each later phase recheck them. `source=paused` is inherited, while API/database/worker/email must be `ok`, Google enabled and the existing growth flag true. This prepared release profile deliberately expects source paused; a future different baseline requires explicit review.

## Commands

Use fresh output/version directories. Preparation and inspection only read the remote host.

```sh
python3 scripts/adtrender/ui_release.py prepare \
  --artifact-dir /private/tmp/adtrender-release-20261007-workspace-spy-1 \
  --source-commit 55883e31ff3d9bf26ba6d6ab4bf29cd111655dfe \
  --version 20261007-workspace-spy-1 \
  --expected-app /opt/ad-research-test/releases/20261007-growth-3 \
  --expected-web /www/wwwroot/adtrender/releases/20261007-growth-3 \
  --output /private/tmp/adtrender-workspace-spy-plan
python3 scripts/adtrender/ui_release.py inspect \
  --plan-dir /private/tmp/adtrender-workspace-spy-plan
```

Only within the authorized release execution:

```sh
python3 scripts/adtrender/ui_release.py stage \
  --plan-dir /private/tmp/adtrender-workspace-spy-plan --execute
python3 scripts/adtrender/ui_release.py activate \
  --plan-dir /private/tmp/adtrender-workspace-spy-plan --execute
```

Stage reserves private evidence directories, uploads the fixed archive, rejects unsafe paths/symlinks/inventory changes, verifies old/new/database migration checksums and byte-identical schema/provider lock, then builds one tagged image with source/artifact labels. It explicitly chmods unpacked child directories 0755 despite umask 077. Before staging passes, the image's default UID 1000 must read schema/server/worker files and the embedded manifest in a network-disabled container. API and worker are later pinned to that same immutable image ID; no pull or build occurs during activation.

Activation repeats all guards, backs up only release.env, exports public files and retains prior hashed assets, updates only release ID, recreates API/worker and then switches pointers. No database backup is taken because no database migration or data operation is performed. Nginx is syntax-checked but not edited/reloaded. The worker health gate requires the exact new workerId from `worker_started` logs since the current container StartedAt; that row's startedAt/lastSeenAt must follow container startup, be fresh within 90 seconds, retain mail/collection capabilities and not be STOPPED. A second container identity read rejects a restart during verification. Source paused is not treated as a new outage; email must be ok.

## Drift and manual stage resume

All unrelated containers remain in the strict baseline, including short-lived probe containers. Nothing is ignored by name pattern. Config/pointer/container drift stops the operation and stores a private `baseline-drift-*.json` with expected and actual state. Never rewrite the plan simply to bypass drift.

If a long build finished but final baseline validation failed, retain the failed directory/logs. Reread the host and inspect the exact drift. Only if it exactly matches the original reviewed baseline again may root explicitly resume the same plan:

```sh
python3 scripts/adtrender/ui_release.py resume-stage \
  --plan-dir /private/tmp/adtrender-workspace-spy-plan --execute
```

Resume verifies the existing tar, complete unpacked artifact, schema/migrations, baseline and image provenance/default-node readability. It reuses a valid already-built image; if absent it rebuilds the same fixed source. Once staged.json exists, image ID drift is rejected. Partial unpacking is not deleted or silently repaired. Activation is not blindly retried: an existing deployment record is preserved and causes refusal; review rollback or a new release version instead.

SSH/SCP error details are stored in a local 0600 temporary log. The driver prints only one short error line, not the serialized plan or SSH argument list.

## Rollback

```sh
python3 scripts/adtrender/ui_release.py rollback \
  --plan-dir /private/tmp/adtrender-workspace-spy-plan --execute
```

Rollback first verifies that pointers/release.env are either the known candidate or original state and that protected settings and unrelated containers have not drifted. It restores original release.env, old immutable API/worker images and all original pointers. Pointer restoration runs even if container recreation or later health verification fails; health failure is reported explicitly. It never down-migrates or restores database contents. Strict unrelated-container drift may intentionally stop automatic rollback: root must compare the retained evidence and perform a separately reviewed recovery of this application's runtime only. No blanket relaxation is built in.

After activation, separately record exact source/manifest/image IDs, current pointers, protected config hashes, migration checksums, new-worker heartbeat and exact served HTML/assets. Health and local tests do not substitute for browser login, navigation, filters, account flows and business acceptance. Keep server SMTP configuration unchanged.

## Local tool checks

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/adtrender/test_ui_release.py
python3 scripts/adtrender/ui_release.py --help
```

The 13 local safety tests perform no SSH or remote writes. They cover fixed inventory/hash checks, immutable image pins, strict baseline drift, identical schema/migrations, new worker identity rejection, rollback pointers despite failed health, and private error output.
