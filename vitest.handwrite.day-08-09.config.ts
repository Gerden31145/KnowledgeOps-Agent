import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/worker/handwrite/day-08-09-bullmq.acceptance.ts'],
    passWithNoTests: false,
    sequence: {
      concurrent: false,
    },
  },
})
