import { useRuntimeConfig } from '#app'
import { createCourseApi } from '../lib/course-api'

export function useCourseApi() {
  return createCourseApi(useRuntimeConfig().public.apiBaseUrl)
}
