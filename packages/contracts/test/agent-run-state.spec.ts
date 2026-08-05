import { describe, expect, it } from 'vitest'

import {
  AGENT_RUN_TERMINAL_STATES,
  isAgentRunTerminalState,
  isValidAgentRunTransition,
} from '../src/index.js'

describe('AgentRun state machine', () => {
  it.each([
    ['QUEUED', 'RUNNING'],
    ['QUEUED', 'CANCEL_REQUESTED'],
    ['RUNNING', 'SUCCEEDED'],
    ['RUNNING', 'FAILED'],
    ['RUNNING', 'TIMED_OUT'],
    ['RUNNING', 'CANCEL_REQUESTED'],
    ['CANCEL_REQUESTED', 'CANCELLED'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(isValidAgentRunTransition(from, to)).toBe(true)
  })

  it.each([
    ['QUEUED', 'SUCCEEDED'],
    ['RUNNING', 'QUEUED'],
    ['CANCEL_REQUESTED', 'SUCCEEDED'],
    ['FAILED', 'RUNNING'],
    ['SUCCEEDED', 'SUCCEEDED'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(isValidAgentRunTransition(from, to)).toBe(false)
  })

  it('makes every terminal state final', () => {
    for (const terminalState of AGENT_RUN_TERMINAL_STATES) {
      expect(isAgentRunTerminalState(terminalState)).toBe(true)

      for (const candidate of AGENT_RUN_TERMINAL_STATES) {
        expect(isValidAgentRunTransition(terminalState, candidate)).toBe(false)
      }
    }
  })
})
