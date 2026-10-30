import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/api/test/cancel-verification-run.integration.ts',
      'apps/api/test/retry-note-verification.integration.ts',
      'apps/api/test/retry-answer-verification.integration.ts',
    ],
    hookTimeout: 20_000,
    testTimeout: 20_000,
    passWithNoTests: false,
  },
})
