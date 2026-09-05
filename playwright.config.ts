import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command:
        'node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173 --strictPort',
      cwd: './apps/web',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
    },
    {
      command:
        'node node_modules/vite/bin/vite.js --config tests/e2e/vite.config.ts',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
