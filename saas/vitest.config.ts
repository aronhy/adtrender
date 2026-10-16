import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  resolve: { alias: { '@aws-sdk/client-s3': fileURLToPath(new URL('./app/node_modules/@aws-sdk/client-s3/dist-cjs/index.js', import.meta.url)) } },
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    globalSetup: ['./saas/scripts/native-test-ingest.ts'],
    include: ['saas/**/*.test.ts', 'scripts/saas-migration/**/*.test.ts'],
    // Local deployment workspaces contain standalone node:test scripts and
    // copied releases; they are not part of the application Vitest suite.
    exclude: ['**/node_modules/**', '**/.wasp/**', '**/.local/**'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 15000,
  },
});
