import { z } from 'zod'

export const PLAN_GENERATION_RUN_STATES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
] as const

export const PLAN_GENERATION_RUN_TERMINAL_STATES = [
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
] as const satisfies readonly PlanGenerationRunState[]

export const PLAN_GENERATION_RUN_RETRYABLE_STATES = [
  'FAILED',
  'TIMED_OUT',
] as const satisfies readonly PlanGenerationRunState[]

export const planGenerationRunStateSchema = z.enum(PLAN_GENERATION_RUN_STATES)

export type PlanGenerationRunState = z.infer<typeof planGenerationRunStateSchema>

export function isPlanGenerationRunTerminalState(
  state: PlanGenerationRunState,
): state is (typeof PLAN_GENERATION_RUN_TERMINAL_STATES)[number] {
  return PLAN_GENERATION_RUN_TERMINAL_STATES.some((terminalState) => terminalState === state)
}

export function isPlanGenerationRunRetryableState(
  state: PlanGenerationRunState,
): state is (typeof PLAN_GENERATION_RUN_RETRYABLE_STATES)[number] {
  return PLAN_GENERATION_RUN_RETRYABLE_STATES.some((retryableState) => retryableState === state)
}
