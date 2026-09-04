import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/agent-core/handwrite/day-08-10-plan-dependency-cycle.acceptance.ts'],
    passWithNoTests: false,
    reporters: ['default'],
  },
})
