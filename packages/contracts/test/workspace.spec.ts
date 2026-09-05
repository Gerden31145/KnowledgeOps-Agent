import {
  learningGoalResponseSchema,
  planDetailResponseSchema,
  taskDetailResponseSchema,
  todayTasksResponseSchema,
} from '../src/index.js'
import { describe, expect, it } from 'vitest'

const ids = {
  criterion: '87254c48-8e51-4613-a5ca-205834422f71',
  goal: 'fedfb2e2-8f0e-4830-8240-f198cecabd95',
  plan: '1e3d67ef-0353-413a-a921-a837e0c6fd75',
  run: '2359b0ab-c51e-40df-ac45-7e52e79c8380',
  stage: '678c8536-258d-4744-a900-5ad18f39c6be',
  task: 'b2d6af47-6f36-4051-880c-58fa486020f8',
}

const task = {
  id: ids.task,
  title: 'Explain the event loop',
  description: 'Write a note about tasks, microtasks, and rendering.',
  position: 0,
  type: 'MARKDOWN_NOTE',
  estimatedMinutes: 90,
  suggestedSteps: ['Draw an execution timeline'],
  targetPath: 'notes/event-loop.md',
  state: 'READY',
  version: 1,
  prerequisiteTaskIds: [],
  criteria: [
    {
      id: ids.criterion,
      type: 'SECTION_PRESENT',
      description: 'Contains a section comparing tasks and microtasks.',
      required: true,
      position: 0,
    },
  ],
} as const

describe('workspace HTTP contracts', () => {
  it('accepts a browser-safe learning goal receipt', () => {
    expect(
      learningGoalResponseSchema.parse({
        id: ids.goal,
        title: 'Prepare for frontend interviews',
        currentLevel: 'Comfortable with Vue 3',
        deadline: '2026-09-20',
        weeklyMinutes: 600,
        createdAt: '2026-09-04T08:00:00.000Z',
      }),
    ).toMatchObject({ id: ids.goal, deadline: '2026-09-20' })
  })

  it('accepts an ordered plan graph and rejects hidden persistence fields', () => {
    const response = {
      id: ids.plan,
      version: 1,
      status: 'DRAFT',
      confirmedAt: null,
      goal: {
        id: ids.goal,
        title: 'Prepare for frontend interviews',
        deadline: '2026-09-20',
        weeklyMinutes: 600,
      },
      stages: [{ id: ids.stage, title: 'JavaScript foundations', position: 0, tasks: [task] }],
    }

    expect(planDetailResponseSchema.parse(response)).toEqual(response)
    expect(() =>
      planDetailResponseSchema.parse({ ...response, modelProvider: 'must-stay-server-side' }),
    ).toThrow()
  })

  it('keeps today and task-detail views inside their intended state boundaries', () => {
    expect(
      todayTasksResponseSchema.parse({
        plan: { id: ids.plan, status: 'ACTIVE' },
        tasks: [
          {
            id: ids.task,
            planId: ids.plan,
            title: task.title,
            description: task.description,
            estimatedMinutes: task.estimatedMinutes,
            targetPath: task.targetPath,
            state: 'IN_PROGRESS',
            updatedAt: '2026-09-04T08:05:00.000Z',
            stage: { id: ids.stage, title: 'JavaScript foundations', position: 0 },
          },
        ],
      }).tasks,
    ).toHaveLength(1)

    expect(
      taskDetailResponseSchema.parse({
        ...task,
        stage: {
          id: ids.stage,
          title: 'JavaScript foundations',
          position: 0,
          plan: { id: ids.plan, status: 'ACTIVE' },
        },
        runs: [
          {
            id: ids.run,
            kind: 'NOTE_VERIFICATION',
            status: 'QUEUED',
            errorCode: null,
            queuedAt: '2026-09-04T08:06:00.000Z',
            startedAt: null,
            finishedAt: null,
          },
        ],
      }).runs,
    ).toHaveLength(1)
  })
})
