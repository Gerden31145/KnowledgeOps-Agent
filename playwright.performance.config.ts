import { defineConfig } from '@playwright/test'
import { performanceApiOrigin, performanceWebOrigin } from './tests/performance/fixtures.js'

export default defineConfig({
  testDir: './tests/performance',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: 'test-results/performance-playwright',
  use: {
    baseURL: performanceWebOrigin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium' }],
  webServer: [
    {
      command: 'node --import tsx tests/performance/server.ts',
      url: `${performanceApiOrigin}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'node apps/web/.output/server/index.mjs',
      url: performanceWebOrigin,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NITRO_HOST: '127.0.0.1',
        NITRO_PORT: '4300',
        NUXT_PUBLIC_API_BASE_URL: performanceApiOrigin,
        NUXT_TELEMETRY_DISABLED: '1',
      },
    },
  ],
})
