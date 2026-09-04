import { PLAN_GENERATION_JOB_NAME } from '@knowledgeops/contracts'
import { UnrecoverableError } from 'bullmq'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import {
  NonRetryablePlanGenerationJobError,
  createPlanGenerationBullMqProcessor,
  type PlanGenerationJobHandler,
} from '../src/plan-generation/plan-generation-job-processor.js'

function createHandler(
  implementation: PlanGenerationJobHandler['process'],
): PlanGenerationJobHandler {
  return { process: implementation }
}

function createJob(overrides: { data?: unknown; name?: string } = {}) {
  const generationRunId = randomUUID()

  return {
    data: overrides.data ?? { generationRunId },
    name: overrides.name ?? PLAN_GENERATION_JOB_NAME,
  }
}

describe('BullMQ plan generation processor boundary', () => {
  it('validates the job and delegates a stable payload to the handler', async () => {
    const process = vi.fn<PlanGenerationJobHandler['process']>(async (payload) => ({
      generationRunId: payload.generationRunId,
      planId: null,
      reason: 'TERMINAL',
      runStatus: 'SUCCEEDED',
      status: 'SKIPPED',
    }))
    const processor = createPlanGenerationBullMqProcessor(createHandler(process))
    const generationRunId = randomUUID()
    const data = { generationRunId }
    const job = createJob({ data })

    await expect(processor(job as never, 'token')).resolves.toEqual({
      generationRunId,
      planId: null,
      reason: 'TERMINAL',
      runStatus: 'SUCCEEDED',
      status: 'SKIPPED',
    })
    expect(process).toHaveBeenCalledWith(data, {})
  })

  it('marks a malformed queue payload as unrecoverable', async () => {
    const processor = createPlanGenerationBullMqProcessor(
      createHandler(async () => {
        throw new Error('must not run')
      }),
    )

    await expect(processor(createJob({ data: {} }) as never, 'token')).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
  })

  it('marks an unexpected Job name as unrecoverable', async () => {
    const processor = createPlanGenerationBullMqProcessor(
      createHandler(async () => {
        throw new Error('must not run')
      }),
    )

    await expect(
      processor(createJob({ name: 'unexpected-job' }) as never, 'token'),
    ).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it('preserves operational failures so BullMQ can retry them', async () => {
    const processor = createPlanGenerationBullMqProcessor(
      createHandler(async () => {
        throw new Error('temporary provider failure')
      }),
    )

    await expect(processor(createJob() as never, 'token')).rejects.toThrow(
      'temporary provider failure',
    )
  })

  it('maps explicitly permanent handler failures to UnrecoverableError', async () => {
    const processor = createPlanGenerationBullMqProcessor(
      createHandler(async () => {
        throw new NonRetryablePlanGenerationJobError('run no longer exists')
      }),
    )

    await expect(processor(createJob() as never, 'token')).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
  })
})
