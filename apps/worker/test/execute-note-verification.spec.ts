import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LangChainNoteVerifier,
  NoteVerificationModelError,
  type LangChainChatModelFactory,
} from '@knowledgeops/agent-core'
import {
  noteVerificationCandidate,
  noteVerificationRequest,
} from '../../../packages/agent-core/test/fixtures/note-verification.js'
import {
  executeNoteVerification,
  type NoteVerificationBudget,
} from '../src/verification/execute-note-verification.js'
import { parseNoteEvidence } from '../src/verification/parse-note-evidence.js'
import { noteEvidence } from './fixtures/note-evidence.js'

const usage = { inputTokens: 120, outputTokens: 80, totalTokens: 200 }
const valid = () => ({ candidate: structuredClone(noteVerificationCandidate), usage })
const input = () => ({
  ...noteVerificationRequest,
  note: parseNoteEvidence(noteEvidence(noteVerificationRequest.note.lines.join('\n'))),
})
const options = () => ({ signal: new AbortController().signal, maxOutputTokens: 1_024 })
const budget = (): NoteVerificationBudget => ({
  maxCalls: 2,
  maxTotalTokens: 2_000,
  maxCostMicrounits: 10_000,
  deadlineAt: new Date(Date.now() + 5_000),
  // 合成单价，不代表实际供应商价格。每次 120*1 + 80*2 = 280 微单位。
  pricing: {
    currency: 'CNY',
    inputMicrounitsPerMillionTokens: 1_000_000,
    outputMicrounitsPerMillionTokens: 2_000_000,
  },
})
const forged = () => {
  const response = valid()
  response.candidate.results[0]!.citations[0]!.excerpt = 'not in this note'
  return response
}
afterEach(() => vi.useRealTimers())

describe('bounded note verification execution', () => {
  it('rounds estimated cost upward to a micro-unit instead of recording a small charge as free', async () => {
    const verify = vi.fn().mockResolvedValue(valid())
    const limits = budget()
    limits.pricing = {
      currency: 'CNY',
      inputMicrounitsPerMillionTokens: 1,
      outputMicrounitsPerMillionTokens: 1,
    }
    expect(await executeNoteVerification({ verify }, input(), options(), limits)).toMatchObject({
      status: 'SUCCEEDED',
      accounting: { knownCostMicrounits: 1 },
    })
  })

  it('returns real validated results and accounts for a successful call', async () => {
    const verify = vi.fn().mockResolvedValue(valid())
    const result = await executeNoteVerification({ verify }, input(), options(), budget())
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      accounting: {
        knownTotalTokens: 200,
        knownCostMicrounits: 280,
        usageComplete: true,
        warnings: [],
        attempts: [
          {
            runId: noteVerificationRequest.runId,
            stepId: 'NOTE_SEMANTICS',
            attempt: 1,
            kind: 'INITIAL',
            errorCode: null,
          },
        ],
      },
    })
    if (result.status === 'SUCCEEDED')
      expect(result.results[0]!.citations[0]).toMatchObject({ commitSha: 'b'.repeat(40) })
    expect(verify).toHaveBeenCalledOnce()
  })

  it('charges the rejected quote, then repairs once against the same fixed evidence', async () => {
    const verify = vi.fn().mockResolvedValueOnce(forged()).mockResolvedValueOnce(valid())
    const result = await executeNoteVerification({ verify }, input(), options(), budget())
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      accounting: {
        knownTotalTokens: 400,
        knownCostMicrounits: 560,
        attempts: [
          { attempt: 1, errorCode: 'INVALID_MODEL_CITATION', usage },
          { attempt: 2, kind: 'REPAIR', errorCode: null, usage },
        ],
      },
    })
    expect(verify.mock.calls[1]![0]).toEqual(verify.mock.calls[0]![0])
    expect(verify.mock.calls[1]![1]).toMatchObject({ repairReason: 'INVALID_MODEL_CITATION' })
    expect(verify.mock.calls[1]![1].signal).toBe(verify.mock.calls[0]![1].signal)
  })

  it('charges an adapter schema failure and includes a bounded repair instruction', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        parsed: null,
        raw: { usage_metadata: { input_tokens: 120, output_tokens: 80, total_tokens: 200 } },
      })
      .mockResolvedValueOnce({
        parsed: noteVerificationCandidate,
        raw: { usage_metadata: { input_tokens: 120, output_tokens: 80, total_tokens: 200 } },
      })
    const port = new LangChainNoteVerifier(
      { apiKey: 'synthetic' },
      () =>
        ({
          withStructuredOutput: () => ({ invoke }),
        }) as unknown as ReturnType<LangChainChatModelFactory>,
    )
    const result = await executeNoteVerification(port, input(), options(), budget())
    expect(result).toMatchObject({ status: 'SUCCEEDED', accounting: { knownTotalTokens: 400 } })
    expect(invoke.mock.calls[1]![0][0].content).toContain(
      'previous response had an invalid JSON structure',
    )
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('never returns a partial report or calls a third time when both candidates are invalid', async () => {
    const verify = vi.fn().mockResolvedValue(forged())
    const result = await executeNoteVerification({ verify }, input(), options(), budget())
    expect(result).toMatchObject({
      status: 'FAILED',
      code: 'MODEL_CALL_LIMIT_EXCEEDED',
      accounting: { knownTotalTokens: 400 },
    })
    expect(result).not.toHaveProperty('results')
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it.each(['tokens', 'cost'] as const)(
    'stops before repair when %s were fully spent',
    async (limit) => {
      const limits = budget()
      if (limit === 'tokens') limits.maxTotalTokens = 200
      else limits.maxCostMicrounits = 280
      const verify = vi.fn().mockResolvedValue(forged())
      expect(await executeNoteVerification({ verify }, input(), options(), limits)).toMatchObject({
        status: 'FAILED',
        code: 'MODEL_BUDGET_EXCEEDED',
        accounting: { knownTotalTokens: 200 },
      })
      expect(verify).toHaveBeenCalledOnce()
    },
  )

  it('caps the next output allowance by remaining tokens', async () => {
    const verify = vi.fn().mockResolvedValueOnce(forged()).mockResolvedValueOnce(valid())
    const result = await executeNoteVerification({ verify }, input(), options(), {
      ...budget(),
      maxTotalTokens: 400,
    })
    expect(result.status).toBe('SUCCEEDED')
    expect(verify.mock.calls[0]![1].maxOutputTokens).toBe(400)
    expect(verify.mock.calls[1]![1].maxOutputTokens).toBe(200)
  })

  it.each(['tokens', 'cost'] as const)(
    'keeps a valid result with a warning if reported %s exceed the limit, without another call',
    async (limit) => {
      const limits = budget()
      if (limit === 'tokens') limits.maxTotalTokens = 199
      else limits.maxCostMicrounits = 279
      const verify = vi.fn().mockResolvedValue(valid())
      expect(await executeNoteVerification({ verify }, input(), options(), limits)).toMatchObject({
        status: 'SUCCEEDED',
        results: [
          {
            criterionId: noteVerificationRequest.criteria[0]!.id,
            citations: [{ ...input().note.source }],
          },
        ],
        accounting: {
          knownTotalTokens: 200,
          knownCostMicrounits: 280,
          usageComplete: true,
          warnings: ['MODEL_BUDGET_EXCEEDED'],
        },
      })
      expect(verify).toHaveBeenCalledOnce()
    },
  )

  it.each([null, { inputTokens: 1, outputTokens: 1, totalTokens: 0 }])(
    'does not treat missing/invalid usage as free or retry it',
    async (reported) => {
      const verify = vi.fn().mockResolvedValue({ ...forged(), usage: reported })
      expect(await executeNoteVerification({ verify }, input(), options(), budget())).toMatchObject(
        {
          status: 'FAILED',
          code: 'MODEL_USAGE_UNKNOWN',
          accounting: { usageComplete: false, attempts: [{ usage: null, costMicrounits: null }] },
        },
      )
      expect(verify).toHaveBeenCalledOnce()
    },
  )

  it.each([null, { inputTokens: 1, outputTokens: 1, totalTokens: 0 }])(
    'keeps a valid candidate with unknown/invalid usage %j and does not retry',
    async (reported) => {
      const verify = vi.fn().mockResolvedValue({ ...valid(), usage: reported })
      expect(await executeNoteVerification({ verify }, input(), options(), budget())).toMatchObject(
        {
          status: 'SUCCEEDED',
          results: [{ criterionId: noteVerificationRequest.criteria[0]!.id }],
          accounting: {
            usageComplete: false,
            warnings: ['MODEL_USAGE_UNKNOWN'],
            attempts: [{ usage: null, costMicrounits: null }],
          },
        },
      )
      expect(verify).toHaveBeenCalledOnce()
    },
  )

  it('keeps the second valid result and the first failed call accounting when repair usage is missing', async () => {
    const verify = vi
      .fn()
      .mockResolvedValueOnce(forged())
      .mockResolvedValueOnce({ ...valid(), usage: null })
    expect(await executeNoteVerification({ verify }, input(), options(), budget())).toMatchObject({
      status: 'SUCCEEDED',
      accounting: {
        knownTotalTokens: 200,
        knownCostMicrounits: 280,
        usageComplete: false,
        warnings: ['MODEL_USAGE_UNKNOWN'],
        attempts: [
          { usage, errorCode: 'INVALID_MODEL_CITATION' },
          { usage: null, errorCode: null },
        ],
      },
    })
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('does not turn a legitimate FAILED criterion into PASSED when preserving results', async () => {
    const response = valid()
    response.candidate.results[0]!.outcome = 'FAILED'
    const verify = vi.fn().mockResolvedValue({ ...response, usage: null })
    expect(await executeNoteVerification({ verify }, input(), options(), budget())).toMatchObject({
      status: 'SUCCEEDED',
      results: [{ outcome: 'FAILED' }],
      accounting: { warnings: ['MODEL_USAGE_UNKNOWN'] },
    })
    expect(verify).toHaveBeenCalledOnce()
  })

  it.each([true, false])(
    'handles accounting overflow without losing valid results or repairing invalid ones (valid=%s)',
    async (isValid) => {
      const response = isValid ? valid() : forged()
      const verify = vi.fn().mockResolvedValue({
        ...response,
        usage: { inputTokens: 2_000_000, outputTokens: 0, totalTokens: 2_000_000 },
      })
      const limits = budget()
      limits.pricing.inputMicrounitsPerMillionTokens = Number.MAX_SAFE_INTEGER
      const result = await executeNoteVerification({ verify }, input(), options(), limits)
      expect(result).toMatchObject({
        status: isValid ? 'SUCCEEDED' : 'FAILED',
        accounting: { usageComplete: false, warnings: ['MODEL_ACCOUNTING_INVALID'] },
      })
      if (!isValid) {
        expect(result).toMatchObject({ code: 'MODEL_ACCOUNTING_INVALID' })
        expect(result).not.toHaveProperty('results')
      }
      expect(verify).toHaveBeenCalledOnce()
    },
  )

  it('transient retry and repair share the same two-call limit', async () => {
    vi.useFakeTimers()
    const verify = vi
      .fn()
      .mockRejectedValueOnce(
        new NoteVerificationModelError('MODEL_UPSTREAM_ERROR', { usage, retryable: true }),
      )
      .mockResolvedValue(forged())
    const pending = executeNoteVerification({ verify }, input(), options(), budget())
    await vi.advanceTimersByTimeAsync(250)
    expect(await pending).toMatchObject({
      status: 'FAILED',
      code: 'MODEL_CALL_LIMIT_EXCEEDED',
      accounting: { attempts: [{ kind: 'INITIAL' }, { kind: 'RETRY' }] },
    })
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it('stops on transient failures without reliable usage instead of silently retrying', async () => {
    const verify = vi
      .fn()
      .mockRejectedValue(
        new NoteVerificationModelError('MODEL_UPSTREAM_ERROR', { retryable: true }),
      )
    expect(await executeNoteVerification({ verify }, input(), options(), budget())).toMatchObject({
      status: 'FAILED',
      code: 'MODEL_USAGE_UNKNOWN',
      accounting: { attempts: [{ errorCode: 'MODEL_UPSTREAM_ERROR' }] },
    })
    expect(verify).toHaveBeenCalledOnce()
  })

  it.each(['MODEL_CONFIGURATION_ERROR', 'MODEL_INPUT_INVALID'] as const)(
    'preserves permanent %s without retry',
    async (code) => {
      const verify = vi.fn().mockRejectedValue(new NoteVerificationModelError(code))
      expect(await executeNoteVerification({ verify }, input(), options(), budget())).toMatchObject(
        { status: 'FAILED', code },
      )
      expect(verify).toHaveBeenCalledOnce()
    },
  )

  it('returns at the deadline even if the port ignores abort, and never publishes its late success', async () => {
    vi.useFakeTimers()
    let finish!: (value: ReturnType<typeof valid>) => void
    const verify = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const pending = executeNoteVerification({ verify }, input(), options(), {
      ...budget(),
      deadlineAt: new Date(Date.now() + 100),
    })
    await vi.advanceTimersByTimeAsync(100)
    const result = await pending
    expect(result).toMatchObject({
      status: 'FAILED',
      code: 'RUN_DEADLINE_EXCEEDED',
      accounting: { usageComplete: false },
    })
    expect(verify.mock.calls[0]![1].signal.aborted).toBe(true)
    finish(valid())
    await Promise.resolve()
    expect(result.status).toBe('FAILED')
    expect(result).not.toHaveProperty('results')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not reset the deadline while backing off', async () => {
    vi.useFakeTimers()
    const verify = vi
      .fn()
      .mockRejectedValue(
        new NoteVerificationModelError('MODEL_UPSTREAM_ERROR', { usage, retryable: true }),
      )
    const pending = executeNoteVerification({ verify }, input(), options(), {
      ...budget(),
      deadlineAt: new Date(Date.now() + 100),
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toMatchObject({ status: 'FAILED', code: 'RUN_DEADLINE_EXCEEDED' })
    expect(verify).toHaveBeenCalledOnce()
  })

  it('handles external cancellation and clears its deadline timer', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const verify = vi.fn().mockImplementation(() => new Promise(() => {}))
    const pending = executeNoteVerification(
      { verify },
      input(),
      { ...options(), signal: controller.signal },
      budget(),
    )
    controller.abort()
    expect(await pending).toMatchObject({ status: 'FAILED', code: 'MODEL_ABORTED' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['expired', 'cancelled', 'bad-budget', 'bad-price'] as const)(
    'rejects %s before any model call',
    async (scenario) => {
      const verify = vi.fn()
      const limits = budget()
      const opts = options()
      if (scenario === 'expired') limits.deadlineAt = new Date(0)
      if (scenario === 'cancelled') opts.signal = AbortSignal.abort()
      if (scenario === 'bad-budget') limits.maxCalls = 3
      if (scenario === 'bad-price') limits.pricing.inputMicrounitsPerMillionTokens = -1
      expect((await executeNoteVerification({ verify }, input(), opts, limits)).status).toBe(
        'FAILED',
      )
      expect(verify).not.toHaveBeenCalled()
    },
  )

  it('does not spend a model attempt for a task without semantic criteria', async () => {
    const verify = vi.fn()
    expect(
      await executeNoteVerification({ verify }, { ...input(), criteria: [] }, options(), budget()),
    ).toMatchObject({
      status: 'SUCCEEDED',
      results: [],
      accounting: {
        attempts: [],
        knownTotalTokens: 0,
        knownCostMicrounits: 0,
        usageComplete: true,
      },
    })
    expect(verify).not.toHaveBeenCalled()
  })
})
