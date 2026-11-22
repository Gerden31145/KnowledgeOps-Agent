import type { AskCourseQuestionInput, SubmitCourseExerciseInput } from '@knowledgeops/contracts'
import { createDatabaseClient } from '@knowledgeops/database'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { validCourseLearningPackage } from '../../../packages/agent-core/test/fixtures/course-generation.js'
import { CourseGenerationRepository } from '../src/courses/course-generation.repository.js'
import {
  CourseQuestionConflictError,
  CourseQuestionNotFoundError,
  CourseQuestionService,
} from '../src/courses/course-question.service.js'
import {
  CourseExerciseConflictError,
  CourseExerciseNotFoundError,
  CourseExerciseService,
} from '../src/courses/course-exercise.service.js'
import { TaskNotFoundError } from '../src/plans/plan-lifecycle.errors.js'

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

function exerciseInput(requestId = randomUUID()): SubmitCourseExerciseInput {
  return {
    requestId,
    expectedTaskVersion: 0,
    multipleChoiceAnswers: validCourseLearningPackage.exercises.multipleChoice.map((question) => ({
      questionId: question.id,
      optionId: question.correctOptionId,
    })),
    followUpAnswer: '当前任务结束后会清空微任务队列，再进入后续渲染调度。',
  }
}

async function cleanup(userId: string) {
  const questions = await database.courseQuestion.findMany({
    where: { userId },
    select: { id: true },
  })
  const submissions = await database.courseExerciseSubmission.findMany({
    where: { userId },
    select: { id: true },
  })
  await database.outboxEvent.deleteMany({
    where: {
      aggregateId: {
        in: [...questions, ...submissions].map((record) => record.id),
      },
    },
  })
  await database.user.delete({ where: { id: userId } })
}

describe('M7 selected-text course question acceptance', () => {
  beforeAll(async () => database.$connect())
  afterAll(async () => database.$disconnect())

  it('atomically saves a queued question and outbox, then replays the persisted state', async () => {
    const { userId, taskId } = await createReadyCourse()
    try {
      const service = new CourseQuestionService(database)
      const command = input()
      const saved = await service.ask(userId, taskId, command)
      expect(saved).toMatchObject({ status: 'QUEUED', answer: null, depth: 'CONTEXTUAL' })
      const event = await database.outboxEvent.findUniqueOrThrow({
        where: { deduplicationKey: `course-question-requested-${saved.id}` },
      })
      expect(event).toMatchObject({
        type: 'COURSE_QUESTION_REQUESTED',
        aggregateId: saved.id,
        payload: { questionId: saved.id },
        dispatchedAt: null,
      })

      await database.courseQuestion.update({
        where: { id: saved.id },
        data: {
          status: 'RUNNING',
          executionVersion: 1,
          deadlineAt: new Date(Date.now() + 60_000),
        },
      })
      await expect(service.ask(userId, taskId, command)).resolves.toMatchObject({
        id: saved.id,
        status: 'RUNNING',
      })
      await database.courseQuestion.update({
        where: { id: saved.id },
        data: { status: 'FAILED', errorCode: 'MODEL_UNAVAILABLE', completedAt: new Date() },
      })
      await expect(service.ask(userId, taskId, command)).resolves.toMatchObject({
        id: saved.id,
        status: 'FAILED',
      })
      expect(await database.outboxEvent.count({ where: { aggregateId: saved.id } })).toBe(1)

      await expect(
        service.ask(userId, taskId, { ...command, question: '换一个内容重放原请求' }),
      ).rejects.toBeInstanceOf(CourseQuestionConflictError)
      await expect(service.history(userId, taskId)).resolves.toMatchObject({
        questions: [{ id: saved.id, status: 'FAILED', answer: null }],
      })
    } finally {
      await cleanup(userId)
    }
  })

  it('isolates history and rejects text outside the selected section without creating intents', async () => {
    const { userId, taskId } = await createReadyCourse()
    const otherUserId = randomUUID()
    try {
      await database.user.create({ data: { id: otherUserId } })
      const service = new CourseQuestionService(database)
      await expect(service.ask(otherUserId, taskId, input())).rejects.toBeInstanceOf(
        CourseQuestionNotFoundError,
      )
      await expect(service.history(otherUserId, taskId)).rejects.toBeInstanceOf(
        CourseQuestionNotFoundError,
      )
      await expect(
        service.ask(userId, taskId, { ...input(), selectedText: '不属于课程的伪造文本' }),
      ).rejects.toBeInstanceOf(CourseQuestionConflictError)
      expect(await database.courseQuestion.count({ where: { userId } })).toBe(0)
    } finally {
      await database.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } })
    }
  })

  it('creates only one question and outbox for concurrent replay of the same request', async () => {
    const { userId, taskId } = await createReadyCourse()
    try {
      const service = new CourseQuestionService(database)
      const command = input()
      const accepted = await Promise.all(
        Array.from({ length: 6 }, () => service.ask(userId, taskId, command)),
      )
      expect(
        accepted.every((item) => item.id === accepted[0]!.id && item.status === 'QUEUED'),
      ).toBe(true)
      expect(await database.courseQuestion.count({ where: { userId } })).toBe(1)
      expect(await database.outboxEvent.count({ where: { aggregateId: accepted[0]!.id } })).toBe(1)
    } finally {
      await cleanup(userId)
    }
  })

  it('atomically accepts an exercise submission and replays only the identical command', async () => {
    const { userId, taskId } = await createReadyCourse()
    try {
      const service = new CourseExerciseService(database)
      const command = exerciseInput()
      const accepted = await service.submit(userId, taskId, command)
      expect(accepted).toMatchObject({ status: 'QUEUED', report: null })
      expect(
        await database.outboxEvent.count({
          where: { aggregateId: accepted.id, type: 'COURSE_EXERCISE_REQUESTED' },
        }),
      ).toBe(1)
      await expect(service.submit(userId, taskId, command)).resolves.toEqual(accepted)
      await expect(
        service.submit(userId, taskId, { ...command, followUpAnswer: '修改后的回答' }),
      ).rejects.toBeInstanceOf(CourseExerciseConflictError)
      await expect(service.history(userId, taskId)).resolves.toMatchObject({
        submissions: [{ id: accepted.id, status: 'QUEUED' }],
      })
    } finally {
      await cleanup(userId)
    }
  })

  it('rejects stale task versions and a second active submission without new intents', async () => {
    const { userId, taskId } = await createReadyCourse()
    try {
      const service = new CourseExerciseService(database)
      await expect(
        service.submit(userId, taskId, { ...exerciseInput(), expectedTaskVersion: 9 }),
      ).rejects.toBeInstanceOf(CourseExerciseConflictError)
      const accepted = await service.submit(userId, taskId, exerciseInput())
      await expect(service.submit(userId, taskId, exerciseInput())).rejects.toBeInstanceOf(
        CourseExerciseConflictError,
      )
      expect(await database.courseExerciseSubmission.count({ where: { userId } })).toBe(1)
      expect(await database.outboxEvent.count({ where: { aggregateId: accepted.id } })).toBe(1)
    } finally {
      await cleanup(userId)
    }
  })

  it('rejects cross-user generation and exercise commands without creating new intents', async () => {
    const { userId, taskId } = await createReadyCourse()
    const otherUserId = randomUUID()
    try {
      await database.user.create({ data: { id: otherUserId } })
      const generation = new CourseGenerationRepository(database, 60_000)
      const exercises = new CourseExerciseService(database)

      await expect(generation.request(taskId, otherUserId)).rejects.toBeInstanceOf(
        TaskNotFoundError,
      )
      await expect(exercises.submit(otherUserId, taskId, exerciseInput())).rejects.toBeInstanceOf(
        CourseExerciseNotFoundError,
      )
      await expect(exercises.history(otherUserId, taskId)).rejects.toBeInstanceOf(
        CourseExerciseNotFoundError,
      )

      expect(await database.courseGenerationRun.count({ where: { course: { taskId } } })).toBe(1)
      expect(
        await database.courseExerciseSubmission.count({ where: { userId: otherUserId } }),
      ).toBe(0)
      expect(await database.courseQuestion.count({ where: { userId: otherUserId } })).toBe(0)
    } finally {
      await database.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } })
    }
  })
})
