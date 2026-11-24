import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, toValue, watch, type MaybeRefOrGetter } from 'vue'
import {
  isAgentRunTerminalState,
  type NoteVerificationRunResponse,
  type FollowUpAnswerResponse,
  type TaskDetailResponse,
} from '@knowledgeops/contracts'
import type { KnowledgeOpsApi } from '../lib/knowledge-ops-api'

import { knowledgeOpsQueryKeys } from '../lib/query-keys'
import { useKnowledgeOpsApi } from './use-knowledge-ops-api'
import { noteEvidenceLines } from '../lib/note-evidence'
import {
  keepPreviousRun,
  TASK_DISCOVERY_POLL_MS,
  taskDiscoveryPollInterval,
  verificationPollInterval,
  type VerificationRunRevision,
} from '../lib/verification-polling'

export function useModelCatalogQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  const api = useKnowledgeOpsApi()

  return useQuery({
    queryKey: knowledgeOpsQueryKeys.modelCatalog(),
    enabled: computed(() => toValue(enabled)),
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
  const api = useKnowledgeOpsApi()

  return useQuery({
    queryKey: knowledgeOpsQueryKeys.todayTasks(),
    queryFn: ({ signal }) => api.getTodayTasks(signal),
  })
}

export function useTaskQuery(taskId: MaybeRefOrGetter<string | null>) {
  const api = useKnowledgeOpsApi()
  const client = useQueryClient()

  return useQuery({
    queryKey: computed(() => knowledgeOpsQueryKeys.task(toValue(taskId) ?? 'disabled')),
    queryFn: async ({ signal }) => {
      const id = toValue(taskId)
      if (!id) throw new Error('taskId is required while the task query is enabled')
      const previous = client.getQueryData<TaskDetailResponse>(knowledgeOpsQueryKeys.task(id))
      const snapshot = await readTaskSnapshot(api, id, previous, signal)
      if (snapshot.id !== id) throw new Error('任务快照与当前任务不匹配。')
      // 同版本的运行列表可以更新，但迟到的 Task 版本不能覆盖新状态。
      if (
        previous &&
        (snapshot.version < previous.version ||
          (snapshot.version === previous.version && snapshot.state !== previous.state) ||
          (previous.state === 'PASSED' && snapshot.state !== 'PASSED'))
      )
        return previous
      return snapshot
    },
    enabled: computed(() => Boolean(toValue(taskId))),
    staleTime: 0,
    retry: false,
    refetchInterval: (current) =>
      taskDiscoveryPollInterval(current.state.data, current.state.error),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })
}

async function readTaskSnapshot(
  api: KnowledgeOpsApi,
  taskId: string,
  previous: TaskDetailResponse | undefined,
  signal: AbortSignal,
): Promise<TaskDetailResponse> {
  if (previous?.type !== 'COURSE') return api.getTask(taskId, signal)
  const summary = await api.getTaskSummary(taskId, signal)
  if (summary.id !== taskId) throw new Error('任务摘要与当前任务不匹配。')
  const currentCourse = summary.course
  const previousCourse = previous.course
  if (!currentCourse && !previousCourse) return { ...summary, course: null }
  if (
    currentCourse &&
    previousCourse &&
    currentCourse.generationRunId === previousCourse.generationRunId &&
    (currentCourse.status !== 'READY' ||
      (previousCourse.status === 'READY' &&
        previousCourse.sections !== null &&
        previousCourse.exercises !== null))
  ) {
    return {
      ...summary,
      course: {
        ...currentCourse,
        sections: previousCourse.sections,
        exercises: previousCourse.exercises,
      },
    }
  }
  return api.getTask(taskId, signal)
}

export function useNoteVerificationRunQuery(
  taskId: MaybeRefOrGetter<string | null>,
  runId: MaybeRefOrGetter<string | null>,
) {
  const api = useKnowledgeOpsApi()
  const client = useQueryClient()

  const query = useQuery({
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
      const previous = client.getQueryData<NoteVerificationRunResponse>(
        knowledgeOpsQueryKeys.noteVerificationRun(task, run),
      )
      return keepPreviousRun(previous, snapshot) ? previous! : snapshot
    },
    enabled: computed(() => Boolean(toValue(taskId) && toValue(runId))),
    staleTime: 0,
    retry: false,
    refetchInterval: (current) => verificationPollInterval(current.state.data, current.state.error),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })
  refreshTaskOnSettled(() => query.data.value)
  return query
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
  runId: MaybeRefOrGetter<string | null> = null,
) {
  const api = useKnowledgeOpsApi()
  const client = useQueryClient()
  const query = useQuery({
    queryKey: computed(() =>
      knowledgeOpsQueryKeys.followUpAnswer(
        taskId,
        questionId,
        toValue(answerId) ?? 'disabled',
        toValue(runId),
      ),
    ),
    enabled: computed(() => Boolean(toValue(answerId))),
    queryFn: async ({ signal }) => {
      const id = toValue(answerId)
      const selectedRun = toValue(runId)
      if (!id) throw new Error('answerSubmissionId is required')
      const answer = await api.getFollowUpAnswer(id, signal, selectedRun ?? undefined)
      if (
        answer.answerSubmissionId !== id ||
        answer.questionId !== questionId ||
        answer.run.taskId !== taskId ||
        (selectedRun !== null && answer.run.runId !== selectedRun) ||
        (answer.report &&
          (answer.report.body.source.noteRunId !== noteRunId ||
            answer.report.body.source.taskId !== taskId ||
            answer.report.body.result.answerSubmissionId !== id ||
            answer.report.body.result.questionId !== questionId))
      )
        throw new Error('回答与当前追问或任务不匹配。')
      const previous = client.getQueryData<FollowUpAnswerResponse>(
        knowledgeOpsQueryKeys.followUpAnswer(taskId, questionId, id, selectedRun),
      )
      return keepPreviousRun(previous?.run, answer.run) ? previous! : answer
    },
    retry: false,
    staleTime: 0,
    refetchInterval: (current) =>
      verificationPollInterval(current.state.data?.run, current.state.error),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })
  refreshTaskOnSettled(() => query.data.value?.run)
  return query
}

function refreshTaskOnSettled(
  read: () => (VerificationRunRevision & { taskId: string }) | undefined,
) {
  const client = useQueryClient()
  // 只监听运行身份/版本/状态；同一终态刷新回答列表不会反复使 Task 失效。
  watch(
    () => {
      const run = read()
      return run && isAgentRunTerminalState(run.status)
        ? `${run.taskId}:${run.runId}:${run.version}`
        : null
    },
    (settled) => {
      const run = read()
      if (!settled || !run) return
      const task = client.getQueryData<TaskDetailResponse>(knowledgeOpsQueryKeys.task(run.taskId))
      void client.invalidateQueries({
        queryKey: knowledgeOpsQueryKeys.task(run.taskId),
        exact: true,
      })
      void client.invalidateQueries({ queryKey: knowledgeOpsQueryKeys.todayTasks(), exact: true })
      if (task)
        void client.invalidateQueries({
          queryKey: knowledgeOpsQueryKeys.plan(task.stage.plan.id),
          exact: true,
        })
    },
    { immediate: true },
  )
}
