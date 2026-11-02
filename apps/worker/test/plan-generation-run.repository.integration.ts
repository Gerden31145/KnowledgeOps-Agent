import { PlanGenerationModelError, type PlanGenerationPort } from '@knowledgeops/agent-core'
import { createDatabaseClient } from '@knowledgeops/database'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  FinalizePlanGenerationRun,
  type PlanGenerationSuccessFinalizer,
} from '../src/plan-generation/finalize-plan-generation-run.js'
import { PlanGenerationJobProcessor } from '../src/plan-generation/plan-generation-job-processor.js'
import { PlanGenerationRunRepository } from '../src/plan-generation/plan-generation-run.repository.js'
import { validPlanGenerationOutput } from '../../../packages/agent-core/test/fixtures/plan-generation.js'

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for the 08-10 integration test')
}

const database = createDatabaseClient(databaseUrl)

async function createQueuedRun(options: { deadlineAt: Date; queuedAt: Date }) {
  const userId = randomUUID()
  const goalId = randomUUID()
  const generationRunId = randomUUID()

  await database.user.create({
    data: {
      id: userId,
      timezone: 'Asia/Shanghai',
      goals: {
        create: {
          id: goalId,
          title: 'Prepare for frontend interviews',
          currentLevel: 'Comfortable with Vue 3 and TypeScript, new to backend architecture.',
          deadline: new Date('2026-09-20T00:00:00.000Z'),
          weeklyMinutes: 600,
          planGenerationRuns: {
            create: {
              id: generationRunId,
              modelCatalogId: 'openai-primary',
              modelProvider: 'openai',
              modelName: 'test-model',
              promptVersion: 'plan-generation-v1',
              outputSchemaVersion: 'plan-generation-output-v1',
              queuedAt: options.queuedAt,
              deadlineAt: options.deadlineAt,
            },
          },
        },
      },
    },
  })

  return { generationRunId, goalId, userId }
}

describe('PlanGenerationRunRepository against PostgreSQL', () => {
  beforeAll(async () => {
    await database.$connect()
  })

  afterAll(async () => {
    await database.$disconnect()
  })

  it('replays the same completed plan job three times without regenerating or changing the graph', async () => {
    const ids = await createQueuedRun({
      queuedAt: new Date(),
      deadlineAt: new Date(Date.now() + 60_000),
    })
    const generate = vi.fn(async () => validPlanGenerationOutput)
    const processor = () =>
      new PlanGenerationJobProcessor(
        new PlanGenerationRunRepository(database),
        { generate },
        new FinalizePlanGenerationRun(database),
      )
    const snapshot = () =>
      database.plan.findUniqueOrThrow({
        where: { generationRunId: ids.generationRunId },
        include: {
          generationRun: true,
          stages: {
            orderBy: { position: 'asc' },
            include: {
              tasks: {
                orderBy: { position: 'asc' },
                include: {
                  criteria: { orderBy: { position: 'asc' } },
                  prerequisites: { orderBy: { prerequisiteTaskId: 'asc' } },
                },
              },
            },
          },
        },
      })
    try {
      await database.learningGoal.update({
        where: { id: ids.goalId },
        data: {
          deadline: new Date(Date.now() + 30 * 86400_000),
        },
      })
      expect(await processor().process({ generationRunId: ids.generationRunId })).toMatchObject({
        status: 'SUCCEEDED',
      })
      const saved = await snapshot()
      expect(saved.stages.flatMap((stage) => stage.tasks)).toHaveLength(3)
      // 每次重建消费者对象，仍由数据库终态识别原 Job，不能依赖进程内记忆。
      for (let replay = 0; replay < 3; replay++) {
        expect(await processor().process({ generationRunId: ids.generationRunId })).toEqual({
          generationRunId: ids.generationRunId,
          status: 'SKIPPED',
          reason: 'TERMINAL',
          runStatus: 'SUCCEEDED',
          planId: saved.id,
        })
        expect(await snapshot()).toEqual(saved)
      }
      expect(generate).toHaveBeenCalledOnce()
      expect(await database.plan.count({ where: { goalId: ids.goalId } })).toBe(1)
    } finally {
      await database.plan.deleteMany({ where: { goalId: ids.goalId } })
      await database.user.delete({ where: { id: ids.userId } })
    }
  })

  it('uses the run version as a fencing token between repeated executions', async () => {
    const ids = await createQueuedRun({
      queuedAt: new Date('2026-09-03T08:00:00.000Z'),
      deadlineAt: new Date('2026-09-03T08:10:00.000Z'),
    })
    const repository = new PlanGenerationRunRepository(database)

    try {
      const first = await repository.claimForExecution(
        ids.generationRunId,
        new Date('2026-09-03T08:01:00.000Z'),
      )
      const second = await repository.claimForExecution(
        ids.generationRunId,
        new Date('2026-09-03T08:02:00.000Z'),
      )

      expect(first).toMatchObject({ status: 'CLAIMED', run: { expectedVersion: 1 } })
      expect(second).toMatchObject({ status: 'CLAIMED', run: { expectedVersion: 2 } })
      await expect(
        repository.recordFailure(
          ids.generationRunId,
          1,
          { code: 'OLD_ATTEMPT', message: 'stale', status: 'FAILED' },
          new Date('2026-09-03T08:03:00.000Z'),
        ),
      ).resolves.toMatchObject({ status: 'SKIPPED', runStatus: 'RUNNING' })
      await expect(
        repository.recordFailure(
          ids.generationRunId,
          2,
          { code: 'MODEL_UPSTREAM_ERROR', message: 'provider unavailable', status: 'FAILED' },
          new Date('2026-09-03T08:03:00.000Z'),
        ),
      ).resolves.toEqual({ status: 'RECORDED', runStatus: 'FAILED' })
      await expect(
        repository.claimForExecution(ids.generationRunId, new Date('2026-09-03T08:04:00.000Z')),
      ).resolves.toMatchObject({ status: 'SKIPPED', runStatus: 'FAILED', reason: 'TERMINAL' })
    } finally {
      await database.user.delete({ where: { id: ids.userId } })
    }
  })

  it('times out expired queued runs and rejects a late execution', async () => {
    const ids = await createQueuedRun({
      queuedAt: new Date('2026-09-03T08:00:00.000Z'),
      deadlineAt: new Date('2026-09-03T08:01:00.000Z'),
    })
    const repository = new PlanGenerationRunRepository(database)

    try {
      await expect(
        repository.timeoutExpired(10, new Date('2026-09-03T08:02:00.000Z')),
      ).resolves.toContain(ids.generationRunId)
      await expect(
        repository.claimForExecution(ids.generationRunId, new Date('2026-09-03T08:03:00.000Z')),
      ).resolves.toMatchObject({ status: 'SKIPPED', runStatus: 'TIMED_OUT' })
      await expect(
        database.planGenerationRun.findUniqueOrThrow({ where: { id: ids.generationRunId } }),
      ).resolves.toMatchObject({
        status: 'TIMED_OUT',
        errorCode: 'RUN_DEADLINE_EXCEEDED',
        version: 1,
      })
    } finally {
      await database.user.delete({ where: { id: ids.userId } })
    }
  })

  it('persists a model failure without creating any partial plan rows', async () => {
    const ids = await createQueuedRun({
      queuedAt: new Date('2026-09-03T08:00:00.000Z'),
      deadlineAt: new Date('2026-09-03T08:10:00.000Z'),
    })
    const repository = new PlanGenerationRunRepository(database)
    const generator: PlanGenerationPort = {
      generate: async () => {
        throw new PlanGenerationModelError('MODEL_UPSTREAM_ERROR', 'provider unavailable')
      },
    }
    const execute = vi.fn(async () => ({ status: 'FINALIZED' as const, planId: randomUUID() }))
    const finalizer = { execute } as PlanGenerationSuccessFinalizer
    const processor = new PlanGenerationJobProcessor(
      repository,
      generator,
      finalizer,
      () => {},
      () => new Date('2026-09-03T08:05:00.000Z'),
    )

    try {
      await expect(processor.process({ generationRunId: ids.generationRunId })).resolves.toEqual({
        generationRunId: ids.generationRunId,
        status: 'FAILED',
      })
      await expect(
        database.planGenerationRun.findUniqueOrThrow({ where: { id: ids.generationRunId } }),
      ).resolves.toMatchObject({ status: 'FAILED', errorCode: 'MODEL_UPSTREAM_ERROR' })
      await expect(database.plan.count({ where: { goalId: ids.goalId } })).resolves.toBe(0)
      expect(execute).not.toHaveBeenCalled()
    } finally {
      await database.user.delete({ where: { id: ids.userId } })
    }
  })
})
