import type { PlanGenerationOutput } from '@knowledgeops/agent-core'
import { createDatabaseClient } from '@knowledgeops/database'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FinalizePlanGenerationRun } from '../src/plan-generation/finalize-plan-generation-run.js'

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for the Stage 2 finalizer acceptance test')
}

const database = createDatabaseClient(databaseUrl)
const finishedAt = new Date('2026-09-03T08:02:00.000Z')

const candidate = {
  stages: [
    {
      title: 'Foundations',
      tasks: [
        {
          id: 'event-loop',
          title: 'Explain the event loop',
          description: 'Explain tasks, microtasks, and rendering order.',
          type: 'MARKDOWN_NOTE',
          estimatedMinutes: 90,
          suggestedSteps: ['Draw one execution timeline'],
          targetPath: 'notes/event-loop.md',
          acceptanceCriteria: [
            {
              type: 'SECTION_PRESENT',
              description: 'Contains a section about tasks and microtasks.',
              required: true,
            },
          ],
          dependsOnTaskIds: [],
        },
        {
          id: 'rendering',
          title: 'Connect rendering',
          description: 'Connect scheduling with the browser rendering pipeline.',
          type: 'MARKDOWN_NOTE',
          estimatedMinutes: 75,
          suggestedSteps: ['Describe one frame lifecycle'],
          targetPath: 'notes/rendering.md',
          acceptanceCriteria: [
            {
              type: 'TOPIC_COVERAGE',
              description: 'Covers layout, paint, and composite.',
              required: true,
            },
          ],
          dependsOnTaskIds: ['event-loop'],
        },
      ],
    },
    {
      title: 'Framework scheduling',
      tasks: [
        {
          id: 'vue-scheduling',
          title: 'Explain Vue scheduling',
          description: 'Connect Vue batched updates with browser scheduling.',
          type: 'MARKDOWN_NOTE',
          estimatedMinutes: 75,
          suggestedSteps: ['Explain one nextTick example'],
          targetPath: 'notes/vue-scheduling.md',
          acceptanceCriteria: [
            {
              type: 'EXPLANATION_QUALITY',
              description: 'Uses a concrete example for batched updates.',
              required: true,
            },
          ],
          dependsOnTaskIds: ['event-loop', 'rendering'],
        },
      ],
    },
  ],
} as const satisfies PlanGenerationOutput

async function createRun(options: { status?: 'RUNNING' | 'TIMED_OUT'; version?: number } = {}) {
  const userId = randomUUID()
  const goalId = randomUUID()
  const generationRunId = randomUUID()

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
              status: options.status ?? 'RUNNING',
              version: options.version ?? 1,
              modelCatalogId: 'openai-primary',
              modelProvider: 'openai',
              modelName: 'test-model',
              promptVersion: 'plan-generation-v1',
              outputSchemaVersion: 'plan-generation-output-v1',
              queuedAt: new Date('2026-09-03T08:00:00.000Z'),
              startedAt: new Date('2026-09-03T08:00:01.000Z'),
              deadlineAt: new Date('2026-09-03T08:03:00.000Z'),
              ...(options.status === 'TIMED_OUT'
                ? {
                    errorCode: 'RUN_DEADLINE_EXCEEDED',
                    errorMessage: 'Plan generation exceeded its persisted deadline',
                    finishedAt: new Date('2026-09-03T08:03:00.000Z'),
                  }
                : {}),
            },
          },
        },
      },
    },
  })

  return { generationRunId, goalId, userId }
}

describe('Stage 2 core handwrite: atomic plan generation finalizer', () => {
  beforeAll(async () => {
    await database.$connect()
  })

  afterAll(async () => {
    await database.$disconnect()
  })

  it('atomically persists the complete graph and succeeds the matching running run', async () => {
    const ids = await createRun()
    const finalizer = new FinalizePlanGenerationRun(database)

    try {
      const result = await finalizer.execute({
        candidate,
        expectedRunVersion: 1,
        finishedAt,
        generationRunId: ids.generationRunId,
        goalId: ids.goalId,
      })

      expect(result).toMatchObject({ status: 'FINALIZED', planId: expect.any(String) })
      const plan = await database.plan.findUniqueOrThrow({
        where: { generationRunId: ids.generationRunId },
        include: {
          stages: {
            include: {
              tasks: { include: { criteria: true, prerequisites: true } },
            },
          },
        },
      })
      expect(plan.status).toBe('DRAFT')
      expect(plan.stages).toHaveLength(2)
      expect(plan.stages.flatMap((stage) => stage.tasks)).toHaveLength(3)
      expect(
        plan.stages.flatMap((stage) => stage.tasks.flatMap((task) => task.criteria)),
      ).toHaveLength(3)
      expect(
        plan.stages.flatMap((stage) => stage.tasks.flatMap((task) => task.prerequisites)),
      ).toHaveLength(3)
      await expect(
        database.planGenerationRun.findUniqueOrThrow({ where: { id: ids.generationRunId } }),
      ).resolves.toMatchObject({ status: 'SUCCEEDED', version: 2, finishedAt })
    } finally {
      await database.user.delete({ where: { id: ids.userId } })
    }
  })

  it('returns the existing plan when the same successful run is replayed', async () => {
    const ids = await createRun()
    const finalizer = new FinalizePlanGenerationRun(database)
    const command = {
      candidate,
      expectedRunVersion: 1,
      finishedAt,
      generationRunId: ids.generationRunId,
      goalId: ids.goalId,
    }

    try {
      const first = await finalizer.execute(command)
      const second = await finalizer.execute(command)

      expect(first).toMatchObject({ status: 'FINALIZED' })
      expect(second).toEqual({
        status: 'SKIPPED',
        runStatus: 'SUCCEEDED',
        planId: first.status === 'FINALIZED' ? first.planId : null,
      })
      await expect(
        database.plan.count({ where: { generationRunId: ids.generationRunId } }),
      ).resolves.toBe(1)
    } finally {
      await database.user.delete({ where: { id: ids.userId } })
    }
  })

  it('does not let an outdated fencing version persist a plan', async () => {
    const ids = await createRun({ version: 2 })
    const finalizer = new FinalizePlanGenerationRun(database)

    try {
      await expect(
        finalizer.execute({
          candidate,
          expectedRunVersion: 1,
          finishedAt,
          generationRunId: ids.generationRunId,
          goalId: ids.goalId,
        }),
      ).resolves.toEqual({ status: 'SKIPPED', runStatus: 'RUNNING', planId: null })
      await expect(database.plan.count({ where: { goalId: ids.goalId } })).resolves.toBe(0)
    } finally {
      await database.user.delete({ where: { id: ids.userId } })
    }
  })

  it('does not revive a timed-out run', async () => {
    const ids = await createRun({ status: 'TIMED_OUT', version: 2 })
    const finalizer = new FinalizePlanGenerationRun(database)

    try {
      await expect(
        finalizer.execute({
          candidate,
          expectedRunVersion: 1,
          finishedAt,
          generationRunId: ids.generationRunId,
          goalId: ids.goalId,
        }),
      ).resolves.toEqual({ status: 'SKIPPED', runStatus: 'TIMED_OUT', planId: null })
      await expect(database.plan.count({ where: { goalId: ids.goalId } })).resolves.toBe(0)
    } finally {
      await database.user.delete({ where: { id: ids.userId } })
    }
  })

  it('rolls back every graph row when a dependency cannot be resolved', async () => {
    const ids = await createRun()
    const finalizer = new FinalizePlanGenerationRun(database)
    const invalidCandidate = structuredClone(candidate) as PlanGenerationOutput
    invalidCandidate.stages[1]!.tasks[0]!.dependsOnTaskIds = ['missing-task']

    try {
      await expect(
        finalizer.execute({
          candidate: invalidCandidate,
          expectedRunVersion: 1,
          finishedAt,
          generationRunId: ids.generationRunId,
          goalId: ids.goalId,
        }),
      ).rejects.toThrow()
      await expect(database.plan.count({ where: { goalId: ids.goalId } })).resolves.toBe(0)
      await expect(
        database.planGenerationRun.findUniqueOrThrow({ where: { id: ids.generationRunId } }),
      ).resolves.toMatchObject({ status: 'RUNNING', version: 1 })
    } finally {
      await database.user.delete({ where: { id: ids.userId } })
    }
  })
})
