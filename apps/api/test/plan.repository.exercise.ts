import { createDatabaseClient } from '@knowledgeops/database'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PlanRepository } from '../src/plans/plan.repository.js'

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for the 08-07 handwrite acceptance test')
}

const database = createDatabaseClient(databaseUrl)
const userId = randomUUID()
const goalId = randomUUID()
const planId = randomUUID()
const browserStageId = randomUUID()
const javascriptStageId = randomUUID()
const renderingTaskId = randomUUID()
const eventLoopTaskId = randomUUID()
const closuresTaskId = randomUUID()
let fixtureCreated = false

describe('08-07 PlanRepository handwrite acceptance', () => {
  beforeAll(async () => {
    await database.$connect()
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
            plans: {
              create: {
                id: planId,
                version: 1,
                stages: {
                  create: [
                    {
                      id: browserStageId,
                      title: 'Browser fundamentals',
                      position: 1,
                      tasks: {
                        create: [
                          {
                            id: renderingTaskId,
                            title: 'Rendering pipeline',
                            description: 'Write a rendering pipeline note',
                            position: 1,
                            estimatedMinutes: 90,
                          },
                          {
                            id: eventLoopTaskId,
                            title: 'Event loop',
                            description: 'Write an event loop note',
                            position: 0,
                            estimatedMinutes: 60,
                          },
                        ],
                      },
                    },
                    {
                      id: javascriptStageId,
                      title: 'JavaScript foundations',
                      position: 0,
                      tasks: {
                        create: {
                          id: closuresTaskId,
                          title: 'Closures',
                          description: 'Write a closure note',
                          position: 0,
                          estimatedMinutes: 60,
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    })
    fixtureCreated = true
  })

  afterAll(async () => {
    if (fixtureCreated) {
      await database.user.delete({ where: { id: userId } })
    }

    await database.$disconnect()
  })

  it('returns only the requested owned plan with stages and tasks ordered by position', async () => {
    const repository = new PlanRepository(database)
    const result = await repository.findGraphByIdForUser(planId, userId)

    expect(result).toEqual({
      id: planId,
      version: 1,
      status: 'DRAFT',
      stages: [
        {
          id: javascriptStageId,
          title: 'JavaScript foundations',
          position: 0,
          tasks: [
            {
              id: closuresTaskId,
              title: 'Closures',
              position: 0,
              type: 'MARKDOWN_NOTE',
              state: 'BLOCKED',
            },
          ],
        },
        {
          id: browserStageId,
          title: 'Browser fundamentals',
          position: 1,
          tasks: [
            {
              id: eventLoopTaskId,
              title: 'Event loop',
              position: 0,
              type: 'MARKDOWN_NOTE',
              state: 'BLOCKED',
            },
            {
              id: renderingTaskId,
              title: 'Rendering pipeline',
              position: 1,
              type: 'MARKDOWN_NOTE',
              state: 'BLOCKED',
            },
          ],
        },
      ],
    })
  })

  it('does not expose a plan to another user', async () => {
    const repository = new PlanRepository(database)

    await expect(repository.findGraphByIdForUser(planId, randomUUID())).resolves.toBeNull()
  })

  it('returns null for an unknown plan without a second lookup', async () => {
    const repository = new PlanRepository(database)

    await expect(repository.findGraphByIdForUser(randomUUID(), userId)).resolves.toBeNull()
  })
})
