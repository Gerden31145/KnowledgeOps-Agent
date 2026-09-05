import type {
  PlanDetailResponse,
  TaskDetailResponse,
  TodayTasksResponse,
} from '@knowledgeops/contracts'
import { NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'

import { PlanNotFoundError } from '../src/plans/plan-lifecycle.errors.js'
import { PlanQueryController } from '../src/plans/plan-query.controller.js'
import type { PlanQueryService } from '../src/plans/plan-query.service.js'

describe('PlanQueryController', () => {
  const actor = {
    userId: '00000000-0000-4000-8000-000000000001',
    timezone: 'Asia/Shanghai',
  }
  const ids = {
    goal: 'fedfb2e2-8f0e-4830-8240-f198cecabd95',
    plan: '1e3d67ef-0353-413a-a921-a837e0c6fd75',
    task: 'b2d6af47-6f36-4051-880c-58fa486020f8',
  }

  it('passes current ownership into all workspace reads', async () => {
    const plan = { id: ids.plan } as PlanDetailResponse
    const today = { plan: null, tasks: [] } satisfies TodayTasksResponse
    const task = { id: ids.task } as TaskDetailResponse
    const getPlan = vi.fn().mockResolvedValue(plan)
    const getToday = vi.fn().mockResolvedValue(today)
    const getTask = vi.fn().mockResolvedValue(task)
    const controller = new PlanQueryController(
      { getPlan, getToday, getTask } as unknown as PlanQueryService,
      actor,
    )

    // Response schemas are separately tested; use complete parseable values at repository boundaries.
    getPlan.mockRejectedValueOnce(new PlanNotFoundError())
    await expect(controller.getPlan(ids.plan)).rejects.toBeInstanceOf(NotFoundException)
    await expect(controller.getToday()).resolves.toEqual(today)
    getTask.mockRejectedValueOnce(new PlanNotFoundError())
    await expect(controller.getTask(ids.task)).rejects.toBeInstanceOf(NotFoundException)

    expect(getPlan).toHaveBeenCalledWith(ids.plan, actor.userId)
    expect(getToday).toHaveBeenCalledWith(actor.userId)
    expect(getTask).toHaveBeenCalledWith(ids.task, actor.userId)
  })
})
