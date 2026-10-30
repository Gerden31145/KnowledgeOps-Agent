import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import {
  isAgentRunTerminalState,
  type CancelVerificationRunResponse,
  type TaskDetailResponse,
} from '@knowledgeops/contracts'
import { useKnowledgeOpsApi } from './use-knowledge-ops-api'
import { KnowledgeOpsApiError } from '../lib/knowledge-ops-api'
import { knowledgeOpsQueryKeys as keys } from '../lib/query-keys'
import type { VerificationRunRevision } from '../lib/verification-polling'

// 调用组件按 Run ID 重建；取消响应只能影响原组件，网络恢复不自动重发 POST。
export function useCancelVerificationRun(read: () => VerificationRunRevision & { taskId: string }) {
  const api = useKnowledgeOpsApi()
  const client = useQueryClient()
  const busy = ref(false)
  const issue = ref('')
  const acknowledged = shallowRef<CancelVerificationRunResponse | null>(null)
  let disposed = false
  onScopeDispose(() => {
    disposed = true
  })
  const waiting = computed(
    () =>
      read().status === 'CANCEL_REQUESTED' ||
      (acknowledged.value?.status === 'CANCEL_REQUESTED' &&
        !isAgentRunTerminalState(read().status)),
  )
  const canCancel = computed(
    () => !acknowledged.value && !waiting.value && ['QUEUED', 'RUNNING'].includes(read().status),
  )
  const message = computed(() =>
    waiting.value
      ? '取消请求已保存，等待后台确认。'
      : acknowledged.value
        ? '运行已结束，请以最新运行状态为准。'
        : '',
  )

  async function cancel() {
    if (disposed || busy.value || !canCancel.value) return
    const run = read()
    busy.value = true
    issue.value = ''
    try {
      const response = await api.cancelVerificationRun(run.runId, {
        expectedRunVersion: run.version,
      })
      if (disposed) return
      if (response.runId !== run.runId || response.taskId !== run.taskId)
        throw new Error('mismatched cancellation response')
      acknowledged.value = response
    } catch (error) {
      if (disposed) return
      issue.value =
        error instanceof KnowledgeOpsApiError && error.status === 409
          ? '运行已变化，正在刷新状态；确认后可再次取消。'
          : error instanceof KnowledgeOpsApiError && error.status === 401
            ? '登录已过期，请重新登录。'
            : error instanceof KnowledgeOpsApiError && [403, 404].includes(error.status)
              ? '无法取消此运行，请重新读取当前任务。'
              : '尚未确认取消是否受理，请查看刷新后的状态；仍在运行时可再次取消。'
    }
    if (disposed) return
    try {
      const task = client.getQueryData<TaskDetailResponse>(keys.task(run.taskId))
      // 刷新原 Task 下的活动报告/回答查询；不直接将缓存写成 CANCELLED 或恢复 Task。
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.task(run.taskId) }, { throwOnError: true }),
        client.invalidateQueries({ queryKey: keys.todayTasks(), exact: true }),
        ...(task
          ? [client.invalidateQueries({ queryKey: keys.plan(task.stage.plan.id), exact: true })]
          : []),
      ])
    } catch {
      if (!disposed && !issue.value) issue.value = '请求已处理，但状态读取失败，请刷新查看。'
    } finally {
      if (!disposed) busy.value = false
    }
  }
  return { busy, issue, message, waiting, canCancel, cancel }
}
