import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/api/test/workspace.repository.integration.ts'],
    passWithNoTests: false,
    reporters: ['default'],
    testTimeout: 20_000,
  },
})
