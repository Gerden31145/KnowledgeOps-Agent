import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { describe, expect, it, vi } from 'vitest'

import {
  LangChainPlanGenerator,
  PlanGenerationModelError,
  generatePlanCandidate,
  type LangChainChatModelFactory,
} from '../src/index.js'
import {
  validPlanGenerationOutput,
  validPlanGenerationRequest,
} from './fixtures/plan-generation.js'

function createModelFactory(result: unknown) {
  const invoke = vi.fn().mockResolvedValue(result)
  const withStructuredOutput = vi.fn().mockReturnValue({ invoke })
  const factory = vi.fn(() => ({ withStructuredOutput }) as unknown as BaseChatModel)

  return { factory, invoke, withStructuredOutput }
}

describe('LangChainPlanGenerator', () => {
  it('uses LangChain structured output without leaking its types through the business port', async () => {
    const { factory, invoke, withStructuredOutput } = createModelFactory({
      raw: {},
      parsed: validPlanGenerationOutput,
    })
    const generator = new LangChainPlanGenerator({ apiKey: 'server-secret' }, factory)

    await expect(generatePlanCandidate(generator, validPlanGenerationRequest)).resolves.toEqual(
      validPlanGenerationOutput,
    )

    expect(factory).toHaveBeenCalledWith({
      apiKey: 'server-secret',
      modelName: 'test-model',
    })
    expect(withStructuredOutput).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        includeRaw: true,
        name: 'knowledgeops_plan_generation',
        strict: true,
      }),
    )
    expect(invoke).toHaveBeenCalledOnce()
    expect(JSON.stringify(invoke.mock.calls[0]?.[0])).not.toContain('server-secret')
  })

  it('maps an unparseable structured response to an explicit output error', async () => {
    const { factory } = createModelFactory({ raw: {}, parsed: null })
    const generator = new LangChainPlanGenerator({ apiKey: 'server-secret' }, factory)

    await expect(generator.generate(validPlanGenerationRequest)).rejects.toMatchObject({
      code: 'MODEL_OUTPUT_INVALID',
      constructor: PlanGenerationModelError,
    })
  })

  it('rejects missing credentials, unsupported providers, and unknown contract versions', async () => {
    const neverCalled: LangChainChatModelFactory = vi.fn()

    await expect(
      new LangChainPlanGenerator({}, neverCalled).generate(validPlanGenerationRequest),
    ).rejects.toMatchObject({ code: 'MODEL_CONFIGURATION_ERROR' })

    await expect(
      new LangChainPlanGenerator({ apiKey: 'server-secret' }, neverCalled).generate({
        ...validPlanGenerationRequest,
        model: { ...validPlanGenerationRequest.model, provider: 'unsupported' },
      }),
    ).rejects.toMatchObject({ code: 'MODEL_CONFIGURATION_ERROR' })

    await expect(
      new LangChainPlanGenerator({ apiKey: 'server-secret' }, neverCalled).generate({
        ...validPlanGenerationRequest,
        model: { ...validPlanGenerationRequest.model, promptVersion: 'unknown-prompt' },
      }),
    ).rejects.toMatchObject({ code: 'MODEL_CONFIGURATION_ERROR' })

    expect(neverCalled).not.toHaveBeenCalled()
  })

  it('distinguishes an aborted invocation from an upstream failure', async () => {
    const upstreamError = new Error('provider unavailable')
    const invoke = vi.fn().mockRejectedValue(upstreamError)
    const factory = vi.fn(
      () => ({ withStructuredOutput: () => ({ invoke }) }) as unknown as BaseChatModel,
    )
    const generator = new LangChainPlanGenerator({ apiKey: 'server-secret' }, factory)

    await expect(generator.generate(validPlanGenerationRequest)).rejects.toMatchObject({
      code: 'MODEL_UPSTREAM_ERROR',
      cause: upstreamError,
    })

    const controller = new AbortController()
    controller.abort()

    await expect(
      generator.generate(validPlanGenerationRequest, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'MODEL_ABORTED' })
  })
})
