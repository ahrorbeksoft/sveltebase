import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const exclude = [
  '**/node_modules/**',
  '**/dist/**',
  '**/*.browser.test.ts',
  '**/*.workers.test.ts',
  '**/*.node.test.ts',
  'tests/e2e/**',
];
export default defineConfig({
  root,
  plugins: [svelte({ configFile: false })],
  resolve: { conditions: ['browser'] },
  test: {
    projects: [
      './vitest.browser.config.ts',
      {
        extends: true,
        resolve: { conditions: ['node'] },
        test: {
          name: 'node',
          environment: 'node',
          include: ['packages/**/*.node.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'happy-dom',
          include: ['packages/**/*.test.ts', 'scripts/**/*.test.{ts,mjs}'],
          exclude: [...exclude, '**/*.integration.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'happy-dom',
          include: ['packages/**/*.integration.test.ts'],
          exclude,
          setupFiles: [
            fileURLToPath(
              new URL('./tests/support/storage.ts', import.meta.url),
            ),
          ],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reportOnFailure: true,
      include: ['packages/*/src/**/*.{ts,svelte}'],
      exclude: ['**/*.test.ts', '**/types.ts'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 85,
        statements: 85,
        perFile: false,
        ...Object.fromEntries(
          ['auth', 'sync', 'state', 'i18n', 'utils'].map((name) => [
            `packages/${name}/src/**`,
            { lines: 85, branches: 80 },
          ]),
        ),
      },
    },
  },
});
