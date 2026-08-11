import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/agent-core/test/plan-generation-dependencies.exercise.ts',
      'packages/agent-core/handwrite/day-08-08-plan-dependencies.acceptance.ts',
    ],
    passWithNoTests: false,
  },
})
