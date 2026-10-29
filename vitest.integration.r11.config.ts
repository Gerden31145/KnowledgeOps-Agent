import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/worker/test/finalize-plan-generation-run.acceptance.ts',
      'apps/worker/test/required-follow-up-criterion.integration.ts',
      'apps/worker/test/task-assessment-finalization.integration.ts',
    ],
    hookTimeout: 20_000,
    testTimeout: 20_000,
    passWithNoTests: false,
  },
})
