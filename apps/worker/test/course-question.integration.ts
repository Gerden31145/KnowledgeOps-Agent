import type { CourseQuestionRequest } from '@knowledgeops/agent-core'
import { createDatabaseClient } from '@knowledgeops/database'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { validCourseLearningPackage } from '../../../packages/agent-core/test/fixtures/course-generation.js'
import { CourseQuestionService } from '../../api/src/courses/course-question.service.js'
import { CourseQuestionExecutionRepository } from '../src/course-question/course-question-execution.repository.js'
import { CourseQuestionJobProcessor } from '../src/course-question/course-question-job-processor.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for the M7 integration test')
const database = createDatabaseClient(databaseUrl)

async function createReadyCourse() {
  const userId = randomUUID()
  const goalId = randomUUID()
  const planRunId = randomUUID()
  const planId = randomUUID()
  const taskId = randomUUID()
  const courseRunId = randomUUID()
  const now = new Date()
  await database.user.create({
    data: {
      id: userId,
      goals: {
        create: {
          id: goalId,
          title: '学习浏览器事件循环',
          currentLevel: '熟悉 Vue 3',
          deadline: new Date(now.getTime() + 30 * 86_400_000),
          weeklyMinutes: 600,
        },
      },
    },
  })
  await database.planGenerationRun.create({
    data: {
      id: planRunId,
      goalId,
      modelCatalogId: 'fixture',
      modelProvider: 'openai',
      modelName: 'fixture-model',
      promptVersion: 'plan-generation-v3',
      outputSchemaVersion: 'plan-generation-output-v3',
      deadlineAt: new Date(now.getTime() + 60_000),
    },
  })
  await database.plan.create({
    data: {
      id: planId,
      goalId,
      generationRunId: planRunId,
      status: 'ACTIVE',
      confirmedAt: now,
      stages: {
        create: {
          title: '浏览器基础',
          position: 0,
          tasks: {
            create: {
              id: taskId,
              title: '事件循环与渲染',
              description: '结合浏览器渲染理解任务调度。',
              position: 0,
              type: 'COURSE',
              state: 'IN_PROGRESS',
              estimatedMinutes: 45,
              course: { create: { status: 'READY' } },
            },
          },
        },
      },
    },
  })
  await database.courseGenerationRun.create({
    data: {
      id: courseRunId,
      course: { connect: { taskId } },
      status: 'SUCCEEDED',
      modelCatalogId: 'fixture',
      modelProvider: 'openai',
      modelName: 'fixture-model',
      promptVersion: 'course-generation-v1',
      outputSchemaVersion: 'course-generation-output-v1',
      deadlineAt: now,
      finishedAt: now,
    },
  })
  await database.courseVersion.create({
    data: {
      course: { connect: { taskId } },
      generationRun: { connect: { id: courseRunId } },
      version: 1,
      content: { sections: validCourseLearningPackage.sections },
      exerciseSet: { create: { body: validCourseLearningPackage.exercises } },
    },
  })
  return { userId, taskId }
}

function input(requestId = randomUUID()) {
  return {
    requestId,
    sectionId: validCourseLearningPackage.sections[0]!.id,
    selectedText: validCourseLearningPackage.sections[0]!.explanation.slice(0, 80),
    question: '为什么不会阻塞下一次渲染？',
    depth: 'CONTEXTUAL' as const,
  }
}

function processor(answer: (request: CourseQuestionRequest) => Promise<unknown>) {
  return new CourseQuestionJobProcessor(
    new CourseQuestionExecutionRepository(database),
    { answer },
    60_000,
  )
}

describe('M7 queued course question execution', () => {
  beforeAll(async () => database.$connect())
  afterAll(async () => database.$disconnect())

  it('claims the persisted question, saves the answer, and skips terminal replay', async () => {
    const { userId, taskId } = await createReadyCourse()
    let questionId: string | undefined
    try {
      const accepted = await new CourseQuestionService(database).ask(userId, taskId, input())
      questionId = accepted.id
      const contexts: CourseQuestionRequest[] = []
      const answer = vi.fn(async (request: CourseQuestionRequest) => {
        contexts.push(request)
        return { answer: '当前调用栈清空后，先处理微任务，再进入后续渲染调度。' }
      })
      const worker = processor(answer)
      await expect(worker.process({ questionId: accepted.id })).resolves.toMatchObject({
        status: 'SUCCEEDED',
      })
      await expect(worker.process({ questionId: accepted.id })).resolves.toMatchObject({
        status: 'SKIPPED',
        reason: 'TERMINAL',
      })
      expect(answer).toHaveBeenCalledOnce()
      const saved = await database.courseQuestion.findUniqueOrThrow({
        where: { id: accepted.id },
      })
      expect(saved).toMatchObject({ status: 'SUCCEEDED', executionVersion: 2 })
      expect(contexts[0]?.history).toEqual([])
      expect(JSON.stringify(contexts[0])).not.toContain('correctOptionId')
      expect(JSON.stringify(contexts[0])).not.toContain('rubric')
      expect(JSON.stringify(contexts[0])).not.toContain('exercises')
    } finally {
      if (questionId) await database.outboxEvent.deleteMany({ where: { aggregateId: questionId } })
      await database.user.delete({ where: { id: userId } })
    }
  })

  it('records model failure without changing course or task state', async () => {
    const { userId, taskId } = await createReadyCourse()
    let questionId: string | undefined
    try {
      const before = await database.task.findUniqueOrThrow({
        where: { id: taskId },
        select: { state: true, version: true, course: { select: { status: true } } },
      })
      const accepted = await new CourseQuestionService(database).ask(userId, taskId, input())
      questionId = accepted.id
      const answer = vi.fn(async () => Promise.reject(new Error('upstream secret must not leak')))
      await expect(processor(answer).process({ questionId: accepted.id })).resolves.toMatchObject({
        status: 'FAILED',
      })
      expect(
        await database.task.findUniqueOrThrow({
          where: { id: taskId },
          select: { state: true, version: true, course: { select: { status: true } } },
        }),
      ).toEqual(before)
      expect(
        await database.courseQuestion.findUniqueOrThrow({ where: { id: accepted.id } }),
      ).toMatchObject({ status: 'FAILED', errorCode: 'MODEL_UNAVAILABLE', answer: null })
    } finally {
      if (questionId) await database.outboxEvent.deleteMany({ where: { aggregateId: questionId } })
      await database.user.delete({ where: { id: userId } })
    }
  })

  it('expires an interrupted execution and rejects its late answer by version and deadline', async () => {
    const { userId, taskId } = await createReadyCourse()
    let questionId: string | undefined
    try {
      const accepted = await new CourseQuestionService(database).ask(userId, taskId, input())
      questionId = accepted.id
      const repository = new CourseQuestionExecutionRepository(database)
      const now = new Date()
      const claimed = await repository.claimForExecution(accepted.id, now, 1_000)
      if (claimed.status !== 'CLAIMED') throw new Error('Expected a claimed question')
      await expect(repository.timeoutExpired(10, new Date(now.getTime() + 1_001))).resolves.toEqual(
        [accepted.id],
      )
      await expect(
        repository.recordSuccess(
          accepted.id,
          claimed.question.expectedVersion,
          '迟到答案',
          new Date(now.getTime() + 1_002),
        ),
      ).resolves.toMatchObject({ status: 'SKIPPED', questionStatus: 'FAILED' })
      expect(
        await database.courseQuestion.findUniqueOrThrow({ where: { id: accepted.id } }),
      ).toMatchObject({ status: 'FAILED', errorCode: 'RUN_DEADLINE_EXCEEDED', answer: null })
    } finally {
      if (questionId) await database.outboxEvent.deleteMany({ where: { aggregateId: questionId } })
      await database.user.delete({ where: { id: userId } })
    }
  })
})
