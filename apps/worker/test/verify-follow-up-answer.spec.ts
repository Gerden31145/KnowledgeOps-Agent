import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  LangChainAnswerVerifier,
  NoteVerificationModelError,
  type AnswerVerificationRequest,
  type LangChainChatModelFactory,
} from '@knowledgeops/agent-core'
import { answerVerificationResultSchema } from '@knowledgeops/contracts'
import {
  answerVerificationCandidate,
  answerVerificationRequest,
} from '../../../packages/agent-core/test/fixtures/answer-verification.js'
import { parseNoteEvidence } from '../src/verification/parse-note-evidence.js'
import { verifyFollowUpAnswer } from '../src/verification/verify-follow-up-answer.js'

const usage = { inputTokens: 40, outputTokens: 20, totalTokens: 60 }
const options = () => ({ signal: new AbortController().signal, maxOutputTokens: 1_024 })
function fixture() {
  const request = structuredClone(answerVerificationRequest)
  return {
    ...request,
    note: parseNoteEvidence({
      repositoryId: request.note.repositoryId,
      path: request.note.path,
      sourceCommitSha: request.note.commitSha,
      contentHash: request.note.contentHash,
      content: request.note.lines.join('\n'),
      lineCount: request.note.lines.length,
    }),
  }
}

describe('R10: one follow-up answer verification call', () => {
  it('binds a valid judgment to the saved answer and original question, retaining both evidence sources', async () => {
    const input = fixture()
    const before = structuredClone(input)
    const verify = vi.fn().mockResolvedValue({ candidate: answerVerificationCandidate, usage })
    const response = await verifyFollowUpAnswer({ verify }, input, options())
    expect(response.usage).toEqual(usage)
    expect(response.result).toMatchObject({
      outcome: 'PASSED',
      criterionId: input.question.criterionId,
      questionId: input.question.id,
      answerSubmissionId: input.answer.id,
      citations: [{ ...input.note.source, startLine: 3, endLine: 3 }],
      answerCitations: [{ answerSubmissionId: input.answer.id, startLine: 1, endLine: 2 }],
    })
    expect(answerVerificationResultSchema.safeParse(response.result).success).toBe(true)
    expect(response.result.answerCitations[0]).not.toHaveProperty('commitSha')
    expect(response.result).not.toHaveProperty('taskState')
    expect(input).toEqual(before)
    expect(verify).toHaveBeenCalledOnce()
  })

  it.each(['FAILED', 'INSUFFICIENT_EVIDENCE'] as const)(
    'preserves %s as a business judgment with advice, not an execution error',
    async (outcome) => {
      const input = fixture()
      input.answer.content = outcome === 'FAILED' ? '定时器一定先执行。' : '不知道。'
      const candidate = {
        ...answerVerificationCandidate,
        outcome,
        rationale: '回答未体现微任务队列处理到清空的规则。',
        suggestions: ['结合新加入的微任务解释执行顺序。'],
        answerCitations:
          outcome === 'FAILED' ? [{ startLine: 1, endLine: 1, excerpt: input.answer.content }] : [],
      }
      const verify = vi.fn().mockResolvedValue({ candidate, usage: null })
      const response = await verifyFollowUpAnswer({ verify }, input, options())
      expect(response.result.outcome).toBe(outcome)
      expect(response.result.suggestions).toEqual(candidate.suggestions)
      expect(response.usage).toBeNull()
      expect(verify).toHaveBeenCalledOnce()
    },
  )

  it.each([
    'task',
    'question',
    'commit',
    'hash',
    'question-quote',
    'question-range',
    'question-source',
  ])('rejects mismatched %s before invoking the model', async (field) => {
    const input = fixture()
    if (field === 'task') input.task.id = randomUUID()
    if (field === 'question') input.answer.questionId = randomUUID()
    if (field === 'commit') input.note.source.commitSha = 'c'.repeat(40)
    if (field === 'hash') input.question.source.contentHash = '0'.repeat(64)
    if (field === 'question-quote') input.question.citations[0]!.excerpt = '不存在的笔记'
    if (field === 'question-range') input.question.citations[0]!.endLine = 999
    if (field === 'question-source') input.question.citations[0]!.repositoryId = randomUUID()
    const verify = vi.fn()
    await expect(verifyFollowUpAnswer({ verify }, input, options())).rejects.toMatchObject({
      code: 'INVALID_ANSWER_CONTEXT',
    })
    expect(verify).not.toHaveBeenCalled()
  })

  it.each([
    'forged-note',
    'note-as-answer',
    'reversed-range',
    'outside-answer',
    'blank-note',
    'no-note',
    'no-answer',
  ])('rejects %s citations without losing paid-call usage', async (mode) => {
    const candidate = structuredClone(answerVerificationCandidate)
    if (mode === 'forged-note') candidate.citations[0]!.excerpt = '伪造的文字'
    if (mode === 'note-as-answer') candidate.answerCitations = candidate.citations
    if (mode === 'reversed-range') candidate.answerCitations[0]!.startLine = 3
    if (mode === 'outside-answer') candidate.answerCitations[0]!.endLine = 999
    if (mode === 'blank-note') candidate.citations = [{ startLine: 2, endLine: 2, excerpt: '' }]
    if (mode === 'no-note') candidate.citations = []
    if (mode === 'no-answer') candidate.answerCitations = []
    const verify = vi.fn().mockResolvedValue({ candidate, usage })
    await expect(verifyFollowUpAnswer({ verify }, fixture(), options())).rejects.toMatchObject({
      code: 'INVALID_ANSWER_CITATION',
      usage,
    })
    expect(verify).toHaveBeenCalledOnce()
  })

  it('rejects fabricated answer quotes even when the LangChain adapter accepts the JSON structure', async () => {
    const candidate = structuredClone(answerVerificationCandidate)
    candidate.answerCitations[0]!.excerpt = '模型补写的解释'
    const invoke = vi.fn().mockResolvedValue({ parsed: candidate, raw: {} })
    const verifier = new LangChainAnswerVerifier(
      { apiKey: 'fixture' },
      () =>
        ({
          withStructuredOutput: () => ({ invoke }),
        }) as unknown as ReturnType<LangChainChatModelFactory>,
    )
    await expect(verifyFollowUpAnswer(verifier, fixture(), options())).rejects.toMatchObject({
      code: 'INVALID_ANSWER_CITATION',
    })
    expect(invoke).toHaveBeenCalledOnce()
  })

  it.each(['source-id', 'outcome', 'suggestions'])(
    'rejects invalid %s from a replacement port',
    async (field) => {
      const candidate = structuredClone(answerVerificationCandidate)
      if (field === 'source-id') Object.assign(candidate, { answerSubmissionId: randomUUID() })
      if (field === 'outcome') Object.assign(candidate, { outcome: 'SUCCEEDED' })
      if (field === 'suggestions') candidate.outcome = 'FAILED'
      const verify = vi.fn().mockResolvedValue({ candidate, usage })
      await expect(verifyFollowUpAnswer({ verify }, fixture(), options())).rejects.toMatchObject({
        code: 'INVALID_ANSWER_OUTPUT',
        usage,
      })
    },
  )

  it('preserves CRLF/blank-line positions and does not rebind an in-flight result', async () => {
    const input = fixture()
    input.answer.content = '先执行微任务。\r\n\r\n因为要清空微任务队列。'
    const before = structuredClone(input)
    const candidate = {
      ...answerVerificationCandidate,
      answerCitations: [
        { startLine: 1, endLine: 3, excerpt: input.answer.content.replaceAll('\r\n', '\n') },
      ],
    }
    const verify = vi.fn().mockImplementation(async (request: AnswerVerificationRequest) => {
      input.answer.id = randomUUID()
      input.note.source.commitSha = 'c'.repeat(40)
      request.answer.content = '后续的回答'
      request.question.id = randomUUID()
      return { candidate, usage }
    })
    const { result } = await verifyFollowUpAnswer({ verify }, input, options())
    expect(result.answerSubmissionId).toBe(before.answer.id)
    expect(result.questionId).toBe(before.question.id)
    expect(result.citations[0]?.commitSha).toBe(before.note.source.commitSha)
    expect(result.answerCitations[0]?.excerpt).toBe(candidate.answerCitations[0]!.excerpt)
  })

  it('does not retry upstream failures or synthesize a passing answer', async () => {
    const error = new NoteVerificationModelError('MODEL_UPSTREAM_ERROR', { retryable: true })
    const verify = vi.fn().mockRejectedValue(error)
    await expect(verifyFollowUpAnswer({ verify }, fixture(), options())).rejects.toBe(error)
    expect(verify).toHaveBeenCalledOnce()
  })

  it('rejects cancelled calls and late responses, retaining known usage', async () => {
    const controller = new AbortController()
    const verify = vi.fn().mockImplementation(async () => {
      controller.abort()
      return { candidate: answerVerificationCandidate, usage }
    })
    const inputOptions = { ...options(), signal: controller.signal }
    await expect(verifyFollowUpAnswer({ verify }, fixture(), inputOptions)).rejects.toMatchObject({
      code: 'MODEL_ABORTED',
      usage,
    })
    verify.mockClear()
    await expect(verifyFollowUpAnswer({ verify }, fixture(), inputOptions)).rejects.toMatchObject({
      code: 'MODEL_ABORTED',
    })
    expect(verify).not.toHaveBeenCalled()
  })
})
