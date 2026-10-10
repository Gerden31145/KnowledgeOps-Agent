import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/api/test/github-webhook-signature.acceptance.ts'],
    passWithNoTests: false,
  },
})
