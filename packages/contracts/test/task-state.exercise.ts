import { describe, expect, it } from 'vitest'

import { isValidTaskTransition, TASK_STATES, type TaskState } from '../src/index.js'

const ALLOWED_TRANSITIONS = [
  ['BLOCKED', 'READY'],
  ['READY', 'IN_PROGRESS'],
  ['IN_PROGRESS', 'VERIFYING'],
  ['NEEDS_REVISION', 'VERIFYING'],
  ['NEEDS_EVIDENCE', 'VERIFYING'],
  ['VERIFYING', 'IN_PROGRESS'],
  ['VERIFYING', 'NEEDS_REVISION'],
  ['VERIFYING', 'NEEDS_EVIDENCE'],
  ['VERIFYING', 'PASSED'],
] as const satisfies readonly (readonly [TaskState, TaskState])[]

const allowedTransitionKeys = new Set(ALLOWED_TRANSITIONS.map(([from, to]) => `${from}->${to}`))

describe('isValidTaskTransition handwrite acceptance', () => {
  it('allows every documented direct transition', () => {
    for (const [from, to] of ALLOWED_TRANSITIONS) {
      expect(isValidTaskTransition(from, to)).toBe(true)
    }
  })

  it('rejects self transitions', () => {
    for (const state of TASK_STATES) {
      expect(isValidTaskTransition(state, state)).toBe(false)
    }
  })

  it('rejects skipped progress states', () => {
    const skippedTransitions = [
      ['BLOCKED', 'IN_PROGRESS'],
      ['READY', 'VERIFYING'],
      ['IN_PROGRESS', 'PASSED'],
      ['NEEDS_REVISION', 'PASSED'],
    ] as const satisfies readonly (readonly [TaskState, TaskState])[]

    for (const [from, to] of skippedTransitions) {
      expect(isValidTaskTransition(from, to)).toBe(false)
    }
  })

  it('rejects backward transitions outside explicit failure restoration', () => {
    const invalidBackwardTransitions = [
      ['READY', 'BLOCKED'],
      ['IN_PROGRESS', 'READY'],
      ['NEEDS_REVISION', 'IN_PROGRESS'],
      ['NEEDS_EVIDENCE', 'IN_PROGRESS'],
    ] as const satisfies readonly (readonly [TaskState, TaskState])[]

    for (const [from, to] of invalidBackwardTransitions) {
      expect(isValidTaskTransition(from, to)).toBe(false)
    }
  })

  it('keeps PASSED terminal', () => {
    for (const target of TASK_STATES) {
      expect(isValidTaskTransition('PASSED', target)).toBe(false)
    }
  })

  it('matches the complete transition matrix', () => {
    for (const from of TASK_STATES) {
      for (const to of TASK_STATES) {
        expect(isValidTaskTransition(from, to)).toBe(allowedTransitionKeys.has(`${from}->${to}`))
      }
    }
  })
})
