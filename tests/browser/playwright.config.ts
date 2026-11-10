// Real browser tests against the running stack, through the proxy (UX-11 to UX-14, API-13). This is its
// own project, not a Vitest one, so the air-gap gate never runs it: Chromium is installed on the host.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: join(here, 'specs'),
  outputDir: join(here, '..', '..', '.local', 'playwright-results'),
  // Some tests stop web, and some break a table on purpose. Nothing here may overlap.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.ENSEMUS_TEST_BASE ?? 'https://localhost:8443',
    // The proxy's certificate is the local test one.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
});
