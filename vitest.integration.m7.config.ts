import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/worker/test/course-generation.integration.ts',
      'apps/worker/test/course-question.integration.ts',
      'apps/api/test/course-question.integration.ts',
    ],
    hookTimeout: 20_000,
    testTimeout: 20_000,
    passWithNoTests: false,
  },
})
