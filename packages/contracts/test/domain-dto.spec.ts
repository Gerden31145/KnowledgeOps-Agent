import { describe, expect, it } from 'vitest'

import { agentRunDtoSchema, taskDtoSchema } from '../src/index.js'

const TASK_ID = '10c4e6cc-0041-4f53-8f68-2c5ea1f93e37'
const STAGE_ID = 'da81199f-6d47-4524-b8f4-4d3217d9a80d'
const RUN_ID = '79f9028f-2f99-4fcb-98ff-6d45e70175c3'

describe('domain DTO contracts', () => {
  it('accepts a task snapshot without presentation-specific fields', () => {
    const task = taskDtoSchema.parse({
      id: TASK_ID,
      stageId: STAGE_ID,
      title: '梳理事件循环',
      state: 'IN_PROGRESS',
      position: 1,
      targetPath: 'notes/event-loop.md',
      version: 2,
      createdAt: '2026-08-03T01:00:00.000Z',
      updatedAt: '2026-08-03T02:00:00.000Z',
    })

    expect(task.state).toBe('IN_PROGRESS')
    expect(task).not.toHaveProperty('badgeColor')
  })

  it('keeps Task states out of the AgentRun status field', () => {
    const result = agentRunDtoSchema.safeParse({
      id: RUN_ID,
      taskId: TASK_ID,
      kind: 'NOTE_VERIFICATION',
      status: 'PASSED',
      taskStateBeforeRun: 'IN_PROGRESS',
      retryOfRunId: null,
      workflowVersion: 'note-v1',
      version: 0,
      queuedAt: '2026-08-03T01:00:00.000Z',
      startedAt: null,
      finishedAt: null,
    })

    expect(result.success).toBe(false)
  })

  it('requires terminal runs to record when the attempt finished', () => {
    const result = agentRunDtoSchema.safeParse({
      id: RUN_ID,
      taskId: TASK_ID,
      kind: 'NOTE_VERIFICATION',
      status: 'FAILED',
      taskStateBeforeRun: 'IN_PROGRESS',
      retryOfRunId: null,
      workflowVersion: 'note-v1',
      version: 1,
      queuedAt: '2026-08-03T01:00:00.000Z',
      startedAt: '2026-08-03T01:00:01.000Z',
      finishedAt: null,
    })

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['finishedAt'])
  })
})
