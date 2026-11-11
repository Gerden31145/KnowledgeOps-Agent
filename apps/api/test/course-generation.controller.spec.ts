import { ConflictException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'

import { CourseGenerationController } from '../src/courses/course-generation.controller.js'
import type { CourseGenerationRepository } from '../src/courses/course-generation.repository.js'
import {
  InvalidPlanLifecycleStateError,
  TaskNotFoundError,
} from '../src/plans/plan-lifecycle.errors.js'

describe('CourseGenerationController', () => {
  const actor = { userId: '1ba9edfa-0e95-4da9-84cb-520f9f67c1a1', timezone: 'Asia/Shanghai' }
  const taskId = '69057518-5456-4e20-a956-1c2c021452f3'
  const runId = 'abfe5ca9-5873-49df-bbf0-f45667a41d55'

  it('passes course retry identity and returns the persisted run receipt', async () => {
    const request = vi.fn().mockResolvedValue({ generationRunId: runId, status: 'QUEUED' })
    const controller = new CourseGenerationController(
      { request } as unknown as CourseGenerationRepository,
      actor,
    )
    await expect(controller.request(taskId, { retryOfRunId: runId })).resolves.toEqual({
      generationRunId: runId,
      status: 'QUEUED',
    })
    expect(request).toHaveBeenCalledWith(taskId, actor.userId, runId)
  })

  it('keeps ownership and state failures distinct', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new TaskNotFoundError())
      .mockRejectedValueOnce(new InvalidPlanLifecycleStateError('not ready'))
    const controller = new CourseGenerationController(
      { request } as unknown as CourseGenerationRepository,
      actor,
    )
    await expect(controller.request(taskId, {})).rejects.toBeInstanceOf(NotFoundException)
    await expect(controller.request(taskId, {})).rejects.toBeInstanceOf(ConflictException)
  })
})
