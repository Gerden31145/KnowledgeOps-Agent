import { z } from 'zod'

export const TASK_STATES = [
  'BLOCKED',
  'READY',
  'IN_PROGRESS',
  'VERIFYING',
  'NEEDS_REVISION',
  'NEEDS_EVIDENCE',
  'PASSED',
] as const

export const taskStateSchema = z.enum(TASK_STATES)

export type TaskState = z.infer<typeof taskStateSchema>

/** A user's active plan has at most one task occupying the current learning slot. */
export const CURRENT_TASK_STATES = [
  'IN_PROGRESS',
  'VERIFYING',
  'NEEDS_REVISION',
  'NEEDS_EVIDENCE',
] as const satisfies readonly TaskState[]

const taskTransitions = {
  BLOCKED: ['READY'],
  READY: ['IN_PROGRESS'],
  IN_PROGRESS: ['VERIFYING'],
  VERIFYING: ['NEEDS_REVISION', 'NEEDS_EVIDENCE', 'PASSED', 'IN_PROGRESS'],
  NEEDS_REVISION: ['VERIFYING'],
  NEEDS_EVIDENCE: ['VERIFYING'],
  PASSED: [],
} as const satisfies Record<TaskState, readonly TaskState[]>

/** Stable states to which a failed, cancelled, or timed-out run may restore its task. */
export const RESTORABLE_TASK_STATES = [
  'IN_PROGRESS',
  'NEEDS_REVISION',
  'NEEDS_EVIDENCE',
] as const satisfies readonly TaskState[]

export const restorableTaskStateSchema = z.enum(RESTORABLE_TASK_STATES)

export type RestorableTaskState = z.infer<typeof restorableTaskStateSchema>

export function isRestorableTaskState(state: TaskState): state is RestorableTaskState {
  return RESTORABLE_TASK_STATES.some((restorableState) => restorableState === state)
}

/**
 * Returns whether a Task may move directly from one business state to another.
 */
export function isValidTaskTransition(from: TaskState, to: TaskState): boolean {
  return taskTransitions[from].some((allowedState: TaskState) => allowedState === to)
}
