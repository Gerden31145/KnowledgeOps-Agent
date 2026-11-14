import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { CourseQuestionController } from '../src/courses/course-question.controller.js'
import {
  CourseQuestionConflictError,
  CourseQuestionNotFoundError,
  CourseQuestionService,
  CourseQuestionUnavailableError,
} from '../src/courses/course-question.service.js'

const actor = { userId: randomUUID(), timezone: 'Asia/Shanghai' }
const taskId = randomUUID()
const input = {
  requestId: randomUUID(),
  sectionId: 'event-loop',
  selectedText: '当前调用栈',
  question: '为什么？',
  depth: 'CONTEXTUAL' as const,
}

describe('CourseQuestionController', () => {
  it('passes actor and task identity and parses the answer', async () => {
    const answer = {
      id: randomUUID(),
      sectionId: input.sectionId,
      selectedText: input.selectedText,
      question: input.question,
      depth: input.depth,
      status: 'SUCCEEDED',
      answer: '因为调度有先后顺序。',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }
    const ask = vi.fn(async () => answer)
    const controller = new CourseQuestionController(
      { ask } as unknown as CourseQuestionService,
      actor,
    )
    await expect(controller.ask(taskId, input)).resolves.toEqual(answer)
    expect(ask).toHaveBeenCalledWith(actor.userId, taskId, input)
  })

  it('keeps missing, conflict, and model failures distinct', async () => {
    const ask = vi
      .fn()
      .mockRejectedValueOnce(new CourseQuestionNotFoundError())
      .mockRejectedValueOnce(new CourseQuestionConflictError('选文无效'))
      .mockRejectedValueOnce(new CourseQuestionUnavailableError())
    const controller = new CourseQuestionController(
      { ask } as unknown as CourseQuestionService,
      actor,
    )
    await expect(controller.ask(taskId, input)).rejects.toBeInstanceOf(NotFoundException)
    await expect(controller.ask(taskId, input)).rejects.toBeInstanceOf(ConflictException)
    await expect(controller.ask(taskId, input)).rejects.toBeInstanceOf(ServiceUnavailableException)
  })
})
