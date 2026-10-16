/** Extends the isolated workspace API acceptance with the Ad Spy platform/date contract. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SAAS_WORKSPACE_SPY_FILTERS = 'true';
process.env.SAAS_WORKSPACE_API_ARTIFACT_DIR ??= resolve(dirname(fileURLToPath(import.meta.url)), '../../output/spy-api');
await import('./workspace-api-smoke.mjs');
