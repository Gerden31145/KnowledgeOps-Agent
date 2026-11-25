import { CURRENT_TASK_STATES, type TaskDetailResponse } from '@knowledgeops/contracts'
import { KnowledgeOpsApiError } from './knowledge-ops-api'

export const TASK_DISCOVERY_POLL_MS = 5_000

export function isTransientReadError(error: Error | null): boolean {
  return (
    error instanceof TypeError ||
    error instanceof DOMException ||
    (error instanceof KnowledgeOpsApiError && error.status >= 500)
  )
}

export function taskDiscoveryPollInterval(
  task: TaskDetailResponse | undefined,
  error: Error | null,
): number | false {
  if (error && !isTransientReadError(error)) return false
  if (
    task &&
    (task.stage.plan.status !== 'ACTIVE' ||
      !CURRENT_TASK_STATES.some((state) => state === task.state))
  )
    return false
  return task?.type === 'COURSE' && task.course?.status === 'GENERATING'
    ? TASK_DISCOVERY_POLL_MS
    : false
}
