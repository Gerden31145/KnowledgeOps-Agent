import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/api/test/auth.integration.ts',
      'apps/api/test/repository-binding.integration.ts',
    ],
    hookTimeout: 20_000,
    testTimeout: 20_000,
    passWithNoTests: false,
  },
})
