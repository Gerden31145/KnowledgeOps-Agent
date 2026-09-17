import type { PlanGenerationRunStatusResponse } from '@knowledgeops/contracts'
import { NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'

import type {
  GetPlanGenerationRunRequest,
  GetPlanGenerationRunService,
} from '../src/plan-generation/get-plan-generation-run.service.js'
import { PlanGenerationRunController } from '../src/plan-generation/plan-generation-run.controller.js'
import { PlanGenerationRunNotFoundError } from '../src/plan-generation/plan-generation.errors.js'
import type { PlanGenerationStreamService } from '../src/plan-generation/plan-generation-stream.service.js'

describe('PlanGenerationRunController', () => {
  const actor = {
    userId: '1ba9edfa-0e95-4da9-84cb-520f9f67c1a1',
    timezone: 'Asia/Shanghai',
  }

  it('returns the persisted polling snapshot for the current actor', async () => {
    const response: PlanGenerationRunStatusResponse = {
      generationRunId: 'abfe5ca9-5873-49df-bbf0-f45667a41d55',
      goalId: '69057518-5456-4e20-a956-1c2c021452f3',
      status: 'RUNNING',
      version: 1,
      queuedAt: '2026-09-03T08:00:00.000Z',
      startedAt: '2026-09-03T08:00:01.000Z',
      finishedAt: null,
      error: null,
      plan: null,
    }
    const execute = vi.fn<(request: GetPlanGenerationRunRequest) => Promise<typeof response>>()
    execute.mockResolvedValue(response)
    const service = { execute } as unknown as GetPlanGenerationRunService
    const controller = new PlanGenerationRunController(
      service,
      actor,
      {} as PlanGenerationStreamService,
    )

    await expect(controller.getStatus(response.generationRunId)).resolves.toEqual(response)
    expect(execute).toHaveBeenCalledWith({
      actorUserId: actor.userId,
      generationRunId: response.generationRunId,
    })
  })

  it('does not reveal whether another user owns the requested run', async () => {
    const execute = vi.fn().mockRejectedValue(new PlanGenerationRunNotFoundError())
    const service = { execute } as unknown as GetPlanGenerationRunService
    const controller = new PlanGenerationRunController(
      service,
      actor,
      {} as PlanGenerationStreamService,
    )

    await expect(
      controller.getStatus('abfe5ca9-5873-49df-bbf0-f45667a41d55'),
    ).rejects.toBeInstanceOf(NotFoundException)
  })
})
