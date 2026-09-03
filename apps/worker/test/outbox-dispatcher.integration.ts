import { buildPlanGenerationJobId } from '@knowledgeops/contracts'
import { createDatabaseClient } from '@knowledgeops/database'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { OutboxDispatcher, type OutboxPublisher } from '../src/outbox/outbox-dispatcher.js'

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for the 08-09 dispatcher integration test')
}

const database = createDatabaseClient(databaseUrl)
const INITIAL_NOW = new Date('2026-08-11T10:00:00.000Z')
const RETRY_POLICY = { baseDelayMs: 1_000, maxDelayMs: 8_000 }

async function createPendingEvent() {
  const userId = randomUUID()
  const goalId = randomUUID()
  const generationRunId = randomUUID()
  const eventId = randomUUID()

  await database.user.create({
    data: {
      id: userId,
      goals: {
        create: {
          id: goalId,
          title: 'Verify the outbox relay',
          currentLevel: 'Learning BullMQ',
          deadline: new Date('2026-09-01T00:00:00.000Z'),
          weeklyMinutes: 300,
          planGenerationRuns: {
            create: {
              id: generationRunId,
              modelCatalogId: 'openai-primary',
              modelProvider: 'openai',
              modelName: 'configured-model',
              promptVersion: 'prompt-v1',
              outputSchemaVersion: 'schema-v1',
              queuedAt: INITIAL_NOW,
              deadlineAt: new Date('2026-08-11T10:03:00.000Z'),
            },
          },
        },
      },
    },
  })

  await database.outboxEvent.create({
    data: {
      id: eventId,
      type: 'PLAN_GENERATION_REQUESTED',
      aggregateId: generationRunId,
      deduplicationKey: `plan-generation-requested-${generationRunId}`,
      payload: { generationRunId },
      availableAt: INITIAL_NOW,
      occurredAt: INITIAL_NOW,
    },
  })

  return { eventId, generationRunId, userId }
}

async function cleanupEvent(userId: string, eventId: string) {
  await database.outboxEvent.deleteMany({ where: { id: eventId } })
  await database.user.deleteMany({ where: { id: userId } })
}

describe('OutboxDispatcher against PostgreSQL', () => {
  beforeAll(async () => {
    await database.$connect()
  })

  afterAll(async () => {
    await database.$disconnect()
  })

  it('marks an event dispatched only after the publisher acknowledges it', async () => {
    const fixture = await createPendingEvent()
    const publish = vi.fn<OutboxPublisher['publish']>(async ({ payload }) => ({
      jobId: buildPlanGenerationJobId(payload.generationRunId),
    }))
    const dispatcher = new OutboxDispatcher(database, { publish }, RETRY_POLICY, () => INITIAL_NOW)

    try {
      await expect(dispatcher.dispatchEvent(fixture.eventId)).resolves.toEqual({
        status: 'DISPATCHED',
        eventId: fixture.eventId,
        jobId: buildPlanGenerationJobId(fixture.generationRunId),
      })
      await expect(
        database.outboxEvent.findUniqueOrThrow({ where: { id: fixture.eventId } }),
      ).resolves.toMatchObject({
        deadLetteredAt: null,
        dispatchAttemptCount: 1,
        dispatchedAt: INITIAL_NOW,
        lastError: null,
      })
    } finally {
      await cleanupEvent(fixture.userId, fixture.eventId)
    }
  })

  it('rescans a retryable delivery while a stable Job ID absorbs the duplicate side effect', async () => {
    const fixture = await createPendingEvent()
    const observedJobIds = new Set<string>()
    let publishAttempts = 0
    let now = INITIAL_NOW
    const publisher: OutboxPublisher = {
      publish: async ({ payload }) => {
        publishAttempts += 1
        const jobId = buildPlanGenerationJobId(payload.generationRunId)
        observedJobIds.add(jobId)

        if (publishAttempts === 1) {
          throw new Error('connection closed after Redis accepted the command')
        }

        return { jobId }
      },
    }
    const dispatcher = new OutboxDispatcher(database, publisher, RETRY_POLICY, () => now)

    try {
      await expect(dispatcher.dispatchEvent(fixture.eventId)).resolves.toMatchObject({
        status: 'RETRY_SCHEDULED',
        eventId: fixture.eventId,
        nextAttemptAt: new Date('2026-08-11T10:00:01.000Z'),
      })
      await expect(dispatcher.dispatchEvent(fixture.eventId)).resolves.toEqual({ status: 'EMPTY' })

      now = new Date('2026-08-11T10:00:01.000Z')
      await expect(dispatcher.dispatchEvent(fixture.eventId)).resolves.toMatchObject({
        status: 'DISPATCHED',
        jobId: buildPlanGenerationJobId(fixture.generationRunId),
      })

      expect(publishAttempts).toBe(2)
      expect(observedJobIds).toEqual(new Set([buildPlanGenerationJobId(fixture.generationRunId)]))
      await expect(
        database.outboxEvent.findUniqueOrThrow({ where: { id: fixture.eventId } }),
      ).resolves.toMatchObject({
        dispatchAttemptCount: 2,
        dispatchedAt: now,
      })
    } finally {
      await cleanupEvent(fixture.userId, fixture.eventId)
    }
  })

  it('dead-letters a malformed event instead of retrying it forever', async () => {
    const fixture = await createPendingEvent()
    await database.outboxEvent.update({
      where: { id: fixture.eventId },
      data: { payload: { generationRunId: randomUUID() } },
    })
    const publish = vi.fn<OutboxPublisher['publish']>()
    const dispatcher = new OutboxDispatcher(database, { publish }, RETRY_POLICY, () => INITIAL_NOW)

    try {
      await expect(dispatcher.dispatchEvent(fixture.eventId)).resolves.toMatchObject({
        status: 'DEAD_LETTERED',
        failure: {
          code: 'OUTBOX_PAYLOAD_INVALID',
          kind: 'NON_RETRYABLE',
        },
      })
      expect(publish).not.toHaveBeenCalled()
      await expect(
        database.outboxEvent.findUniqueOrThrow({ where: { id: fixture.eventId } }),
      ).resolves.toMatchObject({
        deadLetteredAt: INITIAL_NOW,
        dispatchAttemptCount: 1,
        dispatchedAt: null,
      })
    } finally {
      await cleanupEvent(fixture.userId, fixture.eventId)
    }
  })

  it('uses SKIP LOCKED so two dispatchers do not publish the same locked row concurrently', async () => {
    const fixture = await createPendingEvent()
    let releasePublish!: () => void
    let resolvePublishStarted!: () => void
    const publishStarted = new Promise<void>((resolve) => {
      resolvePublishStarted = resolve
    })
    const publishReleased = new Promise<void>((resolve) => {
      releasePublish = resolve
    })
    const publish = vi.fn<OutboxPublisher['publish']>(async ({ payload }) => {
      resolvePublishStarted()
      await publishReleased
      return { jobId: buildPlanGenerationJobId(payload.generationRunId) }
    })
    const firstDispatcher = new OutboxDispatcher(
      database,
      { publish },
      RETRY_POLICY,
      () => INITIAL_NOW,
    )
    const secondDispatcher = new OutboxDispatcher(
      database,
      { publish },
      RETRY_POLICY,
      () => INITIAL_NOW,
    )

    try {
      const firstResult = firstDispatcher.dispatchEvent(fixture.eventId)
      await publishStarted

      await expect(secondDispatcher.dispatchEvent(fixture.eventId)).resolves.toEqual({
        status: 'EMPTY',
      })

      releasePublish()
      await expect(firstResult).resolves.toMatchObject({ status: 'DISPATCHED' })
      expect(publish).toHaveBeenCalledTimes(1)
    } finally {
      releasePublish()
      await cleanupEvent(fixture.userId, fixture.eventId)
    }
  })
})
