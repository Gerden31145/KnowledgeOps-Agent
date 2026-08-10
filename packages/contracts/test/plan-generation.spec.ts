import { describe, expect, it } from 'vitest'

import {
  isPlanGenerationRunRetryableState,
  isPlanGenerationRunTerminalState,
  planGenerationAcceptedResponseSchema,
  planGenerationRequestedEventPayloadSchema,
  startPlanGenerationInputSchema,
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
})
