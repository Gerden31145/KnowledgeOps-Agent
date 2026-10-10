import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/api/test/github-webhook.integration.ts',
      'apps/worker/test/outbox-dispatcher.integration.ts',
    ],
    hookTimeout: 20_000,
    testTimeout: 20_000,
    passWithNoTests: false,
  },
})
