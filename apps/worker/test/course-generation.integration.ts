import type { CourseGenerationRequest } from '@knowledgeops/agent-core'
import { createDatabaseClient } from '@knowledgeops/database'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { PlanLifecycleRepository } from '../../api/src/plans/plan-lifecycle.repository.js'
import { CourseGenerationRepository } from '../../api/src/courses/course-generation.repository.js'
import { validPlanGenerationOutput } from '../../../packages/agent-core/test/fixtures/plan-generation.js'
import { validCourseLearningPackage } from '../../../packages/agent-core/test/fixtures/course-generation.js'
import { PlanGenerationJobProcessor } from '../src/plan-generation/plan-generation-job-processor.js'
import { PlanGenerationRunRepository } from '../src/plan-generation/plan-generation-run.repository.js'
import { FinalizePlanGenerationRun } from '../src/plan-generation/finalize-plan-generation-run.js'
import { CourseGenerationJobProcessor } from '../src/course-generation/course-generation-job-processor.js'
import { CourseGenerationRunRepository } from '../src/course-generation/course-generation-run.repository.js'
import { FinalizeCourseGenerationRun } from '../src/course-generation/finalize-course-generation-run.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for the M7 integration test')
const database = createDatabaseClient(databaseUrl)

async function createCoursePlan() {
  const userId = randomUUID()
  const goalId = randomUUID()
  const planRunId = randomUUID()
  const now = new Date()
  await database.user.create({
    data: {
      id: userId,
      goals: {
        create: {
          id: goalId,
          title: 'Prepare for frontend internship interviews',
          currentLevel: 'Comfortable with Vue 3 and TypeScript, new to browser internals.',
          deadline: new Date(now.getTime() + 30 * 86_400_000),
          weeklyMinutes: 600,
          planGenerationRuns: {
            create: {
              id: planRunId,
              modelCatalogId: 'openai-primary',
              modelProvider: 'openai',
              modelName: 'test-model',
              promptVersion: 'plan-generation-v3',
              outputSchemaVersion: 'plan-generation-output-v3',
              queuedAt: now,
              deadlineAt: new Date(now.getTime() + 300_000),
            },
          },
        },
      },
    },
  })
  await new PlanGenerationJobProcessor(
    new PlanGenerationRunRepository(database),
    { generate: async () => validPlanGenerationOutput },
    new FinalizePlanGenerationRun(database),
  ).process({ generationRunId: planRunId })
  const plan = await database.plan.findUniqueOrThrow({
    where: { generationRunId: planRunId },
    include: { stages: { include: { tasks: { include: { course: true } } } } },
  })
  return { plan, planRunId, userId }
}

function courseProcessor(generate: (request: CourseGenerationRequest) => Promise<unknown>) {
  return new CourseGenerationJobProcessor(
    new CourseGenerationRunRepository(database),
    { generate },
    new FinalizeCourseGenerationRun(database),
  )
}

describe('M7 course learning package persistence', () => {
  beforeAll(async () => database.$connect())
  afterAll(async () => database.$disconnect())

  it('atomically saves the course version and exercises, then replays without regeneration', async () => {
    const { plan, userId } = await createCoursePlan()
    try {
      const tasks = plan.stages.flatMap((stage) => stage.tasks)
      expect(tasks).toHaveLength(3)
      expect(tasks.every((task) => task.type === 'COURSE' && task.course)).toBe(true)
      expect(await database.knowledgePoint.count({ where: { planId: plan.id } })).toBe(3)

      await new PlanLifecycleRepository(database).confirmPlan(plan.id, userId)
      const firstTask = tasks[0]!.id
      const initialRun = await database.courseGenerationRun.findFirstOrThrow({
        where: { course: { task: { id: firstTask, state: 'READY' } } },
        include: { course: true },
      })
      expect(initialRun.course.status).toBe('GENERATING')
      expect(
        await database.outboxEvent.count({
          where: { aggregateId: initialRun.id, type: 'COURSE_GENERATION_REQUESTED' },
        }),
      ).toBe(1)

      const generate = vi.fn(async () => validCourseLearningPackage)
      const processor = courseProcessor(generate)
      expect(await processor.process({ generationRunId: initialRun.id })).toMatchObject({
        status: 'SUCCEEDED',
      })
      expect(await processor.process({ generationRunId: initialRun.id })).toMatchObject({
        status: 'SKIPPED',
        reason: 'TERMINAL',
      })
      expect(generate).toHaveBeenCalledOnce()
      const saved = await database.course.findUniqueOrThrow({
        where: { id: initialRun.courseId },
        include: { versions: { include: { exerciseSet: true } } },
      })
      expect(saved.status).toBe('READY')
      expect(saved.versions).toHaveLength(1)
      expect(saved.versions[0]!.content).toEqual({
        sections: JSON.parse(JSON.stringify(validCourseLearningPackage.sections)),
      })
      expect(saved.versions[0]!.exerciseSet?.body).toEqual(
        JSON.parse(JSON.stringify(validCourseLearningPackage.exercises)),
      )
      await expect(
        new PlanLifecycleRepository(database).startTask(firstTask, userId, {}),
      ).resolves.toMatchObject({ state: 'IN_PROGRESS', targetPath: null })
    } finally {
      await database.user.delete({ where: { id: userId } })
    }
  })

  it('freezes at most two related weak points and excludes mastered, unrelated, and other users', async () => {
    const { plan, userId } = await createCoursePlan()
    const otherUserId = randomUUID()
    try {
      await database.user.create({ data: { id: otherUserId } })
      await new PlanLifecycleRepository(database).confirmPlan(plan.id, userId)
      const tasks = plan.stages.flatMap((stage) => stage.tasks)
      const nextTask = tasks[1]!
      await database.task.update({ where: { id: nextTask.id }, data: { state: 'READY' } })
      const points = await database.knowledgePoint.findMany({
        where: { planId: plan.id },
        orderBy: { key: 'asc' },
      })
      const byKey = new Map(points.map((point) => [point.key, point]))
      const mastered = await database.knowledgePoint.create({
        data: {
          planId: plan.id,
          key: 'mastered-related',
          title: '已掌握关联知识',
          description: '用于验证已掌握内容不会重复进入复习。',
        },
      })
      const unrelated = await database.knowledgePoint.create({
        data: {
          planId: plan.id,
          key: 'unrelated-weak',
          title: '无关薄弱知识',
          description: '用于验证当前课程只读取直接关联的薄弱点。',
        },
      })
      byKey.set(mastered.key, mastered)
      byKey.set(unrelated.key, unrelated)
      await database.courseKnowledgePoint.createMany({
        data: [
          {
            courseId: nextTask.course!.id,
            knowledgePointId: byKey.get('vue-next-tick')!.id,
            role: 'TEACH',
          },
          {
            courseId: nextTask.course!.id,
            knowledgePointId: mastered.id,
            role: 'TEACH',
          },
        ],
      })
      const masteryRows = [
        { key: 'event-loop', level: 'WEAK', score: 40 },
        { key: 'rendering-pipeline', level: 'DEVELOPING', score: 60 },
        { key: 'vue-next-tick', level: 'WEAK', score: 20 },
        { key: mastered.key, level: 'MASTERED', score: 100 },
        { key: unrelated.key, level: 'WEAK', score: 0 },
      ] as const
      for (const row of masteryRows) {
        const knowledgePointId = byKey.get(row.key)!.id
        await database.knowledgeMastery.create({
          data: {
            userId,
            knowledgePointId,
            level: row.level,
            score: row.score,
            evidenceCount: 5,
            misconceptionTags: ['选择题概念辨析'],
          },
        })
      }
      await database.knowledgeMastery.create({
        data: {
          userId: otherUserId,
          knowledgePointId: byKey.get('event-loop')!.id,
          level: 'WEAK',
          score: 0,
          evidenceCount: 5,
        },
      })

      const accepted = await new CourseGenerationRepository(database, 300_000).request(
        nextTask.id,
        userId,
      )
      const run = await database.courseGenerationRun.findUniqueOrThrow({
        where: { id: accepted.generationRunId },
      })
      expect(run.profileSnapshot).toEqual([
        expect.objectContaining({ key: 'vue-next-tick', mastery: 'WEAK' }),
        expect.objectContaining({ key: 'event-loop', mastery: 'WEAK' }),
      ])
      expect(JSON.stringify(run.profileSnapshot)).not.toContain('mastered-related')
      expect(JSON.stringify(run.profileSnapshot)).not.toContain('unrelated-weak')
      expect(JSON.stringify(run.profileSnapshot)).not.toContain(otherUserId)

      await database.knowledgeMastery.updateMany({
        where: { userId },
        data: { level: 'MASTERED', score: 100 },
      })
      const generate = vi.fn(async (request: CourseGenerationRequest) => {
        expect(request.review).toEqual(run.profileSnapshot)
        return validCourseLearningPackage
      })
      await courseProcessor(generate).process({ generationRunId: accepted.generationRunId })
      expect(generate).toHaveBeenCalledOnce()
    } finally {
      await database.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } })
    }
  })

  it('keeps a failed course retryable without exposing a partial version', async () => {
    const { plan, userId } = await createCoursePlan()
    try {
      await new PlanLifecycleRepository(database).confirmPlan(plan.id, userId)
      const run = await database.courseGenerationRun.findFirstOrThrow({
        where: { course: { task: { stage: { planId: plan.id } } } },
        include: { course: { select: { taskId: true } } },
      })
      const invalid = structuredClone(validCourseLearningPackage)
      invalid.exercises.multipleChoice[0]!.knowledgePointId = 'unknown'
      expect(
        await courseProcessor(async () => invalid).process({ generationRunId: run.id }),
      ).toMatchObject({ status: 'FAILED' })
      expect(await database.courseVersion.count({ where: { courseId: run.courseId } })).toBe(0)
      expect(
        await database.course.findUniqueOrThrow({ where: { id: run.courseId } }),
      ).toMatchObject({ status: 'FAILED' })

      const accepted = await new CourseGenerationRepository(database, 300_000).request(
        run.course.taskId,
        userId,
        run.id,
      )
      expect(accepted.status).toBe('QUEUED')
      expect(
        await courseProcessor(async () => validCourseLearningPackage).process({
          generationRunId: accepted.generationRunId,
        }),
      ).toMatchObject({ status: 'SUCCEEDED' })
      expect(
        await database.course.findUniqueOrThrow({ where: { id: run.courseId } }),
      ).toMatchObject({ status: 'READY' })
    } finally {
      await database.user.delete({ where: { id: userId } })
    }
  })
})
