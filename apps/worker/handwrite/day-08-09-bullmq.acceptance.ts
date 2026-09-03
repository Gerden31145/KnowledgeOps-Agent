import { buildPlanGenerationJobId } from '@knowledgeops/contracts'
import { createDatabaseClient } from '@knowledgeops/database'
import { Queue } from 'bullmq'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { OutboxDispatcher } from '../src/outbox/outbox-dispatcher.js'
import type {
  PlanGenerationJobHandler,
  PlanGenerationJobResult,
} from '../src/plan-generation/plan-generation-job-processor.js'
import { BullMqPlanGenerationQueue } from '../src/queue/bullmq-plan-generation-queue.js'

const databaseUrl = process.env.DATABASE_URL
const redisUrl = process.env.REDIS_URL

if (!databaseUrl || !redisUrl) {
  throw new Error('DATABASE_URL and REDIS_URL are required for the 08-09 handwrite acceptance')
}

const database = createDatabaseClient(databaseUrl)
const TEST_NOW = new Date('2026-08-11T12:00:00.000Z')
const RETRY_POLICY = { baseDelayMs: 100, maxDelayMs: 1_000 }

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
          title: 'Exercise BullMQ wiring',
          currentLevel: 'Learning queue APIs',
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
              queuedAt: TEST_NOW,
              deadlineAt: new Date('2026-08-11T12:03:00.000Z'),
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
      availableAt: TEST_NOW,
      occurredAt: TEST_NOW,
    },
  })

  return { eventId, generationRunId, userId }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the BullMQ worker')
    }

    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('08-09 BullMQ handwrite acceptance', () => {
  beforeAll(async () => {
    await database.$connect()
  })

  afterAll(async () => {
    await database.$disconnect()
  })

  it('relays committed events, absorbs a duplicate dispatch, and recovers after restart', async () => {
    const queueName = `plan-generation-handwrite-${randomUUID()}`
    const firstFixture = await createPendingEvent()
    const secondFixture = await createPendingEvent()
    const processedRunIds: string[] = []
    const handler: PlanGenerationJobHandler = {
      process: async (payload): Promise<PlanGenerationJobResult> => {
        processedRunIds.push(payload.generationRunId)
        return {
          generationRunId: payload.generationRunId,
          status: 'SKELETON_ACCEPTED',
        }
      },
    }
    let queueRuntime: BullMqPlanGenerationQueue | undefined

    try {
      queueRuntime = new BullMqPlanGenerationQueue({
        concurrency: 1,
        jobOptions: { attempts: 3, backoffDelayMs: 100 },
        processor: handler,
        queueName,
        redisUrl,
      })
      queueRuntime.start()
      await queueRuntime.waitUntilReady()

      const dispatcher = new OutboxDispatcher(database, queueRuntime, RETRY_POLICY, () => TEST_NOW)

      await expect(dispatcher.dispatchEvent(firstFixture.eventId)).resolves.toMatchObject({
        status: 'DISPATCHED',
        jobId: buildPlanGenerationJobId(firstFixture.generationRunId),
      })
      await waitFor(() => processedRunIds.includes(firstFixture.generationRunId))

      await database.outboxEvent.update({
        where: { id: firstFixture.eventId },
        data: { dispatchedAt: null, availableAt: TEST_NOW },
      })
      await expect(dispatcher.dispatchEvent(firstFixture.eventId)).resolves.toMatchObject({
        status: 'DISPATCHED',
        jobId: buildPlanGenerationJobId(firstFixture.generationRunId),
      })
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(
        processedRunIds.filter((runId) => runId === firstFixture.generationRunId),
      ).toHaveLength(1)

      await queueRuntime.close()
      queueRuntime = undefined
      queueRuntime = new BullMqPlanGenerationQueue({
        concurrency: 1,
        jobOptions: { attempts: 3, backoffDelayMs: 100 },
        processor: handler,
        queueName,
        redisUrl,
      })
      queueRuntime.start()
      await queueRuntime.waitUntilReady()

      const restartedDispatcher = new OutboxDispatcher(
        database,
        queueRuntime,
        RETRY_POLICY,
        () => TEST_NOW,
      )
      await expect(restartedDispatcher.dispatchEvent(secondFixture.eventId)).resolves.toMatchObject(
        {
          status: 'DISPATCHED',
          jobId: buildPlanGenerationJobId(secondFixture.generationRunId),
        },
      )
      await waitFor(() => processedRunIds.includes(secondFixture.generationRunId))

      const inspectionQueue = new Queue(queueName, {
        connection: { url: redisUrl, maxRetriesPerRequest: 1 },
      })
      try {
        const firstJob = await inspectionQueue.getJob(
          buildPlanGenerationJobId(firstFixture.generationRunId),
        )
        expect(firstJob?.opts).toMatchObject({
          attempts: 3,
          backoff: { type: 'exponential', delay: 100 },
          removeOnComplete: false,
          removeOnFail: false,
        })
      } finally {
        await inspectionQueue.close()
      }
    } finally {
      await queueRuntime?.close()

      const cleanupQueue = new Queue(queueName, {
        connection: { url: redisUrl, maxRetriesPerRequest: 1 },
      })
      try {
        await cleanupQueue.obliterate({ force: true })
      } finally {
        await cleanupQueue.close()
      }

      await database.outboxEvent.deleteMany({
        where: { id: { in: [firstFixture.eventId, secondFixture.eventId] } },
      })
      await database.user.deleteMany({
        where: { id: { in: [firstFixture.userId, secondFixture.userId] } },
      })
    }
  }, 15_000)
})
