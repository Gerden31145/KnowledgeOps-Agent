import { useQuery } from '@tanstack/vue-query'
import { computed, toValue, type MaybeRefOrGetter } from 'vue'

import { knowledgeOpsQueryKeys } from '../lib/query-keys'
import { useKnowledgeOpsApi } from './use-knowledge-ops-api'
import { noteEvidenceLines } from '../lib/note-evidence'

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

export function useNoteVerificationRunQuery(
  taskId: MaybeRefOrGetter<string | null>,
  runId: MaybeRefOrGetter<string | null>,
) {
  const api = useKnowledgeOpsApi()

  return useQuery({
    queryKey: computed(() =>
      knowledgeOpsQueryKeys.noteVerificationRun(
        toValue(taskId) ?? 'disabled',
        toValue(runId) ?? 'disabled',
      ),
    ),
    queryFn: async ({ signal }) => {
      const task = toValue(taskId)
      const run = toValue(runId)
      if (!task || !run) throw new Error('taskId and runId are required')
      const snapshot = await api.getNoteVerificationRun(run, signal)
      // 查询结果必须属于请求时选定的任务与运行；不借新页面的 ID 接收旧结果。
      if (snapshot.taskId !== task || snapshot.runId !== run)
        throw new Error('验收报告与当前任务或运行不匹配。')
      return snapshot
    },
    enabled: computed(() => Boolean(toValue(taskId) && toValue(runId))),
    staleTime: 0,
    retry: false,
    // 此小段只读快照和手动刷新；运行中的持续同步在后续恢复接入时补齐。
  })
}

export function useNoteRunEvidenceQuery(taskId: string, runId: string) {
  const api = useKnowledgeOpsApi()
  return useQuery({
    queryKey: knowledgeOpsQueryKeys.noteRunEvidence(taskId, runId),
    queryFn: async ({ signal }) => {
      const evidence = await api.getNoteRunEvidence(runId, signal)
      if (evidence.taskId !== taskId || evidence.runId !== runId)
        throw new Error('证据与当前任务或运行不匹配。')
      return { evidence, lines: noteEvidenceLines(evidence) }
    },
    retry: false,
    staleTime: 0,
    // 父组件按 taskId/runId 重建；离开时 signal 会取消旧请求。
  })
}

export function useFollowUpAnswerQuery(
  taskId: string,
  questionId: string,
  noteRunId: string,
  answerId: MaybeRefOrGetter<string | null>,
) {
  const api = useKnowledgeOpsApi()
  return useQuery({
    queryKey: computed(() =>
      knowledgeOpsQueryKeys.followUpAnswer(taskId, questionId, toValue(answerId) ?? 'disabled'),
    ),
    enabled: computed(() => Boolean(toValue(answerId))),
    queryFn: async ({ signal }) => {
      const id = toValue(answerId)
      if (!id) throw new Error('answerSubmissionId is required')
      const answer = await api.getFollowUpAnswer(id, signal)
      if (
        answer.answerSubmissionId !== id ||
        answer.questionId !== questionId ||
        answer.run.taskId !== taskId ||
        (answer.report &&
          (answer.report.body.source.noteRunId !== noteRunId ||
            answer.report.body.source.taskId !== taskId ||
            answer.report.body.result.answerSubmissionId !== id ||
            answer.report.body.result.questionId !== questionId))
      )
        throw new Error('回答与当前追问或任务不匹配。')
      return answer
    },
    retry: false,
    staleTime: 0,
  })
}
