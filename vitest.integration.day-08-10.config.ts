import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/api/test/plan-generation-status.repository.integration.ts',
      'apps/api/test/plan-lifecycle.repository.integration.ts',
      'apps/worker/test/plan-generation-run.repository.integration.ts',
    ],
    passWithNoTests: false,
    reporters: ['default'],
    sequence: {
      concurrent: false,
    },
  },
})
