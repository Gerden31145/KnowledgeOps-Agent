import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { ChatOpenAI } from '@langchain/openai'
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
  it('sends json_object and an explicit schema through the real SDK for JSON-mode providers', async () => {
    const fetchResponse = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: 'glm-5.3',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify(validPlanGenerationOutput),
              },
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const generator = new LangChainPlanGenerator(
      {
        apiKey: 'server-secret',
        baseUrl: 'https://provider.example/v4',
        structuredOutputMethod: 'jsonMode',
      },
      (input) =>
        new ChatOpenAI({
          apiKey: input.apiKey,
          model: input.modelName,
          maxRetries: 0,
          configuration: { baseURL: input.baseUrl, fetch: fetchResponse },
        }),
    )

    await expect(generatePlanCandidate(generator, validPlanGenerationRequest)).resolves.toEqual(
      validPlanGenerationOutput,
    )
    expect(fetchResponse).toHaveBeenCalledOnce()
    const [url, init] = fetchResponse.mock.calls[0]!
    expect(String(url)).toBe('https://provider.example/v4/chat/completions')
    const body = JSON.parse(init.body)
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.messages[0].content).toContain('acceptanceCriteria')
    expect(body.messages[0].content).toContain('dependsOnTaskIds')
    expect(JSON.stringify(body)).not.toContain('server-secret')
  })

  it.each(['jsonSchema', 'jsonMode'] as const)(
    'rejects wrong-shaped content in %s mode without misclassifying SDK validation',
    async (method) => {
      const fetchResponse = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 0,
            model: 'glm-5.3',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: '{"stages":[{}]}' },
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      )
      const generator = new LangChainPlanGenerator(
        { apiKey: 'server-secret', structuredOutputMethod: method },
        (input) =>
          new ChatOpenAI({
            apiKey: input.apiKey,
            model: input.modelName,
            maxRetries: 0,
            configuration: { fetch: fetchResponse },
          }),
      )

      await expect(generator.generate(validPlanGenerationRequest)).rejects.toMatchObject({
        code: 'MODEL_OUTPUT_INVALID',
      })
      expect(fetchResponse).toHaveBeenCalledOnce()
    },
  )

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
