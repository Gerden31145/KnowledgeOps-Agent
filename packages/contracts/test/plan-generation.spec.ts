import { describe, expect, it } from 'vitest'

import {
  confirmPlanResponseSchema,
  isPlanGenerationRunRetryableState,
  isPlanGenerationRunTerminalState,
  planGenerationAcceptedResponseSchema,
  planGenerationModelCatalogResponseSchema,
  planGenerationModelSnapshotSchema,
  planGenerationRequestedEventPayloadSchema,
  planGenerationRunStatusResponseSchema,
  startPlanGenerationInputSchema,
  startTaskInputSchema,
  startTaskResponseSchema,
} from '../src/index.js'

describe('plan generation contracts', () => {
  it('accepts only a stable model ID and an optional UUID retry link', () => {
    expect(
      startPlanGenerationInputSchema.parse({
        modelId: 'openai-primary',
        retryOfRunId: '4d58c95a-cc50-4ad9-861d-7f8c6f03f104',
      }),
    ).toEqual({
      modelId: 'openai-primary',
      retryOfRunId: '4d58c95a-cc50-4ad9-861d-7f8c6f03f104',
    })

    expect(
      startPlanGenerationInputSchema.safeParse({
        modelId: 'openai-primary',
        apiKey: 'must-never-enter-the-contract',
      }).success,
    ).toBe(false)
  })

  it('keeps the accepted response intentionally small and queued', () => {
    expect(
      planGenerationAcceptedResponseSchema.parse({
        generationRunId: '4d58c95a-cc50-4ad9-861d-7f8c6f03f104',
        status: 'QUEUED',
      }),
    ).toEqual({
      generationRunId: '4d58c95a-cc50-4ad9-861d-7f8c6f03f104',
      status: 'QUEUED',
    })

    expect(
      planGenerationAcceptedResponseSchema.safeParse({
        generationRunId: '4d58c95a-cc50-4ad9-861d-7f8c6f03f104',
        status: 'RUNNING',
      }).success,
    ).toBe(false)
  })

  it('separates the browser-safe catalog from the persisted model snapshot', () => {
    expect(
      planGenerationModelCatalogResponseSchema.parse({
        models: [{ id: 'openai-primary', label: 'Fast model' }],
      }),
    ).toEqual({ models: [{ id: 'openai-primary', label: 'Fast model' }] })

    expect(
      planGenerationModelSnapshotSchema.parse({
        catalogId: 'openai-primary',
        provider: 'openai',
        modelName: 'provider-model-name',
        promptVersion: 'plan-generation-v1',
        outputSchemaVersion: 'plan-generation-output-v1',
      }),
    ).toMatchObject({ provider: 'openai', modelName: 'provider-model-name' })

    expect(
      planGenerationModelCatalogResponseSchema.safeParse({
        models: [
          {
            id: 'openai-primary',
            label: 'Fast model',
            apiKey: 'must-never-reach-the-browser',
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('shares the minimal outbox payload without prompts or credentials', () => {
    expect(
      planGenerationRequestedEventPayloadSchema.parse({
        generationRunId: '4d58c95a-cc50-4ad9-861d-7f8c6f03f104',
      }),
    ).toEqual({ generationRunId: '4d58c95a-cc50-4ad9-861d-7f8c6f03f104' })
  })

  it('distinguishes terminal states from user-retryable failures', () => {
    expect(isPlanGenerationRunTerminalState('SUCCEEDED')).toBe(true)
    expect(isPlanGenerationRunTerminalState('RUNNING')).toBe(false)
    expect(isPlanGenerationRunRetryableState('FAILED')).toBe(true)
    expect(isPlanGenerationRunRetryableState('TIMED_OUT')).toBe(true)
    expect(isPlanGenerationRunRetryableState('SUCCEEDED')).toBe(false)
  })

  it('exposes a browser-safe polling snapshot without model secrets', () => {
    expect(
      planGenerationRunStatusResponseSchema.parse({
        generationRunId: '4d58c95a-cc50-4ad9-861d-7f8c6f03f104',
        goalId: '7fb289a2-0376-43f2-bbb2-ff339257f673',
        status: 'FAILED',
        queuedAt: '2026-09-03T08:00:00.000Z',
        startedAt: '2026-09-03T08:00:01.000Z',
        finishedAt: '2026-09-03T08:00:02.000Z',
        error: { code: 'MODEL_UPSTREAM_ERROR', message: 'Provider unavailable' },
        plan: null,
      }),
    ).toMatchObject({ status: 'FAILED', plan: null })

    expect(
      planGenerationRunStatusResponseSchema.safeParse({
        generationRunId: '4d58c95a-cc50-4ad9-861d-7f8c6f03f104',
        goalId: '7fb289a2-0376-43f2-bbb2-ff339257f673',
        status: 'RUNNING',
        queuedAt: '2026-09-03T08:00:00.000Z',
        startedAt: null,
        finishedAt: null,
        error: null,
        plan: null,
        apiKey: 'must-not-be-returned',
      }).success,
    ).toBe(false)
  })

  it('validates plan-confirm and task-start command boundaries', () => {
    const planId = '4d58c95a-cc50-4ad9-861d-7f8c6f03f104'
    const taskId = '7fb289a2-0376-43f2-bbb2-ff339257f673'

    expect(
      confirmPlanResponseSchema.parse({
        planId,
        status: 'ACTIVE',
        confirmedAt: '2026-09-03T08:00:00.000Z',
        readyTaskIds: [taskId],
      }),
    ).toMatchObject({ planId, status: 'ACTIVE' })
    expect(startTaskInputSchema.parse({ targetPath: 'notes/event-loop.md' })).toEqual({
      targetPath: 'notes/event-loop.md',
    })
    expect(
      startTaskResponseSchema.parse({
        taskId,
        state: 'IN_PROGRESS',
        version: 2,
        targetPath: 'notes/event-loop.md',
      }),
    ).toMatchObject({ taskId, state: 'IN_PROGRESS' })
    expect(startTaskInputSchema.safeParse({ targetPath: '../outside.md' }).success).toBe(false)
    expect(startTaskInputSchema.safeParse({ targetPath: '..\\outside.md' }).success).toBe(false)
  })
})
