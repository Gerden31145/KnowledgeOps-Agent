import {
  PlanGenerationDependencyCycleError,
  PlanGenerationModelError,
  type PlanGenerationOutput,
  type PlanGenerationPort,
  type PlanGenerationRequest,
} from '@knowledgeops/agent-core'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import type { PlanGenerationSuccessFinalizer } from '../src/plan-generation/finalize-plan-generation-run.js'
import { PlanGenerationJobProcessor } from '../src/plan-generation/plan-generation-job-processor.js'
import type { PlanGenerationRunRepository } from '../src/plan-generation/plan-generation-run.repository.js'

const generationRunId = randomUUID()
const goalId = randomUUID()

const request = {
  generationRunId,
  model: {
    catalogId: 'openai-primary',
    provider: 'openai',
    modelName: 'test-model',
    promptVersion: 'plan-generation-v3',
    outputSchemaVersion: 'plan-generation-output-v3',
  },
  goal: {
    title: 'Prepare for frontend interviews',
    currentLevel: 'Comfortable with Vue 3 and TypeScript, new to backend architecture.',
    today: '2026-09-03',
    deadline: '2026-09-20',
    weeklyMinutes: 600,
  },
} as const satisfies PlanGenerationRequest

const candidate = {
  stages: [
    {
      title: 'Core concepts',
      tasks: ['one', 'two', 'three'].map((id, index) => ({
        id,
        title: `Course ${index + 1}`,
        description: `Learn core concept number ${index + 1} through a concrete scenario.`,
        type: 'COURSE' as const,
        estimatedMinutes: 60,
        knowledgePoints: [
          {
            id: `point-${id}`,
            title: `知识点 ${index + 1}`,
            description: `理解第 ${index + 1} 个核心概念及其使用边界。`,
          },
        ],
        dependsOnTaskIds: index === 0 ? [] : [index === 1 ? 'one' : 'two'],
      })),
    },
  ],
} satisfies PlanGenerationOutput

function createClaim() {
  return {
    status: 'CLAIMED' as const,
    run: {
      deadlineAt: new Date(Date.now() + 60_000),
      expectedVersion: 1,
      generationRunId,
      goalId,
      request,
    },
  }
}

function createDependencies(
  options: {
    claim?: unknown
    generate?: PlanGenerationPort['generate']
    finalize?: PlanGenerationSuccessFinalizer['execute']
    recordFailure?: PlanGenerationRunRepository['recordFailure']
  } = {},
) {
  const claimForExecution = vi.fn().mockResolvedValue(options.claim ?? createClaim())
  const recordFailure = vi.fn(
    options.recordFailure ??
      (async (_runId, _version, failure) => ({
        status: 'RECORDED' as const,
        runStatus: failure.status,
      })),
  )
  const generate = vi.fn(options.generate ?? (async () => candidate))
  const execute = vi.fn(
    options.finalize ??
      (async () => ({
        status: 'FINALIZED' as const,
        planId: randomUUID(),
      })),
  )
  const dependencyGuard = vi.fn()

  return {
    dependencyGuard,
    finalizer: { execute } as PlanGenerationSuccessFinalizer,
    generator: { generate } as PlanGenerationPort,
    repository: { claimForExecution, recordFailure } as unknown as PlanGenerationRunRepository,
    spies: { claimForExecution, dependencyGuard, execute, generate, recordFailure },
  }
}

describe('PlanGenerationJobProcessor orchestration', () => {
  it('short-circuits a terminal duplicate without invoking the model', async () => {
    const planId = randomUUID()
    const dependencies = createDependencies({
      claim: {
        status: 'SKIPPED',
        reason: 'TERMINAL',
        runStatus: 'SUCCEEDED',
        planId,
      },
    })
    const processor = new PlanGenerationJobProcessor(
      dependencies.repository,
      dependencies.generator,
      dependencies.finalizer,
      dependencies.dependencyGuard,
    )

    await expect(processor.process({ generationRunId })).resolves.toEqual({
      generationRunId,
      planId,
      reason: 'TERMINAL',
      runStatus: 'SUCCEEDED',
      status: 'SKIPPED',
    })
    expect(dependencies.spies.generate).not.toHaveBeenCalled()
    expect(dependencies.spies.execute).not.toHaveBeenCalled()
  })

  it('passes a validated acyclic candidate and fencing version to the finalizer', async () => {
    const planId = randomUUID()
    const dependencies = createDependencies({
      finalize: async () => ({ status: 'FINALIZED', planId }),
    })
    const processor = new PlanGenerationJobProcessor(
      dependencies.repository,
      dependencies.generator,
      dependencies.finalizer,
      dependencies.dependencyGuard,
    )

    await expect(processor.process({ generationRunId })).resolves.toEqual({
      generationRunId,
      planId,
      status: 'SUCCEEDED',
    })
    expect(dependencies.spies.dependencyGuard).toHaveBeenCalledWith(candidate)
    expect(dependencies.spies.execute).toHaveBeenCalledWith({
      candidate,
      expectedRunVersion: 1,
      finishedAt: expect.any(Date),
      generationRunId,
      goalId,
    })
    expect(dependencies.spies.recordFailure).not.toHaveBeenCalled()
  })

  it('records a model failure as a terminal run without invoking the finalizer', async () => {
    const dependencies = createDependencies({
      generate: async () => {
        throw new PlanGenerationModelError('MODEL_UPSTREAM_ERROR', 'provider unavailable')
      },
    })
    const processor = new PlanGenerationJobProcessor(
      dependencies.repository,
      dependencies.generator,
      dependencies.finalizer,
      dependencies.dependencyGuard,
    )

    await expect(processor.process({ generationRunId })).resolves.toEqual({
      generationRunId,
      status: 'FAILED',
    })
    expect(dependencies.spies.recordFailure).toHaveBeenCalledWith(
      generationRunId,
      1,
      {
        code: 'MODEL_UPSTREAM_ERROR',
        message: 'provider unavailable',
        status: 'FAILED',
      },
      expect.any(Date),
    )
    expect(dependencies.spies.execute).not.toHaveBeenCalled()
  })

  it('does not revive a run when a timeout wins before the model result is recorded', async () => {
    const dependencies = createDependencies({
      finalize: async () => ({
        status: 'SKIPPED',
        planId: null,
        runStatus: 'TIMED_OUT',
      }),
    })
    const processor = new PlanGenerationJobProcessor(
      dependencies.repository,
      dependencies.generator,
      dependencies.finalizer,
      dependencies.dependencyGuard,
    )

    await expect(processor.process({ generationRunId })).resolves.toEqual({
      generationRunId,
      planId: null,
      reason: 'STALE_RESULT',
      runStatus: 'TIMED_OUT',
      status: 'SKIPPED',
    })
  })

  it('maps a dependency-cycle rejection to invalid model output', async () => {
    const dependencies = createDependencies()
    const processor = new PlanGenerationJobProcessor(
      dependencies.repository,
      dependencies.generator,
      dependencies.finalizer,
      () => {
        throw new PlanGenerationDependencyCycleError()
      },
    )

    await expect(processor.process({ generationRunId })).resolves.toEqual({
      generationRunId,
      status: 'FAILED',
    })
    expect(dependencies.spies.recordFailure).toHaveBeenCalledWith(
      generationRunId,
      1,
      expect.objectContaining({ code: 'MODEL_OUTPUT_INVALID', status: 'FAILED' }),
      expect.any(Date),
    )
    expect(dependencies.spies.execute).not.toHaveBeenCalled()
  })
})
