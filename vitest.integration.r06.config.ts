import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/worker/test/read-bound-commit-evidence.integration.ts',
      'apps/worker/test/finalize-github-push-evidence.integration.ts',
      'apps/worker/test/github-evidence-processing.integration.ts',
      'apps/api/test/github-webhook.integration.ts',
      'apps/api/test/repository-evidence.integration.ts',
    ],
    hookTimeout: 20_000,
    testTimeout: 20_000,
    passWithNoTests: false,
  },
})
