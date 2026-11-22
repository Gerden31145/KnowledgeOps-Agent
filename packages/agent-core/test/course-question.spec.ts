import { describe, expect, it, vi } from 'vitest'

import {
  COURSE_QUESTION_POLICIES,
  generateCourseQuestionAnswer,
  InvalidCourseQuestionAnswerError,
  InvalidCourseQuestionRequestError,
  LangChainCourseQuestionAnswering,
  type CourseQuestionRequest,
  type LangChainChatModelFactory,
} from '../src/index.js'
import { validCourseLearningPackage } from './fixtures/course-generation.js'

function request(depth: CourseQuestionRequest['depth'] = 'CONTEXTUAL'): CourseQuestionRequest {
  return {
    model: {
      catalogId: 'fixture',
      provider: 'openai',
      modelName: 'fixture-model',
      reasoningEffort: null,
    },
    goal: '学习浏览器事件循环',
    course: { title: '事件循环', description: '结合浏览器渲染理解任务调度。' },
    section: validCourseLearningPackage.sections[0]!,
    selectedText: validCourseLearningPackage.sections[0]!.explanation.slice(0, 80),
    question: '为什么不会阻塞下一次渲染？',
    depth,
    history: [],
  }
}

describe('course question answering', () => {
  it('enforces the history and answer size for each depth', async () => {
    const port = { answer: vi.fn(async () => ({ answer: '先清空微任务，再继续调度。' })) }
    const contextual = request()
    contextual.history = [{ question: '之前的问题', answer: '之前的回答' }]
    await expect(generateCourseQuestionAnswer(port, contextual)).resolves.toEqual({
      answer: '先清空微任务，再继续调度。',
    })

    await expect(
      generateCourseQuestionAnswer(port, { ...request('QUICK'), history: contextual.history }),
    ).rejects.toBeInstanceOf(InvalidCourseQuestionRequestError)
    expect(port.answer).toHaveBeenCalledOnce()

    await expect(
      generateCourseQuestionAnswer(port, {
        ...request('QUICK'),
        question: '请详细展开',
      }),
    ).resolves.toBeDefined()
    await expect(
      generateCourseQuestionAnswer(
        { answer: async () => ({ answer: '长'.repeat(501) }) },
        request('QUICK'),
      ),
    ).rejects.toBeInstanceOf(InvalidCourseQuestionAnswerError)
  })

  it('passes depth-specific token limits and structure to the model adapter', async () => {
    const invocations: { content: unknown }[][] = []
    const invoke = vi.fn(async (messages: { content: unknown }[]) => {
      invocations.push(messages)
      return { parsed: { answer: '结合当前区块作答。' } }
    })
    const withStructuredOutput = vi.fn(() => ({ invoke }))
    const factory = vi.fn(() => ({ withStructuredOutput })) as unknown as LangChainChatModelFactory
    const answering = new LangChainCourseQuestionAnswering({ apiKey: 'fixture-key' }, factory)

    await answering.answer(request('QUICK'))
    await answering.answer(request('DEEP'))

    expect(factory).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        maxOutputTokens: COURSE_QUESTION_POLICIES.QUICK.maxOutputTokens,
        reasoningEffort: 'low',
      }),
    )
    expect(factory).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        maxOutputTokens: COURSE_QUESTION_POLICIES.DEEP.maxOutputTokens,
        reasoningEffort: 'low',
      }),
    )
    const firstMessages = invocations[0]!
    const secondMessages = invocations[1]!
    expect(String(firstMessages[0]?.content)).toContain('Answer directly and briefly')
    expect(String(secondMessages[0]?.content)).toContain('core mechanism')
    expect(String(firstMessages[1]?.content)).not.toContain('exercises')
  })

  it.each([
    { parsed: '{"answer":"来自 SDK 字符串的回答。"}', raw: {} },
    { parsed: null, raw: { content: '{"answer":"来自原始 JSON 的回答。"}' } },
  ])('parses serialized SDK output while keeping the answer contract', async (output) => {
    const invoke = vi.fn(async () => output)
    const factory = vi.fn(() => ({
      withStructuredOutput: () => ({ invoke }),
    })) as unknown as LangChainChatModelFactory
    const answering = new LangChainCourseQuestionAnswering({ apiKey: 'fixture-key' }, factory)

    await expect(answering.answer(request())).resolves.toEqual({
      answer: output.parsed ? '来自 SDK 字符串的回答。' : '来自原始 JSON 的回答。',
    })
  })

  it('reports JSON syntax failure using safe metadata without retaining the response text', async () => {
    const invoke = vi.fn(async () => ({
      parsed: null,
      raw: {
        content: '{"answer":"sensitive partial answer',
        response_metadata: { finish_reason: 'length' },
      },
    }))
    const factory = vi.fn(() => ({
      withStructuredOutput: () => ({ invoke }),
    })) as unknown as LangChainChatModelFactory
    const answering = new LangChainCourseQuestionAnswering({ apiKey: 'fixture-key' }, factory)

    await expect(answering.answer(request())).rejects.toMatchObject({
      code: 'MODEL_OUTPUT_INVALID',
      diagnostic: {
        finishReason: 'length',
        parsedType: 'null',
        rawContentType: 'string',
        failureType: 'JSON_PARSE',
        schemaIssues: [],
      },
    })
  })

  it('reports schema issue paths and types without retaining field values', async () => {
    const invoke = vi.fn(async () => ({
      parsed: null,
      raw: {
        content: '{"result":"sensitive answer value"}',
        response_metadata: { finish_reason: 'stop' },
      },
    }))
    const factory = vi.fn(() => ({
      withStructuredOutput: () => ({ invoke }),
    })) as unknown as LangChainChatModelFactory
    const answering = new LangChainCourseQuestionAnswering({ apiKey: 'fixture-key' }, factory)

    await expect(answering.answer(request())).rejects.toMatchObject({
      code: 'MODEL_OUTPUT_INVALID',
      diagnostic: {
        finishReason: 'stop',
        parsedType: 'null',
        rawContentType: 'string',
        failureType: 'SCHEMA_VALIDATION',
        schemaIssues: expect.arrayContaining([
          expect.objectContaining({ code: 'invalid_type', path: 'answer', expected: 'string' }),
          expect.objectContaining({ code: 'unrecognized_keys', path: '<root>' }),
        ]),
      },
    })
  })
})
