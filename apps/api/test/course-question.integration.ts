import type { CourseQuestionPort, CourseQuestionRequest } from '@knowledgeops/agent-core'
import type { AskCourseQuestionInput } from '@knowledgeops/contracts'
import { createDatabaseClient } from '@knowledgeops/database'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { validCourseLearningPackage } from '../../../packages/agent-core/test/fixtures/course-generation.js'
import {
  CourseQuestionConflictError,
  CourseQuestionNotFoundError,
  CourseQuestionService,
  CourseQuestionUnavailableError,
} from '../src/courses/course-question.service.js'

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

function input(requestId = randomUUID()): AskCourseQuestionInput {
  return {
    requestId,
    sectionId: validCourseLearningPackage.sections[0]!.id,
    selectedText: validCourseLearningPackage.sections[0]!.explanation.slice(0, 80),
    question: '为什么不会阻塞下一次渲染？',
    depth: 'CONTEXTUAL',
  }
}

describe('M7 selected-text course questions', () => {
  beforeAll(async () => database.$connect())
  afterAll(async () => database.$disconnect())

  it('persists and replays a synchronized answer without reading exercise answers', async () => {
    const { userId, taskId } = await createReadyCourse()
    try {
      const contexts: CourseQuestionRequest[] = []
      const answer = vi.fn(async (request: CourseQuestionRequest) => {
        contexts.push(request)
        return { answer: '当前调用栈清空后，先处理微任务，再进入后续渲染调度。' }
      })
      const service = new CourseQuestionService(database, { answer }, 60_000)
      const command = input()
      const saved = await service.ask(userId, taskId, command)
      expect(saved).toMatchObject({ status: 'SUCCEEDED', depth: 'CONTEXTUAL' })
      expect(saved.answer).toContain('微任务')
      await expect(service.ask(userId, taskId, command)).resolves.toEqual(saved)
      expect(answer).toHaveBeenCalledOnce()
      const context = contexts[0]!
      expect(context.history).toEqual([])
      expect(JSON.stringify(context)).not.toContain('correctOptionId')
      expect(JSON.stringify(context)).not.toContain('rubric')
      expect(JSON.stringify(context)).not.toContain('exercises')

      await expect(
        service.ask(userId, taskId, { ...command, question: '换一个内容重放原请求' }),
      ).rejects.toBeInstanceOf(CourseQuestionConflictError)
      expect(answer).toHaveBeenCalledOnce()
      await expect(service.history(userId, taskId)).resolves.toMatchObject({
        questions: [{ id: saved.id, answer: saved.answer }],
      })
    } finally {
      await database.user.delete({ where: { id: userId } })
    }
  })

  it('isolates history and rejects text outside the selected section', async () => {
    const { userId, taskId } = await createReadyCourse()
    const otherUserId = randomUUID()
    try {
      await database.user.create({ data: { id: otherUserId } })
      const answer = vi.fn(async () => ({ answer: '结合当前区块回答。' }))
      const service = new CourseQuestionService(database, { answer }, 60_000)
      await expect(service.ask(otherUserId, taskId, input())).rejects.toBeInstanceOf(
        CourseQuestionNotFoundError,
      )
      await expect(service.history(otherUserId, taskId)).rejects.toBeInstanceOf(
        CourseQuestionNotFoundError,
      )
      await expect(
        service.ask(userId, taskId, { ...input(), selectedText: '不属于课程的伪造文本' }),
      ).rejects.toBeInstanceOf(CourseQuestionConflictError)
      expect(answer).not.toHaveBeenCalled()
    } finally {
      await database.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } })
    }
  })

  it('records model failure without changing course or task state', async () => {
    const { userId, taskId } = await createReadyCourse()
    try {
      const before = await database.task.findUniqueOrThrow({
        where: { id: taskId },
        select: { state: true, version: true, course: { select: { status: true } } },
      })
      const service = new CourseQuestionService(
        database,
        { answer: async () => Promise.reject(new Error('upstream secret must not leak')) },
        60_000,
      )
      await expect(service.ask(userId, taskId, input())).rejects.toBeInstanceOf(
        CourseQuestionUnavailableError,
      )
      expect(
        await database.task.findUniqueOrThrow({
          where: { id: taskId },
          select: { state: true, version: true, course: { select: { status: true } } },
        }),
      ).toEqual(before)
      const history = await service.history(userId, taskId)
      expect(history.questions).toHaveLength(1)
      expect(history.questions[0]).toMatchObject({ status: 'FAILED', answer: null })
    } finally {
      await database.user.delete({ where: { id: userId } })
    }
  })

  it('does not call the model twice for concurrent replay of the same request', async () => {
    const { userId, taskId } = await createReadyCourse()
    try {
      let resolveAnswer!: (value: { answer: string }) => void
      const answer = vi.fn(
        () =>
          new Promise<{ answer: string }>((resolve) => {
            resolveAnswer = resolve
          }),
      )
      const port: CourseQuestionPort = { answer }
      const service = new CourseQuestionService(database, port, 60_000)
      const command = input()
      const first = service.ask(userId, taskId, command)
      await vi.waitFor(() => expect(answer).toHaveBeenCalledOnce())
      await expect(service.ask(userId, taskId, command)).rejects.toBeInstanceOf(
        CourseQuestionConflictError,
      )
      resolveAnswer({ answer: '同一请求只生成一次回答。' })
      await expect(first).resolves.toMatchObject({ status: 'SUCCEEDED' })
      expect(answer).toHaveBeenCalledOnce()
    } finally {
      await database.user.delete({ where: { id: userId } })
    }
  })
})
