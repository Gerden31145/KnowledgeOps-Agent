import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '#app': fileURLToPath(new URL('./apps/web/test/support/nuxt-app-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['apps/web/handwrite/day-08-11-plan-generation-polling.acceptance.ts'],
    passWithNoTests: false,
    reporters: ['default'],
  },
})
