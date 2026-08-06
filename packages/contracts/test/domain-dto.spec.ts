import { describe, expect, it } from 'vitest'

import { agentRunDtoSchema, taskDtoSchema } from '../src/index.js'
import { createAgentRunDtoFixture, createTaskDtoFixture } from './fixtures/domain.js'

describe('domain DTO contracts', () => {
  it('accepts a task snapshot without presentation-specific fields', () => {
    const task = taskDtoSchema.parse(createTaskDtoFixture())

    expect(task.state).toBe('IN_PROGRESS')
    expect(task).not.toHaveProperty('badgeColor')
  })

  it('keeps Task states out of the AgentRun status field', () => {
    const result = agentRunDtoSchema.safeParse({
      ...createAgentRunDtoFixture(),
      status: 'PASSED',
    })

    expect(result.success).toBe(false)
  })

  it('requires terminal runs to record when the attempt finished', () => {
    const result = agentRunDtoSchema.safeParse(
      createAgentRunDtoFixture({
        status: 'FAILED',
        version: 1,
        startedAt: '2026-08-03T01:00:01.000Z',
        finishedAt: null,
      }),
    )

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['finishedAt'])
  })
})
