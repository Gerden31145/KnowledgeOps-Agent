import {
  CURRENT_TASK_STATES,
  isAgentRunTerminalState,
  type AgentRunState,
  type TaskDetailResponse,
} from '@knowledgeops/contracts'
import { KnowledgeOpsApiError } from './knowledge-ops-api'

export const VERIFICATION_POLL_MS = 2_000
export const TASK_DISCOVERY_POLL_MS = 5_000
export interface VerificationRunRevision {
  runId: string
  version: number
  status: AgentRunState
}

// Query 负责计时、断网暂停和取消；这里只决定是否继续读取已选中的运行。
export function verificationPollInterval(
  run: VerificationRunRevision | undefined,
  error: Error | null,
): number | false {
  if (run && isAgentRunTerminalState(run.status)) return false
  if (error && !isTransientReadError(error)) return false
  return VERIFICATION_POLL_MS
}

export function isTransientReadError(error: Error | null): boolean {
  return (
    error instanceof TypeError ||
    error instanceof DOMException ||
    (error instanceof KnowledgeOpsApiError && error.status >= 500)
  )
}

// 已结束的旧 Run 不代表不会再 Push；新运行从当前学习任务的快照中发现。
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
  if (task?.type === 'COURSE')
    return task.course?.status === 'GENERATING' ? TASK_DISCOVERY_POLL_MS : false
  return TASK_DISCOVERY_POLL_MS
}

// 沿用 C2 的版本/终态原则；同一终态的追问回答列表仍可刷新，不能整份永久冻结。
export function keepPreviousRun(
  previous: VerificationRunRevision | undefined,
  incoming: VerificationRunRevision,
): boolean {
  return Boolean(
    previous &&
    previous.runId === incoming.runId &&
    (incoming.version < previous.version ||
      (incoming.version === previous.version && incoming.status !== previous.status) ||
      (isAgentRunTerminalState(previous.status) && incoming.status !== previous.status)),
  )
}
