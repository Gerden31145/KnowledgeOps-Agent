import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/worker/test/outbox-dispatcher.integration.ts'],
    passWithNoTests: false,
    sequence: {
      concurrent: false,
    },
  },
})
