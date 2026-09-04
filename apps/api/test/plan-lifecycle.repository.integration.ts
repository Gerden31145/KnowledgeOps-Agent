import { createDatabaseClient } from '@knowledgeops/database'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  AnotherActivePlanError,
  AnotherTaskInProgressError,
} from '../src/plans/plan-lifecycle.errors.js'
import { PlanLifecycleRepository } from '../src/plans/plan-lifecycle.repository.js'

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for the 08-10 integration test')
}

const database = createDatabaseClient(databaseUrl)
const confirmedAt = new Date('2026-09-03T08:00:00.000Z')

async function createDraftPlanGraph() {
  const userId = randomUUID()
  const goalId = randomUUID()
  const planId = randomUUID()
  const stageId = randomUUID()
  const firstTaskId = randomUUID()
  const secondTaskId = randomUUID()
  const dependentTaskId = randomUUID()

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
          plans: {
            create: {
              id: planId,
              stages: {
                create: {
                  id: stageId,
                  title: 'Core concepts',
                  position: 0,
                  tasks: {
                    create: [
                      {
                        id: firstTaskId,
                        title: 'First root task',
                        description: 'Write the first independent note.',
                        position: 0,
                        estimatedMinutes: 60,
                        targetPath: 'notes/first.md',
                      },
                      {
                        id: secondTaskId,
                        title: 'Second root task',
                        description: 'Write the second independent note.',
                        position: 1,
                        estimatedMinutes: 60,
                        targetPath: 'notes/second.md',
                      },
                      {
                        id: dependentTaskId,
                        title: 'Dependent task',
                        description: 'Write a note after the first task.',
                        position: 2,
                        estimatedMinutes: 60,
                        targetPath: 'notes/dependent.md',
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    },
  })

  await database.taskDependency.create({
    data: {
      taskId: dependentTaskId,
      prerequisiteTaskId: firstTaskId,
    },
  })

  return { dependentTaskId, firstTaskId, goalId, planId, secondTaskId, userId }
}

describe('PlanLifecycleRepository against PostgreSQL', () => {
  beforeAll(async () => {
    await database.$connect()
  })

  afterAll(async () => {
    await database.$disconnect()
  })

  it('confirms once and unlocks only tasks with no prerequisites', async () => {
    const ids = await createDraftPlanGraph()
    const repository = new PlanLifecycleRepository(database, () => confirmedAt)

    try {
      const first = await repository.confirmPlan(ids.planId, ids.userId)
      const second = await repository.confirmPlan(ids.planId, ids.userId)

      expect(first).toEqual({
        planId: ids.planId,
        status: 'ACTIVE',
        confirmedAt: confirmedAt.toISOString(),
        readyTaskIds: [ids.firstTaskId, ids.secondTaskId],
      })
      expect(second).toEqual(first)
      await expect(
        database.task.findMany({
          where: { id: { in: [ids.firstTaskId, ids.secondTaskId, ids.dependentTaskId] } },
          orderBy: { position: 'asc' },
          select: { id: true, state: true, version: true },
        }),
      ).resolves.toEqual([
        { id: ids.firstTaskId, state: 'READY', version: 1 },
        { id: ids.secondTaskId, state: 'READY', version: 1 },
        { id: ids.dependentTaskId, state: 'BLOCKED', version: 0 },
      ])
    } finally {
      await database.user.delete({ where: { id: ids.userId } })
    }
  })

  it('starts a ready task once and preserves the first target path on replay', async () => {
    const ids = await createDraftPlanGraph()
    const repository = new PlanLifecycleRepository(database, () => confirmedAt)

    try {
      await repository.confirmPlan(ids.planId, ids.userId)
      const first = await repository.startTask(ids.firstTaskId, ids.userId, {
        targetPath: 'notes/chosen-first.md',
      })
      const second = await repository.startTask(ids.firstTaskId, ids.userId, {})

      expect(first).toEqual({
        taskId: ids.firstTaskId,
        state: 'IN_PROGRESS',
        version: 2,
        targetPath: 'notes/chosen-first.md',
      })
      expect(second).toEqual(first)
      await expect(repository.startTask(ids.secondTaskId, ids.userId, {})).rejects.toEqual(
        new AnotherTaskInProgressError(ids.firstTaskId),
      )
    } finally {
      await database.user.delete({ where: { id: ids.userId } })
    }
  })

  it('serializes plan confirmation so only one plan becomes active', async () => {
    const ids = await createDraftPlanGraph()
    const secondPlanId = randomUUID()
    await database.plan.create({
      data: {
        id: secondPlanId,
        goalId: ids.goalId,
        version: 2,
      },
    })
    const repository = new PlanLifecycleRepository(database, () => confirmedAt)

    try {
      await repository.confirmPlan(ids.planId, ids.userId)
      await expect(repository.confirmPlan(secondPlanId, ids.userId)).rejects.toEqual(
        new AnotherActivePlanError(ids.planId),
      )
      await expect(
        database.plan.count({ where: { goal: { userId: ids.userId }, status: 'ACTIVE' } }),
      ).resolves.toBe(1)
    } finally {
      await database.user.delete({ where: { id: ids.userId } })
    }
  })

  it('uses the ownership predicate for both plan confirmation and task start', async () => {
    const ids = await createDraftPlanGraph()
    const repository = new PlanLifecycleRepository(database, () => confirmedAt)
    const anotherUserId = randomUUID()
    await database.user.create({ data: { id: anotherUserId } })

    try {
      await expect(repository.confirmPlan(ids.planId, anotherUserId)).rejects.toMatchObject({
        name: 'PlanNotFoundError',
      })
      await expect(repository.startTask(ids.firstTaskId, anotherUserId, {})).rejects.toMatchObject({
        name: 'TaskNotFoundError',
      })
    } finally {
      await database.user.delete({ where: { id: anotherUserId } })
      await database.user.delete({ where: { id: ids.userId } })
    }
  })
})
