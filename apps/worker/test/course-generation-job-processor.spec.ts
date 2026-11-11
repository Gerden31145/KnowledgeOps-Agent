import { CourseGenerationModelError } from '@knowledgeops/agent-core'
import {
  validCourseGenerationRequest,
  validCourseLearningPackage,
} from '../../../packages/agent-core/test/fixtures/course-generation.js'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { CourseGenerationJobProcessor } from '../src/course-generation/course-generation-job-processor.js'

const generationRunId = randomUUID()
const request = { ...validCourseGenerationRequest, generationRunId }

function dependencies(
  overrides: { generate?: () => Promise<unknown>; finalize?: () => Promise<unknown> } = {},
) {
  const claimForExecution = vi.fn().mockResolvedValue({
    status: 'CLAIMED',
    run: {
      deadlineAt: new Date(Date.now() + 60_000),
      expectedVersion: 1,
      generationRunId,
      request,
    },
  })
  const recordFailure = vi.fn().mockImplementation(async (_id, _version, failure) => ({
    status: 'RECORDED',
    runStatus: failure.status,
  }))
  const generate = vi.fn(overrides.generate ?? (async () => validCourseLearningPackage))
  const execute = vi.fn(
    overrides.finalize ?? (async () => ({ status: 'FINALIZED', courseVersionId: randomUUID() })),
  )
  return {
    processor: new CourseGenerationJobProcessor(
      { claimForExecution, recordFailure } as never,
      { generate },
      { execute } as never,
    ),
    execute,
    generate,
    recordFailure,
  }
}

describe('CourseGenerationJobProcessor', () => {
  it('passes the frozen request and fencing version to atomic finalization', async () => {
    const context = dependencies()
    await expect(context.processor.process({ generationRunId })).resolves.toMatchObject({
      status: 'SUCCEEDED',
      generationRunId,
    })
    expect(context.generate).toHaveBeenCalledWith(request, expect.any(Object))
    expect(context.execute).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRunVersion: 1, candidate: validCourseLearningPackage }),
    )
  })

  it('records model failure without saving a partial learning package', async () => {
    const context = dependencies({
      generate: async () => {
        throw new CourseGenerationModelError('MODEL_UPSTREAM_ERROR', 'provider unavailable')
      },
    })
    await expect(context.processor.process({ generationRunId })).resolves.toEqual({
      generationRunId,
      status: 'FAILED',
    })
    expect(context.recordFailure).toHaveBeenCalledWith(
      generationRunId,
      1,
      expect.objectContaining({ code: 'MODEL_UPSTREAM_ERROR', status: 'FAILED' }),
      expect.any(Date),
    )
    expect(context.execute).not.toHaveBeenCalled()
  })

  it('does not finalize a stale run after a racing success', async () => {
    const context = dependencies({
      finalize: async () => ({ status: 'SKIPPED', runStatus: 'SUCCEEDED' }),
    })
    await expect(context.processor.process({ generationRunId })).resolves.toEqual({
      generationRunId,
      status: 'SKIPPED',
      reason: 'TERMINAL',
      runStatus: 'SUCCEEDED',
    })
  })
})
