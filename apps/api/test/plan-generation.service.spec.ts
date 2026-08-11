import { describe, expect, it, vi } from 'vitest'

import { AcceptPlanGenerationService } from '../src/plan-generation/accept-plan-generation.service.js'
import { UnknownPlanGenerationModelError } from '../src/plan-generation/plan-generation.errors.js'
import { PlanGenerationModelCatalog } from '../src/plan-generation/plan-generation-model-catalog.js'
import type { PlanGenerationRepository } from '../src/plan-generation/plan-generation.repository.js'

describe('AcceptPlanGenerationService', () => {
  const catalog = new PlanGenerationModelCatalog(
    [
      {
        id: 'configured-primary',
        label: 'Configured primary',
        model: 'configured-model',
      },
    ],
    'openai',
    'prompt-v1',
    'schema-v1',
  )
  const now = new Date('2026-08-08T10:00:00.000Z')

  it('resolves a trusted server snapshot and computes a persisted deadline', async () => {
    const accept = vi.fn().mockResolvedValue({
      generationRunId: 'abfe5ca9-5873-49df-bbf0-f45667a41d55',
      status: 'QUEUED',
    })
    const repository = { accept } as unknown as PlanGenerationRepository
    const service = new AcceptPlanGenerationService(repository, catalog, 180_000, () => now)

    await service.execute({
      actorUserId: '1ba9edfa-0e95-4da9-84cb-520f9f67c1a1',
      goalId: '69057518-5456-4e20-a956-1c2c021452f3',
      input: { modelId: 'configured-primary' },
    })

    expect(accept).toHaveBeenCalledWith({
      actorUserId: '1ba9edfa-0e95-4da9-84cb-520f9f67c1a1',
      goalId: '69057518-5456-4e20-a956-1c2c021452f3',
      model: {
        catalogId: 'configured-primary',
        provider: 'openai',
        modelName: 'configured-model',
        promptVersion: 'prompt-v1',
        outputSchemaVersion: 'schema-v1',
      },
      queuedAt: now,
      deadlineAt: new Date('2026-08-08T10:03:00.000Z'),
    })
  })

  it('rejects an unknown model before opening the persistence transaction', async () => {
    const accept = vi.fn()
    const repository = { accept } as unknown as PlanGenerationRepository
    const service = new AcceptPlanGenerationService(repository, catalog, 180_000, () => now)

    await expect(
      service.execute({
        actorUserId: '1ba9edfa-0e95-4da9-84cb-520f9f67c1a1',
        goalId: '69057518-5456-4e20-a956-1c2c021452f3',
        input: { modelId: 'not-allowed' },
      }),
    ).rejects.toBeInstanceOf(UnknownPlanGenerationModelError)
    expect(accept).not.toHaveBeenCalled()
  })

  it('lists only stable public IDs and labels without provider configuration', () => {
    expect(catalog.list()).toEqual([
      {
        id: 'configured-primary',
        label: 'Configured primary',
      },
    ])
  })
})
