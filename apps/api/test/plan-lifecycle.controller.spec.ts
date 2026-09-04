import type { ConfirmPlanResponse, StartTaskResponse } from '@knowledgeops/contracts'
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'

import { PlanLifecycleController } from '../src/plans/plan-lifecycle.controller.js'
import {
  AnotherTaskInProgressError,
  PlanNotFoundError,
  TaskTargetPathRequiredError,
} from '../src/plans/plan-lifecycle.errors.js'
import type { PlanLifecycleService } from '../src/plans/plan-lifecycle.service.js'

describe('PlanLifecycleController', () => {
  const actor = {
    userId: '1ba9edfa-0e95-4da9-84cb-520f9f67c1a1',
    timezone: 'Asia/Shanghai',
  }

  it('delegates plan confirmation and task start with the current actor', async () => {
    const planId = 'abfe5ca9-5873-49df-bbf0-f45667a41d55'
    const taskId = '69057518-5456-4e20-a956-1c2c021452f3'
    const confirmed: ConfirmPlanResponse = {
      planId,
      status: 'ACTIVE',
      confirmedAt: '2026-09-03T08:00:00.000Z',
      readyTaskIds: [taskId],
    }
    const started: StartTaskResponse = {
      taskId,
      state: 'IN_PROGRESS',
      version: 2,
      targetPath: 'notes/task.md',
    }
    const confirmPlan = vi.fn().mockResolvedValue(confirmed)
    const startTask = vi.fn().mockResolvedValue(started)
    const service = { confirmPlan, startTask } as unknown as PlanLifecycleService
    const controller = new PlanLifecycleController(service, actor)

    await expect(controller.confirmPlan(planId)).resolves.toEqual(confirmed)
    await expect(controller.startTask(taskId, { targetPath: 'notes/task.md' })).resolves.toEqual(
      started,
    )
    expect(confirmPlan).toHaveBeenCalledWith(planId, actor.userId)
    expect(startTask).toHaveBeenCalledWith(taskId, actor.userId, {
      targetPath: 'notes/task.md',
    })
  })

  it('maps ownership, state conflicts, and a missing path to stable HTTP errors', async () => {
    const planId = 'abfe5ca9-5873-49df-bbf0-f45667a41d55'
    const taskId = '69057518-5456-4e20-a956-1c2c021452f3'
    const confirmPlan = vi.fn().mockRejectedValue(new PlanNotFoundError())
    const startTask = vi
      .fn()
      .mockRejectedValueOnce(new AnotherTaskInProgressError(taskId))
      .mockRejectedValueOnce(new TaskTargetPathRequiredError())
    const service = { confirmPlan, startTask } as unknown as PlanLifecycleService
    const controller = new PlanLifecycleController(service, actor)

    await expect(controller.confirmPlan(planId)).rejects.toBeInstanceOf(NotFoundException)
    await expect(controller.startTask(taskId, {})).rejects.toBeInstanceOf(ConflictException)
    await expect(controller.startTask(taskId, {})).rejects.toBeInstanceOf(BadRequestException)
  })
})
