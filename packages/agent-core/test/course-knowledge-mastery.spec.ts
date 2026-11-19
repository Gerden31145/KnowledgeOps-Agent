import { describe, expect, it } from 'vitest'

import {
  buildCourseExerciseReport,
  buildCourseKnowledgeEvidence,
  summarizeKnowledgeMastery,
} from '../src/index.js'
import { validCourseLearningPackage } from './fixtures/course-generation.js'

function answers(correct: number) {
  return {
    multipleChoiceAnswers: validCourseLearningPackage.exercises.multipleChoice.map(
      (question, index) => ({
        questionId: question.id,
        optionId:
          index < correct
            ? question.correctOptionId
            : question.options.find((option) => option.id !== question.correctOptionId)!.id,
      }),
    ),
    followUpAnswer: '当前任务结束后清空微任务，再进入后续渲染调度。',
  }
}

describe('course knowledge mastery', () => {
  it('builds question-level evidence and marks a fully correct first report as mastered', () => {
    const report = buildCourseExerciseReport(validCourseLearningPackage.exercises, answers(4), {
      outcome: 'PASSED',
      rationale: '理解准确。',
      suggestions: [],
    })
    const evidence = buildCourseKnowledgeEvidence(validCourseLearningPackage.exercises, report)
    expect(evidence).toHaveLength(5)
    expect(evidence.every((item) => item.score === 100)).toBe(true)
    expect(evidence.map((item) => item.questionId)).toEqual([
      'choice-one',
      'choice-two',
      'choice-three',
      'choice-four',
      'follow-up',
    ])
    expect(summarizeKnowledgeMastery(evidence)).toEqual({
      level: 'MASTERED',
      score: 100,
      evidenceCount: 5,
      misconceptionTags: [],
    })
  })

  it('keeps incorrect and insufficient evidence with deterministic misconception tags', () => {
    const report = buildCourseExerciseReport(validCourseLearningPackage.exercises, answers(2), {
      outcome: 'INSUFFICIENT_EVIDENCE',
      rationale: '解释不完整。',
      suggestions: ['补充调度顺序。'],
    })
    const evidence = buildCourseKnowledgeEvidence(validCourseLearningPackage.exercises, report)
    expect(evidence.map((item) => item.score)).toEqual([100, 100, 0, 0, 50])
    expect(summarizeKnowledgeMastery(evidence)).toEqual({
      level: 'DEVELOPING',
      score: 50,
      evidenceCount: 5,
      misconceptionTags: ['选择题概念辨析', '开放追问证据不足'],
    })
  })

  it('uses explicit thresholds and returns UNKNOWN only when there is no evidence', () => {
    expect(summarizeKnowledgeMastery([])).toEqual({
      level: 'UNKNOWN',
      score: 0,
      evidenceCount: 0,
      misconceptionTags: [],
    })
    expect(summarizeKnowledgeMastery([{ score: 49, misconceptionTags: [] }]).level).toBe('WEAK')
    expect(summarizeKnowledgeMastery([{ score: 50, misconceptionTags: [] }]).level).toBe(
      'DEVELOPING',
    )
    expect(summarizeKnowledgeMastery([{ score: 80, misconceptionTags: [] }]).level).toBe('MASTERED')
  })
})
