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
