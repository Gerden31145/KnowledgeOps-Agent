import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import {
  isAgentRunTerminalState,
  type FollowUpAnswerResponse,
  type RetryAnswerVerificationResponse,
  type TaskDetailResponse,
} from '@knowledgeops/contracts'
import { useKnowledgeOpsApi } from './use-knowledge-ops-api'
import { KnowledgeOpsApiError } from '../lib/knowledge-ops-api'
import { knowledgeOpsQueryKeys as keys } from '../lib/query-keys'

// 组件按回答 Run 挂载；重试复用数据库中的答案，不读取草稿、不重新提交答案。
export function useRetryAnswerVerification(
  read: () => { answer: FollowUpAnswerResponse; task: TaskDetailResponse; noteRunId: string },
) {
  const api = useKnowledgeOpsApi(),
    client = useQueryClient()
  const busy = ref(false),
    issue = ref('')
  const receipt = shallowRef<RetryAnswerVerificationResponse | null>(null)
  let disposed = false
  onScopeDispose(() => {
    disposed = true
  })
  const retryRunId = computed(() => read().answer.run.retryRunId ?? receipt.value?.runId ?? null)
  watch(retryRunId, (id) => {
    if (id) issue.value = ''
  })
  const retryableState = computed(() =>
    ['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(read().answer.run.status),
  )
  const canRetry = computed(() => {
    const { answer, task, noteRunId } = read()
    return (
      !retryRunId.value &&
      retryableState.value &&
      task.id === answer.run.taskId &&
      task.stage.plan.status === 'ACTIVE' &&
      task.state === 'NEEDS_EVIDENCE' &&
      task.runs.find((r) => r.kind === 'NOTE_VERIFICATION')?.id === noteRunId &&
      task.runs.find((r) => r.kind === 'ANSWER_VERIFICATION')?.id === answer.run.runId &&
      !task.runs.some((r) => !isAgentRunTerminalState(r.status))
    )
  })

  async function retry() {
    if (disposed || busy.value || !canRetry.value) return
    const { answer, task } = read()
    busy.value = true
    issue.value = ''
    try {
      const accepted = await api.retryAnswerVerification(
        answer.answerSubmissionId,
        answer.run.runId,
        {
          expectedRunVersion: answer.run.version,
          expectedTaskVersion: task.version,
        },
      )
      if (disposed) return
      if (
        accepted.retryOfRunId !== answer.run.runId ||
        accepted.runId === answer.run.runId ||
        accepted.answerSubmissionId !== answer.answerSubmissionId ||
        accepted.taskId !== task.id
      )
        throw new Error('mismatched answer retry receipt')
      receipt.value = accepted
    } catch (error) {
      if (disposed) return
      issue.value =
        error instanceof KnowledgeOpsApiError && error.status === 401
          ? '登录已过期，请重新登录。'
          : error instanceof KnowledgeOpsApiError && error.status === 409
            ? '回答或任务已变化，正在刷新；请查看最新运行后再确认。'
            : error instanceof KnowledgeOpsApiError && [400, 403, 404].includes(error.status)
              ? '无法重试此回答运行，请刷新并核对当前追问。'
              : '尚未确认重试是否受理。请刷新回答找回重试运行；再次操作会返回同一运行。'
    }
    if (disposed) return
    try {
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.task(task.id) }, { throwOnError: true }),
        client.invalidateQueries({ queryKey: keys.todayTasks(), exact: true }),
        client.invalidateQueries({ queryKey: keys.plan(task.stage.plan.id), exact: true }),
      ])
    } catch {
      if (!disposed && !issue.value) issue.value = '重试已受理，列表更新失败；可直接查看重试运行。'
    } finally {
      if (!disposed) busy.value = false
    }
  }
  return { busy, issue, receipt, retryRunId, retryableState, canRetry, retry }
}
