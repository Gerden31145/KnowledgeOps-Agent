import { buildCourseExerciseReport, type CourseQuestionRequest } from '@knowledgeops/agent-core'
import { createDatabaseClient } from '@knowledgeops/database'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { validCourseLearningPackage } from '../../../packages/agent-core/test/fixtures/course-generation.js'
import { CourseQuestionService } from '../../api/src/courses/course-question.service.js'
import { CourseExerciseService } from '../../api/src/courses/course-exercise.service.js'
import { CourseExerciseExecutionRepository } from '../src/course-exercise/course-exercise-execution.repository.js'
import { CourseExerciseJobProcessor } from '../src/course-exercise/course-exercise-job-processor.js'
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
  await database.knowledgePoint.create({
    data: {
      planId,
      key: 'event-loop',
      title: '事件循环',
      description: '理解任务、微任务与渲染之间的调度顺序。',
      courses: { create: { course: { connect: { taskId } }, role: 'TEACH' } },
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

function exerciseInput(expectedTaskVersion = 0, correct = 4) {
  return {
    requestId: randomUUID(),
    expectedTaskVersion,
    multipleChoiceAnswers: validCourseLearningPackage.exercises.multipleChoice.map(
      (question, index) => ({
        questionId: question.id,
        optionId:
          index < correct
            ? question.correctOptionId
            : question.options.find((option) => option.id !== question.correctOptionId)!.id,
      }),
    ),
    followUpAnswer: '当前任务结束后会清空微任务队列，再进入后续渲染调度。',
  }
}

function exerciseProcessor(outcome: 'PASSED' | 'FAILED' | 'INSUFFICIENT_EVIDENCE' = 'PASSED') {
  return new CourseExerciseJobProcessor(
    new CourseExerciseExecutionRepository(database),
    {
      verify: async () => ({
        outcome,
        rationale: outcome === 'PASSED' ? '理解准确。' : '解释不完整。',
        suggestions: outcome === 'PASSED' ? [] : ['补充微任务与渲染的顺序。'],
      }),
    },
    60_000,
  )
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
      aggregateId: { in: [...questions, ...submissions].map((record) => record.id) },
    },
  })
  await database.user.delete({ where: { id: userId } })
}

describe('M7 queued course question execution', () => {
  beforeAll(async () => database.$connect())
  afterAll(async () => database.$disconnect())

  it('claims the persisted question, saves the answer, and skips terminal replay', async () => {
    const { userId, taskId } = await createReadyCourse()
    try {
      const accepted = await new CourseQuestionService(database).ask(userId, taskId, input())
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
      await cleanup(userId)
    }
  })

  it('records model failure without changing course or task state', async () => {
    const { userId, taskId } = await createReadyCourse()
    try {
      const before = await database.task.findUniqueOrThrow({
        where: { id: taskId },
        select: { state: true, version: true, course: { select: { status: true } } },
      })
      const accepted = await new CourseQuestionService(database).ask(userId, taskId, input())
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
      await cleanup(userId)
    }
  })

  it('expires an interrupted execution and rejects its late answer by version and deadline', async () => {
    const { userId, taskId } = await createReadyCourse()
    try {
      const accepted = await new CourseQuestionService(database).ask(userId, taskId, input())
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
      await cleanup(userId)
    }
  })

  it('passes a course and unlocks only dependent tasks after mixed acceptance', async () => {
    const { userId, taskId } = await createReadyCourse()
    try {
      const current = await database.task.findUniqueOrThrow({
        where: { id: taskId },
        select: { stageId: true },
      })
      const nextTaskId = randomUUID()
      await database.task.create({
        data: {
          id: nextTaskId,
          stage: { connect: { id: current.stageId } },
          title: '下一门课程',
          description: '依赖当前课程。',
          position: 1,
          type: 'COURSE',
          state: 'BLOCKED',
          estimatedMinutes: 30,
          course: { create: { status: 'PENDING' } },
          prerequisites: { create: { prerequisiteTaskId: taskId } },
        },
      })
      const accepted = await new CourseExerciseService(database).submit(
        userId,
        taskId,
        exerciseInput(),
      )
      await expect(
        exerciseProcessor().process({ submissionId: accepted.id }),
      ).resolves.toMatchObject({ status: 'SUCCEEDED' })
      expect(
        await database.courseExerciseSubmission.findUniqueOrThrow({ where: { id: accepted.id } }),
      ).toMatchObject({
        status: 'SUCCEEDED',
        report: { passed: true, correctCount: 4 },
      })
      expect(await database.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        state: 'PASSED',
        version: 1,
      })
      expect(await database.task.findUniqueOrThrow({ where: { id: nextTaskId } })).toMatchObject({
        state: 'READY',
        version: 1,
      })
    } finally {
      await cleanup(userId)
    }
  })

  it('keeps a failed business report in progress and accepts a corrected resubmission', async () => {
    const { userId, taskId } = await createReadyCourse()
    try {
      const exercises = new CourseExerciseService(database)
      const first = await exercises.submit(userId, taskId, exerciseInput(0, 2))
      await exerciseProcessor().process({ submissionId: first.id })
      expect(
        await database.courseExerciseSubmission.findUniqueOrThrow({ where: { id: first.id } }),
      ).toMatchObject({ status: 'SUCCEEDED', report: { passed: false, correctCount: 2 } })
      expect(await database.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        state: 'IN_PROGRESS',
        version: 1,
      })
      expect(
        await database.courseKnowledgeEvidence.count({ where: { submissionId: first.id } }),
      ).toBe(5)
      expect(await database.knowledgeMastery.findFirstOrThrow({ where: { userId } })).toMatchObject(
        {
          level: 'DEVELOPING',
          score: 60,
          evidenceCount: 5,
          misconceptionTags: ['选择题概念辨析'],
        },
      )

      const retry = await exercises.submit(userId, taskId, exerciseInput(1, 4))
      await exerciseProcessor().process({ submissionId: retry.id })
      expect(await database.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        state: 'PASSED',
        version: 2,
      })
      expect(
        await database.courseKnowledgeEvidence.count({ where: { submissionId: retry.id } }),
      ).toBe(0)
      expect(await database.knowledgeMastery.findFirstOrThrow({ where: { userId } })).toMatchObject(
        {
          level: 'DEVELOPING',
          score: 60,
          evidenceCount: 5,
          misconceptionTags: ['选择题概念辨析'],
        },
      )
    } finally {
      await cleanup(userId)
    }
  })

  it('rejects finalization when the task version changed during model execution', async () => {
    const { userId, taskId } = await createReadyCourse()
    try {
      const accepted = await new CourseExerciseService(database).submit(
        userId,
        taskId,
        exerciseInput(),
      )
      const repository = new CourseExerciseExecutionRepository(database)
      const claimed = await repository.claimForExecution(accepted.id, new Date(), 60_000)
      if (claimed.status !== 'CLAIMED') throw new Error('Expected a claimed submission')
      await database.task.update({ where: { id: taskId }, data: { version: { increment: 1 } } })
      const report = buildCourseExerciseReport(
        claimed.submission.exerciseSet,
        claimed.submission.answers,
        { outcome: 'PASSED', rationale: '理解准确。', suggestions: [] },
      )
      await expect(
        repository.recordSuccess(
          accepted.id,
          claimed.submission.expectedVersion,
          report,
          new Date(),
        ),
      ).resolves.toEqual({ status: 'RECORDED', submissionStatus: 'FAILED' })
      expect(
        await database.courseExerciseSubmission.findUniqueOrThrow({ where: { id: accepted.id } }),
      ).toMatchObject({ status: 'FAILED', errorCode: 'EXECUTION_CONTEXT_CHANGED' })
      expect(await database.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
        state: 'IN_PROGRESS',
        version: 1,
      })
    } finally {
      await cleanup(userId)
    }
  })

  it('keeps legacy exercise reports readable without inventing knowledge mappings', async () => {
    const { userId, taskId } = await createReadyCourse()
    try {
      await database.knowledgePoint.deleteMany({ where: { plan: { goal: { userId } } } })
      const exercises = new CourseExerciseService(database)
      const accepted = await exercises.submit(userId, taskId, exerciseInput())
      await exerciseProcessor().process({ submissionId: accepted.id })

      expect(
        await database.courseExerciseSubmission.findUniqueOrThrow({ where: { id: accepted.id } }),
      ).toMatchObject({ status: 'SUCCEEDED', report: { followUp: { outcome: 'PASSED' } } })
      await expect(exercises.history(userId, taskId)).resolves.toMatchObject({
        submissions: [{ id: accepted.id, status: 'SUCCEEDED' }],
      })
      expect(
        await database.courseKnowledgeEvidence.count({ where: { submissionId: accepted.id } }),
      ).toBe(0)
      expect(await database.knowledgeMastery.count({ where: { userId } })).toBe(0)
    } finally {
      await cleanup(userId)
    }
  })
})
