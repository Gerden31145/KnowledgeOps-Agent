import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/api/test/plan.repository.exercise.ts'],
    passWithNoTests: false,
  },
})
