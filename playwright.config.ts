import { defineConfig, devices } from '@playwright/test'
import {
  apiOrigin,
  databaseUrl,
  redisUrl,
  webOrigin,
  webhookSecret,
} from './tests/e2e/environment.js'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.ts',
  globalSetup: './tests/e2e/prepare-database.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: webOrigin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // 独占测试端口，避免复用到用户手动启动的另一份 API 或其他数据库。
  webServer: [
    {
      command: 'node apps/api/dist/main.js',
      url: `${apiOrigin}/health/ready`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        NODE_ENV: 'test',
        API_HOST: '127.0.0.1',
        API_PORT: '4400',
        WEB_ORIGIN: webOrigin,
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        LOG_LEVEL: 'warn',
        GITHUB_APP_CLIENT_ID: '',
        GITHUB_APP_CLIENT_SECRET: '',
        GITHUB_APP_CALLBACK_URL: '',
        GITHUB_APP_PRIVATE_KEY_PATH: '',
        GITHUB_WEBHOOK_SECRET: webhookSecret,
        PLAN_GENERATION_MODELS_JSON:
          '[{"id":"r16-fixture","label":"R16 合成模型","model":"r16-fixture"}]',
        OPENAI_API_KEY: 'r16-synthetic-model-key',
        OPENAI_BASE_URL: 'http://127.0.0.1:4500/v1',
      },
    },
    {
      command: 'node apps/web/.output/server/index.mjs',
      url: webOrigin,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NITRO_HOST: '127.0.0.1',
        NITRO_PORT: '4300',
        NUXT_PUBLIC_API_BASE_URL: apiOrigin,
        NUXT_TELEMETRY_DISABLED: '1',
      },
    },
  ],
})
