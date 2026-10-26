import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/worker/handwrite/r08-section-present.acceptance.ts'],
    passWithNoTests: false,
    reporters: ['default'],
  },
})
