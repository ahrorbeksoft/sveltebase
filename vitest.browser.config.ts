import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { playwright } from '@vitest/browser-playwright';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [svelte({ configFile: false })],
  test: {
    name: 'browser',
    include: ['packages/**/*.browser.test.ts', 'tests/browser/**/*.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      headless: true,
    },
  },
});
