import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/contracts/test/task-state.exercise.ts'],
    passWithNoTests: false,
    reporters: ['default'],
  },
})
