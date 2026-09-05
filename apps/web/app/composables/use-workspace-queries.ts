import { useQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'

import { knowledgeOpsQueryKeys } from '../lib/query-keys'
import { useKnowledgeOpsApi } from './use-knowledge-ops-api'

export function useModelCatalogQuery() {
  const api = useKnowledgeOpsApi()

  return useQuery({
    queryKey: knowledgeOpsQueryKeys.modelCatalog(),
    queryFn: ({ signal }) => api.listModels(signal),
    staleTime: 5 * 60 * 1_000,
  })
}

export function usePlanQuery(planId: MaybeRefOrGetter<string | null>) {
  const api = useKnowledgeOpsApi()

  return useQuery({
    queryKey: computed(() => knowledgeOpsQueryKeys.plan(toValue(planId) ?? 'disabled')),
    queryFn: ({ signal }) => {
      const id = toValue(planId)
      if (!id) throw new Error('planId is required while the plan query is enabled')
      return api.getPlan(id, signal)
    },
    enabled: computed(() => Boolean(toValue(planId))),
  })
}

export function useTodayTasksQuery() {
  const api = useKnowledgeOpsApi()

  return useQuery({
    queryKey: knowledgeOpsQueryKeys.todayTasks(),
    queryFn: ({ signal }) => api.getTodayTasks(signal),
  })
}

export function useTaskQuery(taskId: MaybeRefOrGetter<string | null>) {
  const api = useKnowledgeOpsApi()

  return useQuery({
    queryKey: computed(() => knowledgeOpsQueryKeys.task(toValue(taskId) ?? 'disabled')),
    queryFn: ({ signal }) => {
      const id = toValue(taskId)
      if (!id) throw new Error('taskId is required while the task query is enabled')
      return api.getTask(id, signal)
    },
    enabled: computed(() => Boolean(toValue(taskId))),
  })
}
