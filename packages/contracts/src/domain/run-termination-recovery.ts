import type { AgentRunState } from './agent-run-state.js'
import { isRestorableTaskState, type RestorableTaskState, type TaskState } from './task-state.js'

export const RECOVERABLE_AGENT_RUN_TERMINAL_STATES = [
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
] as const satisfies readonly AgentRunState[]

export type RecoverableAgentRunTerminalState =
  (typeof RECOVERABLE_AGENT_RUN_TERMINAL_STATES)[number]

export const RUN_TERMINATION_RECOVERY_SKIP_REASONS = [
  'RUN_NOT_RECOVERABLE',
  'TASK_NOT_VERIFYING',
  'TASK_VERSION_MISMATCH',
  'PREVIOUS_TASK_STATE_NOT_RESTORABLE',
] as const

export type RunTerminationRecoverySkipReason =
  (typeof RUN_TERMINATION_RECOVERY_SKIP_REASONS)[number]

export interface RunTerminationRecoveryInput {
  currentTaskState: TaskState
  currentTaskVersion: number
  expectedTaskVersion: number
  taskStateBeforeRun: TaskState
  runState: AgentRunState
}

export type RunTerminationRecoveryDecision =
  | {
      kind: 'RESTORE'
      targetTaskState: RestorableTaskState
      expectedTaskVersion: number
    }
  | {
      kind: 'SKIP'
      reason: RunTerminationRecoverySkipReason
    }

/**
 * Purely decides whether a terminated AgentRun may restore its Task.
 * The caller must still perform an atomic conditional database update.
 */
export function decideRunTerminationRecovery(
  input: RunTerminationRecoveryInput,
): RunTerminationRecoveryDecision {
  const isRunRecoverable = RECOVERABLE_AGENT_RUN_TERMINAL_STATES.some(
    (state) => state === input.runState,
  ) // run state是否符合条件

  if (!isRunRecoverable)
    return {
      kind: 'SKIP',
      reason: 'RUN_NOT_RECOVERABLE',
    }

  const isTaskVerifying = input.currentTaskState === 'VERIFYING'

  if (!isTaskVerifying)
    return {
      kind: 'SKIP',
      reason: 'TASK_NOT_VERIFYING',
    }

  const isVersion = input.currentTaskVersion === input.expectedTaskVersion

  if (!isVersion)
    return {
      kind: 'SKIP',
      reason: 'TASK_VERSION_MISMATCH',
    }

  if (!isRestorableTaskState(input.taskStateBeforeRun))
    return {
      kind: 'SKIP',
      reason: 'PREVIOUS_TASK_STATE_NOT_RESTORABLE',
    }

  return {
    kind: 'RESTORE',
    targetTaskState: input.taskStateBeforeRun,
    expectedTaskVersion: input.expectedTaskVersion,
  }
}
