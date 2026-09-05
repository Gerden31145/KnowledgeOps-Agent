import { createDatabaseClient } from '@knowledgeops/database'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { LearningGoalRepository } from '../src/learning-goals/learning-goal.repository.js'
import { PlanRepository } from '../src/plans/plan.repository.js'

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for the 08-11 integration test')
}

const database = createDatabaseClient(databaseUrl)

describe('08-11 workspace repositories against PostgreSQL', () => {
  beforeAll(async () => {
    await database.$connect()
  })

  afterAll(async () => {
    await database.$disconnect()
  })

  it('creates a goal and reads owned plan, today, and task views without leaking blocked work', async () => {
    const userId = randomUUID()
    const planId = randomUUID()
    const stageId = randomUUID()
    const readyTaskId = randomUUID()
    const blockedTaskId = randomUUID()
    const criterionId = randomUUID()
    const runId = randomUUID()
    const createdAt = new Date('2026-09-04T08:00:00.000Z')
    const goals = new LearningGoalRepository(database)
    const plans = new PlanRepository(database)

    const goal = await goals.create({
      actorUserId: userId,
      actorTimezone: 'Asia/Shanghai',
      input: {
        title: 'Prepare for frontend interviews',
        currentLevel: 'Comfortable with Vue 3',
        deadline: '2026-09-20',
        weeklyMinutes: 600,
      },
      createdAt,
    })

    await database.plan.create({
      data: {
        id: planId,
        goalId: goal.id,
        status: 'ACTIVE',
        confirmedAt: createdAt,
        stages: {
          create: {
            id: stageId,
            title: 'JavaScript foundations',
            position: 0,
            tasks: {
              create: [
                {
                  id: readyTaskId,
                  title: 'Explain the event loop',
                  description: 'Write a note about tasks, microtasks, and rendering.',
                  position: 0,
                  estimatedMinutes: 90,
                  suggestedSteps: ['Draw an execution timeline'],
                  targetPath: 'notes/event-loop.md',
                  state: 'READY',
                  version: 1,
                  criteria: {
                    create: {
                      id: criterionId,
                      type: 'SECTION_PRESENT',
                      description: 'Contains a section about tasks and microtasks.',
                      required: true,
                      position: 0,
                    },
                  },
                  runs: {
                    create: {
                      id: runId,
                      kind: 'NOTE_VERIFICATION',
                      status: 'FAILED',
                      taskStateBeforeRun: 'READY',
                      workflowVersion: 'note-verification-v1',
                      errorCode: 'FIXTURE_FAILURE',
                    },
                  },
                },
                {
                  id: blockedTaskId,
                  title: 'Connect rendering',
                  description: 'Connect scheduling with rendering.',
                  position: 1,
                  estimatedMinutes: 75,
                  suggestedSteps: ['Describe one frame lifecycle'],
                  targetPath: 'notes/rendering.md',
                  state: 'BLOCKED',
                },
              ],
            },
          },
        },
      },
    })
    await database.taskDependency.create({
      data: { taskId: blockedTaskId, prerequisiteTaskId: readyTaskId },
    })

    try {
      await expect(plans.findDetailByIdForUser(planId, userId)).resolves.toMatchObject({
        id: planId,
        goal: { id: goal.id, deadline: '2026-09-20' },
        stages: [
          {
            id: stageId,
            tasks: [
              { id: readyTaskId, criteria: [{ id: criterionId }], prerequisiteTaskIds: [] },
              { id: blockedTaskId, prerequisiteTaskIds: [readyTaskId] },
            ],
          },
        ],
      })
      await expect(plans.findTodayTasksForUser(userId)).resolves.toMatchObject({
        plan: { id: planId, status: 'ACTIVE' },
        tasks: [{ id: readyTaskId, state: 'READY' }],
      })
      await expect(plans.findTaskDetailForUser(readyTaskId, userId)).resolves.toMatchObject({
        id: readyTaskId,
        stage: { id: stageId, plan: { id: planId, status: 'ACTIVE' } },
        runs: [{ id: runId, status: 'FAILED', errorCode: 'FIXTURE_FAILURE' }],
      })
      await expect(plans.findDetailByIdForUser(planId, randomUUID())).resolves.toBeNull()
    } finally {
      await database.agentRun.deleteMany({
        where: { task: { stage: { plan: { goal: { userId } } } } },
      })
      await database.user.delete({ where: { id: userId } })
    }
  })
})
