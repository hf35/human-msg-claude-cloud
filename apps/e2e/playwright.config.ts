import { defineConfig } from '@playwright/test';
import { API_PORT, WEB_PORT, WEB_URL } from './src/ports';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.e2e.ts',
  // The scenarios share one server and one database
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results',
  use: {
    baseURL: WEB_URL,
    // English, so the texts the scenarios look for do not depend on the machine
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm exec tsx src/server.ts',
      // Ready when the API answers; the database is recreated on start, so never reuse a server
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
    },
    {
      command: `pnpm --filter @human-msg/web exec vite --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      env: { API_URL: `http://127.0.0.1:${API_PORT}` },
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
