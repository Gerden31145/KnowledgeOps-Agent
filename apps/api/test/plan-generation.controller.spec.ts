import type {
  PlanGenerationAcceptedResponse,
  StartPlanGenerationInput,
} from '@knowledgeops/contracts'
import { ConflictException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'

import {
  type AcceptPlanGenerationRequest,
  AcceptPlanGenerationService,
} from '../src/plan-generation/accept-plan-generation.service.js'
import { PlanGenerationController } from '../src/plan-generation/plan-generation.controller.js'
import { ActivePlanGenerationRunError } from '../src/plan-generation/plan-generation.errors.js'

describe('PlanGenerationController', () => {
  const actor = {
    userId: '1ba9edfa-0e95-4da9-84cb-520f9f67c1a1',
    timezone: 'Asia/Shanghai',
  }

  it('returns the queued run receipt and declares HTTP 202', async () => {
    const accepted: PlanGenerationAcceptedResponse = {
      generationRunId: 'abfe5ca9-5873-49df-bbf0-f45667a41d55',
      status: 'QUEUED',
    }
    const execute =
      vi.fn<(request: AcceptPlanGenerationRequest) => Promise<PlanGenerationAcceptedResponse>>()
    execute.mockResolvedValue(accepted)
    const service = { execute } as unknown as AcceptPlanGenerationService
    const controller = new PlanGenerationController(service, actor)
    const input: StartPlanGenerationInput = { modelId: 'configured-primary' }

    await expect(
      controller.startPlanGeneration('69057518-5456-4e20-a956-1c2c021452f3', input),
    ).resolves.toEqual(accepted)
    expect(execute).toHaveBeenCalledWith({
      actorUserId: actor.userId,
      goalId: '69057518-5456-4e20-a956-1c2c021452f3',
      input,
    })
    expect(Reflect.getMetadata('__httpCode__', controller.startPlanGeneration)).toBe(202)
  })

  it('maps an already-active run to a conflict with the recoverable run ID', async () => {
    const execute = vi.fn()
    execute.mockRejectedValue(
      new ActivePlanGenerationRunError('abfe5ca9-5873-49df-bbf0-f45667a41d55'),
    )
    const service = { execute } as unknown as AcceptPlanGenerationService
    const controller = new PlanGenerationController(service, actor)

    await expect(
      controller.startPlanGeneration('69057518-5456-4e20-a956-1c2c021452f3', {
        modelId: 'configured-primary',
      }),
    ).rejects.toMatchObject({
      constructor: ConflictException,
      response: {
        code: 'CONFLICT',
        generationRunId: 'abfe5ca9-5873-49df-bbf0-f45667a41d55',
      },
    })
  })
})
