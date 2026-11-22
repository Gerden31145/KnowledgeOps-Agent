import { CourseQuestionModelError } from '@knowledgeops/agent-core'
import { Logger } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { validCourseLearningPackage } from '../../../packages/agent-core/test/fixtures/course-generation.js'
import { CourseQuestionJobProcessor } from '../src/course-question/course-question-job-processor.js'

const questionId = randomUUID()
const request = {
  model: {
    catalogId: 'fixture',
    provider: 'openai' as const,
    modelName: 'fixture-model',
    reasoningEffort: null,
  },
  goal: '学习事件循环',
  course: { title: '事件循环', description: '理解浏览器任务调度。' },
  section: validCourseLearningPackage.sections[0]!,
  selectedText: validCourseLearningPackage.sections[0]!.explanation.slice(0, 80),
  question: '为什么不会阻塞下一次渲染？',
  depth: 'CONTEXTUAL' as const,
  history: [],
}

function dependencies(answer: () => Promise<unknown> = async () => ({ answer: '先处理微任务。' })) {
  const claimForExecution = vi.fn().mockResolvedValue({
    status: 'CLAIMED',
    question: {
      deadlineAt: new Date(Date.now() + 60_000),
      expectedVersion: 1,
      questionId,
      request,
    },
  })
  const recordSuccess = vi.fn().mockResolvedValue({
    status: 'RECORDED',
    questionStatus: 'SUCCEEDED',
  })
  const recordFailure = vi.fn().mockResolvedValue({ status: 'RECORDED', questionStatus: 'FAILED' })
  const model = { answer: vi.fn(answer) }
  return {
    model,
    recordFailure,
    recordSuccess,
    processor: new CourseQuestionJobProcessor(
      { claimForExecution, recordSuccess, recordFailure } as never,
      model,
      60_000,
    ),
  }
}

describe('CourseQuestionJobProcessor', () => {
  it('passes the frozen request and fencing version to success persistence', async () => {
    const context = dependencies()
    await expect(context.processor.process({ questionId })).resolves.toEqual({
      questionId,
      status: 'SUCCEEDED',
    })
    expect(context.model.answer).toHaveBeenCalledWith(request, expect.any(Object))
    expect(context.recordSuccess).toHaveBeenCalledWith(
      questionId,
      1,
      '先处理微任务。',
      expect.any(Date),
    )
    expect(context.recordFailure).not.toHaveBeenCalled()
  })

  it('records model failure without saving an answer', async () => {
    const context = dependencies(async () => {
      throw new Error('upstream unavailable')
    })
    await expect(context.processor.process({ questionId })).resolves.toEqual({
      questionId,
      status: 'FAILED',
    })
    expect(context.recordFailure).toHaveBeenCalledWith(
      questionId,
      1,
      'MODEL_UNAVAILABLE',
      expect.any(Date),
    )
    expect(context.recordSuccess).not.toHaveBeenCalled()
  })

  it.each(['MODEL_UPSTREAM_ERROR', 'MODEL_OUTPUT_INVALID'] as const)(
    'preserves the safe model error classification %s',
    async (code) => {
      const context = dependencies(async () => {
        throw new CourseQuestionModelError(code, 'Sensitive upstream detail must not be persisted')
      })
      await expect(context.processor.process({ questionId })).resolves.toEqual({
        questionId,
        status: 'FAILED',
      })
      expect(context.recordFailure).toHaveBeenCalledWith(questionId, 1, code, expect.any(Date))
      expect(context.recordSuccess).not.toHaveBeenCalled()
    },
  )

  it('logs structured diagnostics without the error message or response values', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const diagnostic = {
      finishReason: 'stop',
      parsedType: 'null',
      rawContentType: 'string',
      failureType: 'SCHEMA_VALIDATION' as const,
      schemaIssues: [
        { code: 'invalid_type', path: 'answer', expected: 'string', received: 'undefined' },
      ],
    }
    const context = dependencies(async () => {
      throw new CourseQuestionModelError(
        'MODEL_OUTPUT_INVALID',
        'Sensitive upstream detail must not be logged',
        { diagnostic },
      )
    })
    try {
      await context.processor.process({ questionId })
      expect(warn).toHaveBeenCalledWith({
        event: 'course_question_execution_failed',
        questionId,
        errorCode: 'MODEL_OUTPUT_INVALID',
        diagnostic,
      })
      expect(JSON.stringify(warn.mock.calls)).not.toContain('Sensitive upstream detail')
    } finally {
      warn.mockRestore()
    }
  })

  it('does not overwrite a terminal result when success persistence loses the version race', async () => {
    const context = dependencies()
    context.recordSuccess.mockResolvedValue({ status: 'SKIPPED', questionStatus: 'FAILED' })
    await expect(context.processor.process({ questionId })).resolves.toEqual({
      questionId,
      status: 'SKIPPED',
      reason: 'TERMINAL',
      questionStatus: 'FAILED',
    })
    expect(context.recordFailure).not.toHaveBeenCalled()
  })
})
