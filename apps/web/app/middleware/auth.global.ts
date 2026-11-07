import { defineNuxtRouteMiddleware, navigateTo, useNuxtApp, useState } from '#imports'
import { useKnowledgeOpsApi } from '../composables/use-knowledge-ops-api'
import { useSessionUser } from '../composables/use-session-user'
import { KnowledgeOpsApiError } from '../lib/knowledge-ops-api'
import { reconcileAnswerCommandSession } from '../lib/answer-command-session'
import { takeLoginReturn } from '../lib/workspace-entry'

export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server || !to.path.startsWith('/app/')) return
  if (to.path === '/app/today') return navigateTo('/app/plan', { replace: true })
  const user = useSessionUser()
  const issue = useState<string | null>('workspace-session-issue', () => null)
  issue.value = null
  const { $queryClient } = useNuxtApp()
  try {
    const session = await useKnowledgeOpsApi().getSession()
    if (user.value?.id !== session.user.id) $queryClient.clear()
    user.value = session.user
    if (to.path === '/app/plan' && Object.keys(to.query).length === 0) {
      let target: string | null = null
      try {
        target = takeLoginReturn(window.sessionStorage)
      } catch {
        /* 可继续使用默认入口 */
      }
      if (target && target !== to.fullPath) return navigateTo(target, { replace: true })
    }
  } catch (error: unknown) {
    user.value = null
    $queryClient.clear()
    if (error instanceof KnowledgeOpsApiError && error.status === 401) {
      // 整页刷新后 user 初值已是 null，身份 watch 不一定触发；明确未登录也要清理。
      reconcileAnswerCommandSession(null)
      if (to.path === '/app/plan' && !to.query.plan && !to.query.run && !to.query.goal) return
      return navigateTo({ path: '/login', query: { next: to.fullPath } })
    }
    issue.value = '暂时无法确认登录状态，请检查网络后重试。'
    if (to.path === '/app/plan') return
    return navigateTo({
      path: '/login',
      query: { error: 'session-unavailable', next: to.fullPath },
    })
  }
})
