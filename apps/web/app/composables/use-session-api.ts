import { useRuntimeConfig } from '#app'
import { createSessionApi } from '../lib/session-api'

export function useSessionApi() {
  return createSessionApi(useRuntimeConfig().public.apiBaseUrl)
}
