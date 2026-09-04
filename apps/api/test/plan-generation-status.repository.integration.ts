import { createDatabaseClient } from '@knowledgeops/database'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PlanGenerationRepository } from '../src/plan-generation/plan-generation.repository.js'

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for the 08-10 integration test')
}

const database = createDatabaseClient(databaseUrl)

describe('plan generation status query against PostgreSQL', () => {
  beforeAll(async () => {
    await database.$connect()
  })

  afterAll(async () => {
    await database.$disconnect()
  })

  it('returns only an owned, browser-safe run snapshot', async () => {
    const userId = randomUUID()
    const goalId = randomUUID()
    const generationRunId = randomUUID()
    const repository = new PlanGenerationRepository(database)

    await database.user.create({
      data: {
        id: userId,
        goals: {
          create: {
            id: goalId,
            title: 'Prepare for frontend interviews',
            currentLevel: 'Comfortable with Vue 3',
            deadline: new Date('2026-09-20T00:00:00.000Z'),
            weeklyMinutes: 600,
            planGenerationRuns: {
              create: {
                id: generationRunId,
                status: 'FAILED',
                modelCatalogId: 'openai-primary',
                modelProvider: 'openai',
                modelName: 'private-provider-name',
                promptVersion: 'plan-generation-v1',
                outputSchemaVersion: 'plan-generation-output-v1',
                errorCode: 'MODEL_UPSTREAM_ERROR',
                errorMessage: 'Provider unavailable',
                queuedAt: new Date('2026-09-03T08:00:00.000Z'),
                deadlineAt: new Date('2026-09-03T08:03:00.000Z'),
                finishedAt: new Date('2026-09-03T08:01:00.000Z'),
              },
            },
          },
        },
      },
    })

    try {
      const snapshot = await repository.findStatusForUser(generationRunId, userId)

      expect(snapshot).toMatchObject({
        generationRunId,
        goalId,
        status: 'FAILED',
        error: { code: 'MODEL_UPSTREAM_ERROR' },
        plan: null,
      })
      expect(JSON.stringify(snapshot)).not.toContain('private-provider-name')
      await expect(repository.findStatusForUser(generationRunId, randomUUID())).resolves.toBeNull()
    } finally {
      await database.user.delete({ where: { id: userId } })
    }
  })
})
