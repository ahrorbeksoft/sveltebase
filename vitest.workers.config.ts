import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './packages/sync/tests/workers/worker.ts',
      miniflare: {
        compatibilityDate: '2026-09-01',
        durableObjects: {
          SYNC_ENGINE: 'SyncEngine',
          TRANSACTION_ENGINE: {
            className: 'TransactionEngine',
            useSQLite: true,
          },
        },
      },
    }),
  ],
  test: { include: ['packages/**/*.workers.test.ts'], isolate: true },
});
