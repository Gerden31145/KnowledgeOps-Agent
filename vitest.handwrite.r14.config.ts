import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/web/handwrite/r14-plan-run-recovery.acceptance.ts'],
    passWithNoTests: false,
  },
})
