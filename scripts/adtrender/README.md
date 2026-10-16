# AdTrender growth release — prepared, not executed

For a release with unchanged database schema and migrations, use the [runtime-only UI release procedure](ui-release.md). The growth migration driver below is specific to the original growth rollout.

The original reviewed `/private/tmp` runners are retained for the current session. This tracked copy uses a sibling SSH helper and environment-selected external configuration.

Files:
- `scripts/adtrender/growth_release.py`: local runner; prepare/inspect only read remote state.
- `scripts/adtrender/growth_release_remote.py`: remote helper sent over existing verified SSH config.
- `scripts/adtrender/test_growth_release.py`: isolated local safety tests; no SSH/server calls.

The source commit and clean complete artifact must be supplied by the root agent after review. Do not deploy the shared working tree. Do not substitute a new expected pointer merely to bypass drift detection: reconcile any concurrent auth/public-page release into the fixed source, rebuild, then prepare a fresh plan with the new baseline.

## Known baseline (historical read at 2026-10-07 08:17:44Z; prepare will recheck)

- App current: `/opt/ad-research-test/releases/20261007-google-1`
- Public current: `/www/wwwroot/adtrender/releases/20261007-public-registration-2`
- Public source: `47c5f5fb6516d34a963a7d51fd54fe4d08353947`
- Candidate version: `20261007-growth`; reserve refuses if any candidate app/public/backup directory exists. Use a new reviewed version and repackage if necessary.
- External worker runtime `/etc/ad-research-test/ds-meta-worker-runtime.yml` and external seccomp file must remain unchanged.
- Migration role has existing elevated privileges. Script does not modify that role. Credentials remain external and are never printed.

## Root prerequisites

1. Freeze reviewed commit including latest deployed auth/public changes. Build in isolated checkout with its clean Git provenance; use `REACT_APP_API_URL=https://adtrender.com`, `VITE_GA4_MEASUREMENT_ID=G-XPSC1KS613`, `VITE_CLARITY_PROJECT_ID=ytw1viphzw`. Do not reuse stale Wasp generated source.
2. Run scoped/full authorized local tests and typecheck; ensure `getGrowthOverview` generated query, schema, auth hooks, worker, public consent code all match source. Current growth summary 14 tests passed against the isolated local database, including administrator-only access and same-cohort aggregation.
3. Use `scripts/prepare-release.mjs` to prepare a complete release outside the checkout, release ID matching the intended version. It must report clean sourceCommit. Never manually edit the manifest to claim a different commit.
4. Review migration `20261007190000_growth_attribution`: three growth tables, nullable `User.firstAdSavedAt`, and existing saved-ad timestamp backfill. This is additive; automatic/manual runtime rollback leaves the new schema and data in place.

## External SSH configuration

Set `ADTRENDER_SSH_CONFIG` and `ADTRENDER_SSH_KNOWN_HOSTS` to existing absolute files outside the repository. `ADTRENDER_SSH_HOST` defaults to the existing alias `netcup-server`. For the already authorized askpass setup only, set `ADTRENDER_SSH_ASKPASS` to its existing absolute executable path; otherwise normal SSH agent/config authentication is used. The helper never opens or prints credential contents, does not create trust entries, and enforces `StrictHostKeyChecking=yes`. Do not put credentials, personal config paths or real askpass contents in this repository.

Run from the repository root. Python 3.9+ is required. No shell invocation is used for local SSH options. The original `/private/tmp` version remains unchanged.

## Commands (replace placeholders only after the prerequisite evidence exists)

Read-only preparation snapshots current app/public pointers, all container identities/start times, relevant config hashes, and other virtual host hashes. Config contents/secrets are not output.

```sh
python3 scripts/adtrender/growth_release.py prepare \
  --artifact-dir /private/tmp/REVIEWED_COMPLETE_ARTIFACT \
  --source-commit REVIEWED_FULL_40_HEX_COMMIT \
  --version 20261007-growth \
  --expected-app /opt/ad-research-test/releases/20261007-google-1 \
  --expected-web /www/wwwroot/adtrender/releases/20261007-public-registration-2 \
  --output /private/tmp/adtrender-growth-plan
python3 scripts/adtrender/growth_release.py inspect \
  --plan-dir /private/tmp/adtrender-growth-plan
```

Only after root approves the concrete artifact and execution:

```sh
python3 scripts/adtrender/growth_release.py stage \
  --plan-dir /private/tmp/adtrender-growth-plan --execute
python3 scripts/adtrender/growth_release.py activate \
  --plan-dir /private/tmp/adtrender-growth-plan --execute
```

Stage reserves new directories, uploads the exact tar, verifies paths/inventory/hashes/provenance, checks migration checksums, and builds one candidate image. It does not change live app/public/config/database. It saves the image ID and manifest hash in private staging evidence. Failed/incomplete staging requires review; do not remove existing directories or retry with unreviewed changes.

Activate repeats baseline/artifact/image checks. Before any migration, it takes a private custom-format database backup and verifies restoration into a newly created inaccessible temporary database (migration checksums and valid constraints/indexes), then removes only that temporary database. It applies exactly the one reviewed migration using the immutable candidate image and grants CRUD only on the three new growth tables. It preserves all other app-env values, enables `GROWTH_ATTRIBUTION_ENABLED=true`, updates release ID, and appends only `growth` to the existing Nginx API-route pattern. It copies the new public files and retains old hashed assets. API and worker are started with the same immutable candidate image, the existing external worker runtime, no build/pull, and their loopback/private networking. It checks health, Google availability, image identity, growth flag, and the no-write 400 rejection probe before switching current pointers. Final verification checks exact public HTML bytes, relevant config hashes and unrelated containers/vhosts. Private remote logs and evidence live under `/opt/ad-research-test/backups/growth-20261007-growth/`.

The probe is `POST /growth/consent` with `Origin: https://adtrender.com`, `Content-Type: application/json`, body `{}`. Expected `400 INVALID_GROWTH_REQUEST`, before rate/DB writes. Missing Origin is `403`; GET is `404`. A public SPA `200` means the reverse proxy is incorrect.

## Rollback

```sh
python3 scripts/adtrender/growth_release.py rollback \
  --plan-dir /private/tmp/adtrender-growth-plan --execute
```

Rollback refuses unknown config/pointer or external worker-runtime changes. It restores the saved app/release env and this domain's Nginx config, starts old API/worker with the captured immutable old image IDs and external worker runtime, then restores old app/public/previous pointers. It checks old image identities, API/database/worker health, Google availability, and exact previous public HTML before marking rollback verified. It does not down-migrate or restore the production database. Failed activation after successful migration but before runtime change retains additive schema; retry requires a new reviewed migration baseline/plan, not bypassing the guard.

## Final acceptance

After activation root should separately record current/source/manifest/image IDs and public bundle IDs/robots/sitemap; verify the admin view in a real authorized session, and use test-tagged (`utm_source=codex` or `utm_medium=qa`) consent → signup → verification → first successful save to verify exactly one conversion at each stage. These QA visits are excluded from the normal overview. Verify logged-out and ordinary tenant users cannot query site-wide data; verify reject/revoke stops collection. Do not treat health or local tests as real-user acceptance.

Local safety checks: Python source compilation/help + 8 isolated tests cover env drift/duplicates, psql booleans, baseline drift, exact inventory/hash/symlink rejection, immutable image pins and complete old image identities. No deployment, migration, remote write or service restart was executed while preparing these scripts.
