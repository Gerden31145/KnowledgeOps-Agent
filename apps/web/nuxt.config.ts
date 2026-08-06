import tailwindcss from '@tailwindcss/vite'
import { defineNuxtConfig } from 'nuxt/config'
import { z } from 'zod'

const publicEnvironmentSchema = z.object({
  NUXT_PUBLIC_API_BASE_URL: z.string().url().default('http://127.0.0.1:4000'),
})

const environmentResult = publicEnvironmentSchema.safeParse(process.env)

if (!environmentResult.success) {
  const invalidFields = environmentResult.error.issues
    .map((issue) => issue.path.join('.'))
    .join(', ')
  throw new Error(`Invalid Web environment fields: ${invalidFields}`)
}

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  css: ['~/assets/css/main.css'],
  devtools: { enabled: true },
  runtimeConfig: {
    public: {
      apiBaseUrl: environmentResult.data.NUXT_PUBLIC_API_BASE_URL,
    },
  },
  typescript: {
    strict: true,
    typeCheck: true,
  },
  vite: {
    plugins: [tailwindcss()],
  },
})
