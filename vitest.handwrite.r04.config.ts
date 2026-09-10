import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/api/test/github-auth.controller.exercise.ts'],
    passWithNoTests: false,
  },
})
