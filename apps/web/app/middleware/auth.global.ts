import { defineNuxtRouteMiddleware, navigateTo, useNuxtApp } from '#imports'
import { useKnowledgeOpsApi } from '../composables/use-knowledge-ops-api'
import { useSessionUser } from '../composables/use-session-user'
import { KnowledgeOpsApiError } from '../lib/knowledge-ops-api'
import { reconcileAnswerCommandSession } from '../lib/answer-command-session'

export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server || !to.path.startsWith('/app/')) return
  const user = useSessionUser()
  const { $queryClient } = useNuxtApp()
  try {
    const session = await useKnowledgeOpsApi().getSession()
    if (user.value?.id !== session.user.id) $queryClient.clear()
    user.value = session.user
  } catch (error: unknown) {
    user.value = null
    $queryClient.clear()
    if (error instanceof KnowledgeOpsApiError && error.status === 401) {
      // 整页刷新后 user 初值已是 null，身份 watch 不一定触发；明确未登录也要清理。
      reconcileAnswerCommandSession(null)
      return navigateTo('/login')
    }
    return navigateTo('/login?error=session-unavailable')
  }
})
