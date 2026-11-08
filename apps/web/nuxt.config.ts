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
  app: {
    head: {
      link: [
        { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' },
        { rel: 'icon', type: 'image/png', sizes: '96x96', href: '/favicon-96x96.png' },
      ],
    },
  },
  runtimeConfig: {
    public: {
      apiBaseUrl: environmentResult.data.NUXT_PUBLIC_API_BASE_URL,
    },
  },
  routeRules: {
    '/app/**': { ssr: false },
  },
  typescript: {
    strict: true,
    typeCheck: true,
  },
  vite: {
    plugins: [tailwindcss()],
  },
})
