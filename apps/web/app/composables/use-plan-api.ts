import { useRuntimeConfig } from '#app'
import { createPlanApi } from '../lib/plan-api'

export function usePlanApi() {
  return createPlanApi(useRuntimeConfig().public.apiBaseUrl)
}
