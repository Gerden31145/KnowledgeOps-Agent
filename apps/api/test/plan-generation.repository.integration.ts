import { createDatabaseClient } from '@knowledgeops/database'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ActivePlanGenerationRunError } from '../src/plan-generation/plan-generation.errors.js'
import { PlanGenerationRepository } from '../src/plan-generation/plan-generation.repository.js'
import { PlanGenerationRunRepository } from '../../worker/src/plan-generation/plan-generation-run.repository.js'

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for the 08-07 integration test')
}

const database = createDatabaseClient(databaseUrl)

const MODEL_SNAPSHOT = {
  catalogId: 'configured-primary',
  provider: 'configured',
  modelName: 'configured-model',
  promptVersion: 'prompt-v1',
  outputSchemaVersion: 'schema-v1',
} as const

const QUEUED_AT = new Date('2026-08-08T10:00:00.000Z')
const DEADLINE_AT = new Date('2026-08-08T10:03:00.000Z')

async function createOwnedGoal() {
  const userId = randomUUID()
  const goalId = randomUUID()

  await database.user.create({
    data: {
      id: userId,
      timezone: 'Asia/Shanghai',
      goals: {
        create: {
          id: goalId,
          title: 'Prepare for frontend interviews',
          currentLevel: 'Comfortable with Vue 3',
          deadline: new Date('2026-09-01T00:00:00.000Z'),
          weeklyMinutes: 600,
        },
      },
    },
  })

  return { userId, goalId }
}

async function cleanup(userId: string, runIds: string[]) {
  await database.outboxEvent.deleteMany({
    where: {
      aggregateId: {
        in: runIds,
      },
    },
  })
  await database.user.delete({ where: { id: userId } })
}

describe('PlanGenerationRepository against PostgreSQL', () => {
  it.each([undefined, 'low', 'high', 'max'] as const)(
    'preserves reasoning effort %s through intake, persistence and worker claim',
    async (reasoningEffort) => {
      const { userId, goalId } = await createOwnedGoal()
      const runId = randomUUID()
      const model = { ...MODEL_SNAPSHOT, ...(reasoningEffort ? { reasoningEffort } : {}) }
      try {
        await new PlanGenerationRepository(database, () => runId).accept({
          actorUserId: userId,
          goalId,
          model,
          queuedAt: QUEUED_AT,
          deadlineAt: DEADLINE_AT,
        })
        // A later catalog change must not alter the persisted request consumed by a worker.
        model.reasoningEffort = reasoningEffort === 'low' ? 'max' : 'low'
        const saved = await database.planGenerationRun.findUniqueOrThrow({ where: { id: runId } })
        expect(saved.modelReasoningEffort).toBe(reasoningEffort ?? null)
        const claimed = await new PlanGenerationRunRepository(database).claimForExecution(
          runId,
          new Date(QUEUED_AT.getTime() + 1_000),
        )
        expect(claimed.status).toBe('CLAIMED')
        if (claimed.status !== 'CLAIMED') throw new Error('Expected claimed run')
        expect(claimed.run.request.model.reasoningEffort).toBe(reasoningEffort)
        if (!reasoningEffort)
          expect(claimed.run.request.model).not.toHaveProperty('reasoningEffort')
      } finally {
        await cleanup(userId, [runId])
      }
    },
  )
  beforeAll(async () => {
    await database.$connect()
  })

  afterAll(async () => {
    await database.$disconnect()
  })

  it('atomically persists a queued run, its minimal outbox event, and the user preference', async () => {
    const { userId, goalId } = await createOwnedGoal()
    const runId = randomUUID()
    const repository = new PlanGenerationRepository(database, () => runId)

    try {
      await expect(
        repository.accept({
          actorUserId: userId,
          goalId,
          model: MODEL_SNAPSHOT,
          queuedAt: QUEUED_AT,
          deadlineAt: DEADLINE_AT,
        }),
      ).resolves.toEqual({ generationRunId: runId, status: 'QUEUED' })

      const [run, event, user] = await Promise.all([
        database.planGenerationRun.findUniqueOrThrow({ where: { id: runId } }),
        database.outboxEvent.findUniqueOrThrow({
          where: { deduplicationKey: `plan-generation-requested-${runId}` },
        }),
        database.user.findUniqueOrThrow({ where: { id: userId } }),
      ])

      expect(run).toMatchObject({
        goalId,
        status: 'QUEUED',
        modelCatalogId: MODEL_SNAPSHOT.catalogId,
        modelProvider: MODEL_SNAPSHOT.provider,
        modelName: MODEL_SNAPSHOT.modelName,
        promptVersion: MODEL_SNAPSHOT.promptVersion,
        outputSchemaVersion: MODEL_SNAPSHOT.outputSchemaVersion,
      })
      expect(event).toMatchObject({
        type: 'PLAN_GENERATION_REQUESTED',
        aggregateId: runId,
        dispatchedAt: null,
        payload: { generationRunId: runId },
      })
      expect(user.preferredModelId).toBe(MODEL_SNAPSHOT.catalogId)
      expect(JSON.stringify({ run, event })).not.toMatch(/api.?key|access.?token/i)
    } finally {
      await cleanup(userId, [runId])
    }
  })

  it('rolls back the run and preference if the outbox insert fails', async () => {
    const { userId, goalId } = await createOwnedGoal()
    const runId = randomUUID()
    const deduplicationKey = `plan-generation-requested-${runId}`

    await database.outboxEvent.create({
      data: {
        type: 'PLAN_GENERATION_REQUESTED',
        aggregateId: randomUUID(),
        deduplicationKey,
        payload: { generationRunId: randomUUID() },
      },
    })

    const repository = new PlanGenerationRepository(database, () => runId)

    try {
      await expect(
        repository.accept({
          actorUserId: userId,
          goalId,
          model: MODEL_SNAPSHOT,
          queuedAt: QUEUED_AT,
          deadlineAt: DEADLINE_AT,
        }),
      ).rejects.toMatchObject({ code: 'P2002' })

      await expect(
        database.planGenerationRun.findUnique({ where: { id: runId } }),
      ).resolves.toBeNull()
      await expect(
        database.user.findUniqueOrThrow({ where: { id: userId } }),
      ).resolves.toMatchObject({
        preferredModelId: null,
      })
    } finally {
      await database.outboxEvent.delete({ where: { deduplicationKey } })
      await cleanup(userId, [runId])
    }
  })

  it('returns the existing active run when a second request races for the same goal', async () => {
    const { userId, goalId } = await createOwnedGoal()
    const firstRunId = randomUUID()
    const secondRunId = randomUUID()
    let invocation = 0
    const repository = new PlanGenerationRepository(database, () => {
      invocation += 1
      return invocation === 1 ? firstRunId : secondRunId
    })

    try {
      await repository.accept({
        actorUserId: userId,
        goalId,
        model: MODEL_SNAPSHOT,
        queuedAt: QUEUED_AT,
        deadlineAt: DEADLINE_AT,
      })

      await expect(
        repository.accept({
          actorUserId: userId,
          goalId,
          model: MODEL_SNAPSHOT,
          queuedAt: QUEUED_AT,
          deadlineAt: DEADLINE_AT,
        }),
      ).rejects.toEqual(new ActivePlanGenerationRunError(firstRunId))

      await expect(database.planGenerationRun.count({ where: { goalId } })).resolves.toBe(1)
    } finally {
      await cleanup(userId, [firstRunId, secondRunId])
    }
  })

  it('creates a linked queued run instead of reviving a failed retry source', async () => {
    const { userId, goalId } = await createOwnedGoal()
    const failedRunId = randomUUID()
    const retryRunId = randomUUID()

    await database.planGenerationRun.create({
      data: {
        id: failedRunId,
        goalId,
        status: 'FAILED',
        modelCatalogId: MODEL_SNAPSHOT.catalogId,
        modelProvider: MODEL_SNAPSHOT.provider,
        modelName: MODEL_SNAPSHOT.modelName,
        promptVersion: MODEL_SNAPSHOT.promptVersion,
        outputSchemaVersion: MODEL_SNAPSHOT.outputSchemaVersion,
        queuedAt: QUEUED_AT,
        deadlineAt: DEADLINE_AT,
        finishedAt: new Date('2026-08-08T10:01:00.000Z'),
        errorCode: 'MODEL_UPSTREAM_ERROR',
      },
    })

    const repository = new PlanGenerationRepository(database, () => retryRunId)

    try {
      await repository.accept({
        actorUserId: userId,
        goalId,
        model: MODEL_SNAPSHOT,
        queuedAt: new Date('2026-08-08T11:00:00.000Z'),
        deadlineAt: new Date('2026-08-08T11:03:00.000Z'),
        retryOfRunId: failedRunId,
      })

      await expect(
        database.planGenerationRun.findUniqueOrThrow({ where: { id: retryRunId } }),
      ).resolves.toMatchObject({
        status: 'QUEUED',
        retryOfRunId: failedRunId,
      })
      await expect(
        database.planGenerationRun.findUniqueOrThrow({ where: { id: failedRunId } }),
      ).resolves.toMatchObject({
        status: 'FAILED',
        retryOfRunId: null,
      })
    } finally {
      await cleanup(userId, [retryRunId])
    }
  })
})
