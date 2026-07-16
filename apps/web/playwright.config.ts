import { defineConfig, devices } from '@playwright/test';

const crossBrowserCriticalSpec = '**/cross-browser-critical.spec.ts';
const jsonResultsFile =
  process.env.PLAYWRIGHT_RESULTS_FILE ??
  '../../artifacts/autonomous-build/test-results/frontend-playwright.json';
const crossBrowserProjects = [
  ...(process.env.PLAYWRIGHT_FIREFOX_ENABLED === 'true'
    ? [
        {
          name: 'firefox-critical',
          testMatch: crossBrowserCriticalSpec,
          use: { ...devices['Desktop Firefox'] },
        },
      ]
    : []),
  ...(process.env.PLAYWRIGHT_WEBKIT_ENABLED === 'true'
    ? [
        {
          name: 'webkit-mobile-critical',
          testMatch: crossBrowserCriticalSpec,
          use: { ...devices['iPhone 13'] },
        },
      ]
    : []),
];

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['html', { open: 'never' }],
    ['json', { outputFile: jsonResultsFile }],
  ],
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  ...(process.env.PLAYWRIGHT_BASE_URL
    ? {}
    : {
        webServer: {
          command: 'pnpm start',
          env: {
            APP_ENV: 'local',
            NEXT_PUBLIC_APP_ENV: 'local',
            PROVIDER_MODE: 'deterministic',
            DETERMINISTIC_DEMO_ENABLED: 'true',
          },
          url: 'http://127.0.0.1:3000/api/health',
          reuseExistingServer: false,
          timeout: 60_000,
        },
      }),
  projects: [
    {
      name: 'chromium',
      testIgnore: crossBrowserCriticalSpec,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      testIgnore: crossBrowserCriticalSpec,
      use: { ...devices['Pixel 7'] },
    },
    ...crossBrowserProjects,
  ],
});
