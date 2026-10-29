import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/worker/handwrite/r11-task-state.acceptance.ts'],
    passWithNoTests: false,
    reporters: ['default'],
  },
})
