import { useQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { knowledgeOpsQueryKeys } from '../lib/query-keys'
import { TASK_DISCOVERY_POLL_MS } from '../lib/verification-polling'
import { usePlanApi } from './use-plan-api'

export function useModelCatalogQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  const api = usePlanApi()

  return useQuery({
    queryKey: knowledgeOpsQueryKeys.modelCatalog(),
    enabled: computed(() => toValue(enabled)),
    queryFn: ({ signal }) => api.listModels(signal),
    staleTime: 5 * 60 * 1_000,
  })
}

export function usePlanQuery(planId: MaybeRefOrGetter<string | null>) {
  const api = usePlanApi()

  return useQuery({
    queryKey: computed(() => knowledgeOpsQueryKeys.plan(toValue(planId) ?? 'disabled')),
    queryFn: ({ signal }) => {
      const id = toValue(planId)
      if (!id) throw new Error('planId is required while the plan query is enabled')
      return api.getPlan(id, signal)
    },
    enabled: computed(() => Boolean(toValue(planId))),
    staleTime: 0,
    retry: false,
    refetchInterval: (query) => {
      if (query.state.error) return false
      return query.state.data?.stages.some((stage) =>
        stage.tasks.some((task) => task.course?.status === 'GENERATING'),
      )
        ? TASK_DISCOVERY_POLL_MS
        : false
    },
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })
}

export function useTodayTasksQuery() {
  const api = usePlanApi()

  return useQuery({
    queryKey: knowledgeOpsQueryKeys.todayTasks(),
    queryFn: ({ signal }) => api.getTodayTasks(signal),
  })
}
