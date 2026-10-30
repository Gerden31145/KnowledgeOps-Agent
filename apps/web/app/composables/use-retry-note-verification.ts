import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import {
  isAgentRunTerminalState,
  isRestorableTaskState,
  type NoteVerificationRunResponse,
  type TaskDetailResponse,
  type RetryNoteVerificationResponse,
} from '@knowledgeops/contracts'
import { useKnowledgeOpsApi } from './use-knowledge-ops-api'
import { KnowledgeOpsApiError } from '../lib/knowledge-ops-api'
import { knowledgeOpsQueryKeys as keys } from '../lib/query-keys'

// 旧 Run 是本次重试意图的稳定身份；刷新后从其 retryRunId 找回结果，无需自动重发 POST。
export function useRetryNoteVerification(
  read: () => { run: NoteVerificationRunResponse; task: TaskDetailResponse },
) {
  const api = useKnowledgeOpsApi(),
    client = useQueryClient()
  const busy = ref(false),
    issue = ref('')
  const receipt = shallowRef<RetryNoteVerificationResponse | null>(null)
  let disposed = false
  onScopeDispose(() => {
    disposed = true
  })
  const retryRunId = computed(() => read().run.retryRunId ?? receipt.value?.runId ?? null)
  // POST 响应丢失后，GET 也能证明重试已受理，清除此前的不确定提示。
  watch(retryRunId, (id) => {
    if (id) issue.value = ''
  })
  const retryableState = computed(() =>
    ['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(read().run.status),
  )
  const canRetry = computed(() => {
    const { run, task } = read()
    return (
      !retryRunId.value &&
      retryableState.value &&
      task.id === run.taskId &&
      task.stage.plan.status === 'ACTIVE' &&
      isRestorableTaskState(task.state) &&
      task.runs.find((r) => r.kind === 'NOTE_VERIFICATION')?.id === run.runId &&
      !task.runs.some((r) => !isAgentRunTerminalState(r.status))
    )
  })

  async function retry() {
    if (disposed || busy.value || !canRetry.value) return
    const { run, task } = read()
    busy.value = true
    issue.value = ''
    try {
      const accepted = await api.retryNoteVerification(run.runId, {
        expectedRunVersion: run.version,
        expectedTaskVersion: task.version,
      })
      if (disposed) return
      if (
        accepted.retryOfRunId !== run.runId ||
        accepted.runId === run.runId ||
        accepted.taskId !== task.id
      )
        throw new Error('mismatched retry receipt')
      receipt.value = accepted
    } catch (error) {
      if (disposed) return
      issue.value =
        error instanceof KnowledgeOpsApiError && error.status === 401
          ? '登录已过期，请重新登录。'
          : error instanceof KnowledgeOpsApiError && error.status === 409
            ? '任务或证据已变化，正在刷新；请查看最新运行后再确认。'
            : error instanceof KnowledgeOpsApiError && [400, 403, 404].includes(error.status)
              ? '无法重试此笔记运行，请刷新并核对当前任务。'
              : '尚未确认重试是否受理。请刷新报告找回重试运行；再次操作会返回同一运行。'
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
