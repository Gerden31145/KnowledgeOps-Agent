import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/api/test/plan-generation.repository.integration.ts'],
    passWithNoTests: false,
    sequence: {
      concurrent: false,
    },
  },
})
