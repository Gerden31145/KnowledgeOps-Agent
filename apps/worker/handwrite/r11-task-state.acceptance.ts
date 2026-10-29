import { describe, expect, it } from 'vitest'
import type { TaskCriterionAssessment } from '../src/verification/collect-task-assessment.js'
import { deriveTaskState } from '../src/verification/derive-task-state.exercise.js'

// 这里直接提供整理后的事实，不要求手写函数重新解析报告或验证来源。
function fact(
  type: TaskCriterionAssessment['type'],
  outcome: TaskCriterionAssessment['outcome'],
  overrides: Partial<Pick<TaskCriterionAssessment, 'id' | 'required' | 'exemption'>> = {},
): TaskCriterionAssessment {
  return Object.freeze({ id: type, type, required: true, outcome, exemption: null, ...overrides })
}

describe('R11 small handwrite: criterion facts to Task decision', () => {
  it('1. passes when required note criteria and the answer pass, without mutating facts', () => {
    const facts = Object.freeze([
      fact('FILE_CHANGED', 'PASSED'),
      fact('SECTION_PRESENT', 'PASSED'),
      fact('SEMANTIC_CORRECTNESS', 'PASSED'),
      fact('FOLLOW_UP_ANSWER', 'PASSED'),
    ])
    const before = structuredClone(facts)
    expect(deriveTaskState(facts)).toBe('PASSED')
    expect(facts).toEqual(before)
  })

  it('2. requires revision for a failed required note criterion, even alongside missing evidence', () => {
    for (const type of ['FILE_CHANGED', 'SECTION_PRESENT', 'SEMANTIC_CORRECTNESS'] as const) {
      const facts = [fact(type, 'FAILED'), fact('FOLLOW_UP_ANSWER', null)]
      expect(deriveTaskState(facts)).toBe('NEEDS_REVISION')
      expect(deriveTaskState([...facts].reverse())).toBe('NEEDS_REVISION')
    }
    expect(
      deriveTaskState([
        fact('SECTION_PRESENT', null),
        fact('SEMANTIC_CORRECTNESS', 'FAILED'),
        fact('FOLLOW_UP_ANSWER', 'INSUFFICIENT_EVIDENCE'),
      ]),
    ).toBe('NEEDS_REVISION')
  })

  it('3. needs evidence when a required note result is missing or insufficient', () => {
    for (const outcome of [null, 'INSUFFICIENT_EVIDENCE'] as const) {
      expect(
        deriveTaskState([
          fact('SECTION_PRESENT', 'PASSED'),
          fact('SEMANTIC_CORRECTNESS', outcome),
          fact('FOLLOW_UP_ANSWER', 'PASSED'),
        ]),
      ).toBe('NEEDS_EVIDENCE')
    }
  })

  it('4. needs evidence for an unanswered, failed or insufficient required answer', () => {
    for (const outcome of [null, 'FAILED', 'INSUFFICIENT_EVIDENCE'] as const) {
      expect(
        deriveTaskState([
          fact('SECTION_PRESENT', 'PASSED'),
          fact('SEMANTIC_CORRECTNESS', 'PASSED'),
          fact('FOLLOW_UP_ANSWER', outcome),
        ]),
      ).toBe('NEEDS_EVIDENCE')
    }
  })

  it('5. optional results do not block passing or hide a failed required criterion', () => {
    for (const outcome of [null, 'FAILED', 'INSUFFICIENT_EVIDENCE'] as const) {
      const optional = fact('SEMANTIC_CORRECTNESS', outcome, { required: false })
      expect(
        deriveTaskState([
          optional,
          fact('SECTION_PRESENT', 'PASSED'),
          fact('FOLLOW_UP_ANSWER', 'PASSED'),
        ]),
      ).toBe('PASSED')
      expect(
        deriveTaskState([
          optional,
          fact('SECTION_PRESENT', 'FAILED'),
          fact('FOLLOW_UP_ANSWER', 'PASSED'),
        ]),
      ).toBe('NEEDS_REVISION')
    }
  })

  it('6. accepts the validated snapshot exemption without bypassing other required criteria', () => {
    const exempt = fact('FILE_CHANGED', null, {
      exemption: 'SNAPSHOT_FILE_CHANGED_NOT_APPLICABLE',
    })
    expect(
      deriveTaskState([
        exempt,
        fact('SEMANTIC_CORRECTNESS', 'PASSED'),
        fact('FOLLOW_UP_ANSWER', 'PASSED'),
      ]),
    ).toBe('PASSED')
    expect(
      deriveTaskState([
        exempt,
        fact('SEMANTIC_CORRECTNESS', 'FAILED'),
        fact('FOLLOW_UP_ANSWER', 'PASSED'),
      ]),
    ).toBe('NEEDS_REVISION')
    expect(
      deriveTaskState([
        exempt,
        fact('SEMANTIC_CORRECTNESS', 'PASSED'),
        fact('FOLLOW_UP_ANSWER', null),
      ]),
    ).toBe('NEEDS_EVIDENCE')
    expect(exempt.outcome).toBeNull()
  })
})
