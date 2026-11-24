import { defineNuxtRouteMiddleware, navigateTo } from '#imports'
import { useWorkspaceSession } from '../composables/use-session-user'
import { hasSavedLoginReturn, takeLoginReturn } from '../lib/workspace-entry'

export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server || !to.path.startsWith('/app/')) return
  if (to.path === '/app/today') return navigateTo('/app/plan', { replace: true })
  const session = useWorkspaceSession()
  const resolution = session.resolve()
  const defaultPlan = to.path === '/app/plan' && Object.keys(to.query).length === 0
  let hasLoginReturn = false
  try {
    hasLoginReturn = hasSavedLoginReturn(window.sessionStorage)
  } catch {
    /* 可继续使用默认入口 */
  }
  if (defaultPlan && !hasLoginReturn) return

  const result = await resolution
  if (result === 'authenticated' && defaultPlan) {
    let target: string | null = null
    try {
      target = takeLoginReturn(window.sessionStorage)
    } catch {
      /* 可继续使用默认入口 */
    }
    if (target && target !== to.fullPath) return navigateTo(target, { replace: true })
  }
  if (result === 'anonymous') {
    if (to.path === '/app/plan' && !to.query.plan && !to.query.run && !to.query.goal) return
    return navigateTo({ path: '/login', query: { next: to.fullPath } })
  }
  if (result === 'unavailable' && to.path !== '/app/plan') {
    return navigateTo({
      path: '/login',
      query: { error: 'session-unavailable', next: to.fullPath },
    })
  }
})
