import { computed, onScopeDispose, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import { navigateTo, useRuntimeConfig } from '#imports'
import { createPlanRunRecovery } from '../lib/plan-run-recovery-driver'
import { initialRecoveryState, type RunSnapshot } from '../lib/plan-run-recovery.exercise'
import { subscribePlanGenerationRun } from '../lib/plan-generation-stream'
import { knowledgeOpsQueryKeys } from '../lib/query-keys'
import { getPlanGenerationTerminalFailure } from './use-plan-generation-polling.exercise'
import { useKnowledgeOpsApi } from './use-knowledge-ops-api'
import { useSessionUser } from './use-session-user'

// 页面只通过这一入口同步 Run；旧轮询练习保留，但不与此入口并行执行。
export function usePlanRunRecovery(generationRunId: MaybeRefOrGetter<string | null>) {
  const api = useKnowledgeOpsApi()
  const config = useRuntimeConfig()
  const user = useSessionUser()
  const queryClient = useQueryClient()
  const runId = computed(() => toValue(generationRunId))
  const state = shallowRef(initialRecoveryState())
  // 页面只展示已归并的快照，并同步到 Query 缓存；不另启自动查询绕过归并入口。
  const data = computed(() => state.value.snapshot)
  const recovery = createPlanRunRecovery({
    read: (id, signal) => api.getPlanGenerationRun(id, signal),
    subscribe: (id, handlers) => subscribePlanGenerationRun(config.public.apiBaseUrl, id, handlers),
    cache: (id, snapshot) => {
      const key = knowledgeOpsQueryKeys.generationRun(id)
      if (snapshot) queryClient.setQueryData(key, snapshot)
      else queryClient.removeQueries({ queryKey: key, exact: true })
    },
    changed: (next) => {
      state.value = next
      if (next.issue?.kind === 'unauthorized') {
        user.value = null
        queryClient.clear()
        void navigateTo('/login')
      }
    },
  })
  watch(
    [runId, () => user.value?.id],
    ([id, userId]) => {
      const selected = userId ? id : null
      const cached = selected
        ? queryClient.getQueryData<RunSnapshot>(knowledgeOpsQueryKeys.generationRun(selected))
        : undefined
      recovery.select(selected, cached)
    },
    { immediate: true, flush: 'sync' },
  )
  onScopeDispose(() => recovery.dispose())
  const error = computed(() => (state.value.issue ? new Error(state.value.issue.message) : null))
  return {
    data,
    error,
    isPending: computed(() => Boolean(runId.value) && !data.value && !error.value),
    isError: computed(() => !data.value && Boolean(error.value)),
    terminalFailure: computed(() => getPlanGenerationTerminalFailure(data.value)),
    mode: computed(() => state.value.mode),
    canRefresh: computed(() => ['connecting', 'streaming', 'polling'].includes(state.value.mode)),
    refetch: () => recovery.refresh(),
  }
}
