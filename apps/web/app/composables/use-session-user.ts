import { useNuxtApp, useState } from '#imports'
import type { SessionResponse } from '@knowledgeops/contracts'
import { reconcileAnswerCommandSession } from '../lib/answer-command-session'
import { KnowledgeOpsApiError } from '../lib/knowledge-ops-api'
import { knowledgeOpsQueryKeys } from '../lib/query-keys'
import { useKnowledgeOpsApi } from './use-knowledge-ops-api'

export type WorkspaceSessionStatus = 'pending' | 'authenticated' | 'anonymous' | 'unavailable'

// 只存可展示的身份；Cookie 由浏览器管理，不能由此状态决定 API 访问权限。
export const useSessionUser = () =>
  useState<SessionResponse['user'] | null>('session-user', () => null)

export const useWorkspaceSessionStatus = () =>
  useState<WorkspaceSessionStatus>('workspace-session-status', () => 'pending')

export const useWorkspaceSessionEpoch = () => useState<number>('workspace-session-epoch', () => 0)

export function useWorkspaceSession() {
  const user = useSessionUser()
  const status = useWorkspaceSessionStatus()
  const epoch = useWorkspaceSessionEpoch()
  const issue = useState<string | null>('workspace-session-issue', () => null)
  const api = useKnowledgeOpsApi()
  const { $queryClient } = useNuxtApp()

  async function resolve() {
    status.value = 'pending'
    issue.value = null
    try {
      const session = await $queryClient.fetchQuery({
        queryKey: knowledgeOpsQueryKeys.session(),
        queryFn: () => api.getSession(),
        retry: false,
        staleTime: 0,
      })
      if (user.value && user.value.id !== session.user.id) {
        epoch.value += 1
        $queryClient.clear()
      }
      user.value = session.user
      status.value = 'authenticated'
      return 'authenticated' as const
    } catch (error: unknown) {
      epoch.value += 1
      user.value = null
      $queryClient.clear()
      if (error instanceof KnowledgeOpsApiError && error.status === 401) {
        // 整页刷新后 user 初值已是 null，身份 watch 不一定触发；明确未登录也要清理。
        reconcileAnswerCommandSession(null)
        status.value = 'anonymous'
        return 'anonymous' as const
      }
      status.value = 'unavailable'
      issue.value = '暂时无法确认登录状态，请检查网络后重试。'
      return 'unavailable' as const
    }
  }

  return { resolve }
}
