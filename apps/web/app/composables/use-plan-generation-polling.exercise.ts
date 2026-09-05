import {
  type PlanGenerationRunStatusResponse,
  type PlanGenerationRunState,
} from '@knowledgeops/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'

import type { KnowledgeOpsApiError } from '../lib/knowledge-ops-api'
import { knowledgeOpsQueryKeys } from '../lib/query-keys'
import { useKnowledgeOpsApi } from './use-knowledge-ops-api'

export const PLAN_GENERATION_POLL_INTERVALS_MS = [1_000, 2_000, 4_000, 8_000] as const

export interface PlanGenerationPollingQuerySnapshot {
  state: {
    data: PlanGenerationRunStatusResponse | undefined
    dataUpdateCount: number
  }
}

const DEFAULT_PLAN_GENERATION_FAILURE = {
  code: 'PLAN_GENERATION_FAILED',
  message: '计划生成失败，但服务端没有记录详细原因。',
} as const

const DEFAULT_PLAN_GENERATION_TIMEOUT = {
  code: 'RUN_DEADLINE_EXCEEDED',
  message: '计划生成超时，请创建关联重试。',
} as const

export interface PlanGenerationTerminalFailure {
  code: string
  message: string
  status: Extract<PlanGenerationRunState, 'FAILED' | 'TIMED_OUT'>
}

export function resolvePlanGenerationPollingInterval(
  query: PlanGenerationPollingQuerySnapshot,
): number | false {
  if (!query.state.data) return false // 当前还没有取得运行数据，因此暂时不设置下一次轮询定时器
  if (
    query.state.data.status === 'SUCCEEDED' ||
    query.state.data.status === 'FAILED' ||
    query.state.data.status === 'TIMED_OUT'
  )
    return false
  const currentIndex = Math.max(query.state.dataUpdateCount - 1, 0)
  return (
    PLAN_GENERATION_POLL_INTERVALS_MS[
      Math.min(currentIndex, PLAN_GENERATION_POLL_INTERVALS_MS.length - 1)
    ] ?? false
  )
}

export function getPlanGenerationTerminalFailure(
  run: PlanGenerationRunStatusResponse | undefined,
): PlanGenerationTerminalFailure | null {
  if (!run || (run.status !== 'FAILED' && run.status !== 'TIMED_OUT')) return null
  if (run.status === 'FAILED')
    return {
      code: run.error ? run.error.code : DEFAULT_PLAN_GENERATION_FAILURE.code,
      message: run.error ? run.error.message : DEFAULT_PLAN_GENERATION_FAILURE.message,
      status: run.status,
    }
  if (run.status === 'TIMED_OUT')
    return {
      code: run.error ? run.error.code : DEFAULT_PLAN_GENERATION_TIMEOUT.code,
      message: run.error ? run.error.message : DEFAULT_PLAN_GENERATION_TIMEOUT.message,
      status: run.status,
    }
  return null
}

export function usePlanGenerationPolling(generationRunId: MaybeRefOrGetter<string | null>) {
  const api = useKnowledgeOpsApi()
  const runId = computed(() => toValue(generationRunId))
  const query = useQuery<PlanGenerationRunStatusResponse, KnowledgeOpsApiError>({
    queryKey: computed(() => knowledgeOpsQueryKeys.generationRun(runId.value ?? 'disabled')),
    queryFn: ({ signal }) => {
      if (!runId.value) {
        throw new Error('generationRunId is required while polling is enabled')
      }

      return api.getPlanGenerationRun(runId.value, signal)
    },
    enabled: computed(() => Boolean(runId.value)),
    refetchInterval: resolvePlanGenerationPollingInterval,
    refetchIntervalInBackground: false,
    retry: (failureCount, error) => error.status >= 500 && failureCount < 2,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 4_000),
  })

  const terminalFailure = computed(() => getPlanGenerationTerminalFailure(query.data.value))

  return { ...query, terminalFailure }
}
