import { describe, expect, it, vi } from 'vitest'

import { validCourseLearningPackage } from './fixtures/course-generation.js'
import {
  InvalidCourseExerciseAnswersError,
  InvalidCourseExerciseEvaluationError,
  buildCourseExerciseReport,
  evaluateCourseFollowUpAnswer,
  gradeCourseMultipleChoice,
  type CourseFollowUpVerificationRequest,
} from '../src/course-exercise/course-exercise.js'
import { LangChainCourseExerciseVerifier } from '../src/course-exercise/langchain-course-exercise-verifier.js'
import type { LangChainChatModelFactory } from '../src/models/chat-model.js'

const exercises = validCourseLearningPackage.exercises
const correctAnswers = exercises.multipleChoice.map((question) => ({
  questionId: question.id,
  optionId: question.correctOptionId,
}))
const passed = { outcome: 'PASSED' as const, rationale: '理解准确。', suggestions: [] }

describe('course exercise mixed acceptance', () => {
  it.each([4, 3])('passes with %i correct answers and a passed follow-up', (count) => {
    const answers = correctAnswers.map((answer, index) =>
      index < count
        ? answer
        : {
            ...answer,
            optionId: exercises.multipleChoice[index]!.options.find(
              (option) => option.id !== answer.optionId,
            )!.id,
          },
    )
    expect(
      buildCourseExerciseReport(
        exercises,
        {
          multipleChoiceAnswers: answers,
          followUpAnswer: '开放题回答',
        },
        passed,
      ),
    ).toMatchObject({ correctCount: count, passed: true })
  })

  it('requires both at least three correct answers and a passed follow-up', () => {
    const answers = correctAnswers.map((answer, index) =>
      index < 2
        ? answer
        : {
            ...answer,
            optionId: exercises.multipleChoice[index]!.options.find(
              (option) => option.id !== answer.optionId,
            )!.id,
          },
    )
    expect(
      buildCourseExerciseReport(
        exercises,
        {
          multipleChoiceAnswers: answers,
          followUpAnswer: '开放题回答',
        },
        passed,
      ).passed,
    ).toBe(false)
    expect(
      buildCourseExerciseReport(
        exercises,
        {
          multipleChoiceAnswers: correctAnswers,
          followUpAnswer: '开放题回答',
        },
        {
          outcome: 'INSUFFICIENT_EVIDENCE',
          rationale: '解释不够完整。',
          suggestions: ['补充调度顺序。'],
        },
      ).passed,
    ).toBe(false)
  })

  it('rejects unknown questions and options instead of silently grading them wrong', () => {
    expect(() =>
      gradeCourseMultipleChoice(exercises, [
        ...correctAnswers.slice(1),
        { questionId: 'unknown', optionId: 'a' },
      ]),
    ).toThrow(InvalidCourseExerciseAnswersError)
    expect(() =>
      gradeCourseMultipleChoice(exercises, [
        ...correctAnswers.slice(1),
        { ...correctAnswers[0]!, optionId: 'unknown' },
      ]),
    ).toThrow(InvalidCourseExerciseAnswersError)
  })

  it('rejects a non-passing model evaluation without actionable feedback', async () => {
    const request = {
      model: {
        catalogId: 'fixture',
        provider: 'openai',
        modelName: 'fixture-model',
        reasoningEffort: null,
      },
      course: {
        title: '事件循环',
        description: '理解浏览器任务调度。',
        sections: validCourseLearningPackage.sections,
      },
      question: exercises.followUp,
      answer: '我的回答',
    }
    await expect(
      evaluateCourseFollowUpAnswer(
        {
          verify: vi.fn(async () => ({ outcome: 'FAILED', rationale: '不完整', suggestions: [] })),
        },
        request,
      ),
    ).rejects.toBeInstanceOf(InvalidCourseExerciseEvaluationError)
  })

  it('uses bounded low-reasoning output when the course has no reasoning preference', async () => {
    const invoke = vi.fn(async () => ({ parsed: passed, raw: {} }))
    const factory = vi.fn(() => ({
      withStructuredOutput: () => ({ invoke }),
    })) as unknown as LangChainChatModelFactory
    const request: CourseFollowUpVerificationRequest = {
      model: {
        catalogId: 'fixture',
        provider: 'openai',
        modelName: 'fixture-model',
        reasoningEffort: null,
      },
      course: {
        title: '事件循环',
        description: '理解浏览器任务调度。',
        sections: validCourseLearningPackage.sections,
      },
      question: exercises.followUp,
      answer: '我的回答',
    }

    await new LangChainCourseExerciseVerifier({ apiKey: 'fixture-key' }, factory).verify(request)

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 4_096, reasoningEffort: 'low' }),
    )
  })

  it('rejects a truncated structured evaluation even when the SDK returned a parsed value', async () => {
    const invoke = vi.fn(async () => ({
      parsed: passed,
      raw: { response_metadata: { finish_reason: 'length' } },
    }))
    const factory = vi.fn(() => ({
      withStructuredOutput: () => ({ invoke }),
    })) as unknown as LangChainChatModelFactory
    const request: CourseFollowUpVerificationRequest = {
      model: {
        catalogId: 'fixture',
        provider: 'openai',
        modelName: 'fixture-model',
        reasoningEffort: 'low',
      },
      course: {
        title: '事件循环',
        description: '理解浏览器任务调度。',
        sections: validCourseLearningPackage.sections,
      },
      question: exercises.followUp,
      answer: '我的回答',
    }

    await expect(
      new LangChainCourseExerciseVerifier({ apiKey: 'fixture-key' }, factory).verify(request),
    ).rejects.toMatchObject({ code: 'MODEL_OUTPUT_TRUNCATED' })
  })

  it('parses a JSON text response when the SDK did not produce a structured object', async () => {
    const invoke = vi.fn(async () => ({
      parsed: null,
      raw: { content: JSON.stringify(passed), response_metadata: { finish_reason: 'stop' } },
    }))
    const factory = vi.fn(() => ({
      withStructuredOutput: () => ({ invoke }),
    })) as unknown as LangChainChatModelFactory
    const request: CourseFollowUpVerificationRequest = {
      model: {
        catalogId: 'fixture',
        provider: 'openai',
        modelName: 'fixture-model',
        reasoningEffort: 'low',
      },
      course: {
        title: '事件循环',
        description: '理解浏览器任务调度。',
        sections: validCourseLearningPackage.sections,
      },
      question: exercises.followUp,
      answer: '我的回答',
    }

    await expect(
      new LangChainCourseExerciseVerifier({ apiKey: 'fixture-key' }, factory).verify(request),
    ).resolves.toEqual(passed)
  })
})
