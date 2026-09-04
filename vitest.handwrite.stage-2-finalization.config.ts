import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/worker/test/finalize-plan-generation-run.acceptance.ts'],
    passWithNoTests: false,
    reporters: ['default'],
    sequence: {
      concurrent: false,
    },
  },
})
