import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'apps/**/test/**/*.spec.ts',
      'packages/**/test/**/*.spec.ts',
      'packages/**/test/**/*.exercise.ts',
      'tests/**/*.spec.ts',
    ],
    passWithNoTests: false,
    reporters: ['default'],
  },
})
