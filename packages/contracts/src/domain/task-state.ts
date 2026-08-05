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
