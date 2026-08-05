import { z } from 'zod'

export const AGENT_RUN_STATES = [
  'QUEUED',
  'RUNNING',
  'CANCEL_REQUESTED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
] as const

export const agentRunStateSchema = z.enum(AGENT_RUN_STATES)

export type AgentRunState = z.infer<typeof agentRunStateSchema>

export const AGENT_RUN_TERMINAL_STATES = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
] as const satisfies readonly AgentRunState[]

const agentRunTransitions = {
  QUEUED: ['RUNNING', 'CANCEL_REQUESTED'],
  RUNNING: ['CANCEL_REQUESTED', 'SUCCEEDED', 'FAILED', 'TIMED_OUT'],
  CANCEL_REQUESTED: ['FAILED', 'CANCELLED', 'TIMED_OUT'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
} as const satisfies Record<AgentRunState, readonly AgentRunState[]>

export function isAgentRunTerminalState(state: AgentRunState): boolean {
  return AGENT_RUN_TERMINAL_STATES.some((terminalState) => terminalState === state)
}

export function isValidAgentRunTransition(from: AgentRunState, to: AgentRunState): boolean {
  return agentRunTransitions[from].some((allowedState: AgentRunState) => allowedState === to)
}
