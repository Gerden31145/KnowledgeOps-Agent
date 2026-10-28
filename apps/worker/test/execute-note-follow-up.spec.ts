import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { NoteVerificationModelError } from '@knowledgeops/agent-core'
import {
  noteVerificationCandidate,
  noteVerificationRequest,
} from '../../../packages/agent-core/test/fixtures/note-verification.js'
import {
  followUpCandidate,
  followUpGenerationRequest,
} from '../../../packages/agent-core/test/fixtures/follow-up-question.js'
import {
  executeNoteVerification,
  type NoteVerificationBudget,
  type NoteVerificationInput,
} from '../src/verification/execute-note-verification.js'
import { parseNoteEvidence } from '../src/verification/parse-note-evidence.js'
import { noteEvidence } from './fixtures/note-evidence.js'

const usage = { inputTokens: 20, outputTokens: 30, totalTokens: 50 }
function fixture() {
  const input: NoteVerificationInput = {
    ...structuredClone(noteVerificationRequest),
    note: parseNoteEvidence(noteEvidence(noteVerificationRequest.note.lines.join('\n'))),
    followUp: {
      source: {
        taskId: noteVerificationRequest.task.id,
        noteRunId: noteVerificationRequest.runId,
        submissionId: randomUUID(),
        reportId: randomUUID(),
      },
      model: followUpGenerationRequest.model,
      criterion: followUpGenerationRequest.criterion,
      deterministicPassed: true,
      requiredSemanticIds: [noteVerificationRequest.criteria[0]!.id],
    },
  }
  const budget: NoteVerificationBudget = {
    maxCalls: 2,
    maxTotalTokens: 2_000,
    maxCostMicrounits: 100_000,
    deadlineAt: new Date(Date.now() + 30_000),
    pricing: {
      currency: 'CNY',
      inputMicrounitsPerMillionTokens: 8_000_000,
      outputMicrounitsPerMillionTokens: 28_000_000,
    },
  }
  const controller = new AbortController()
  const options = { signal: controller.signal, maxOutputTokens: 1_024 }
  const verify = vi
    .fn()
    .mockResolvedValue({ candidate: structuredClone(noteVerificationCandidate), usage })
  const generate = vi
    .fn()
    .mockResolvedValue({ candidate: structuredClone(followUpCandidate), usage })
  const journal = {
    reserve: vi.fn().mockResolvedValue(undefined),
    settle: vi.fn().mockResolvedValue(undefined),
  }
  return {
    input,
    budget,
    options,
    controller,
    verify,
    generate,
    journal,
    execute: () =>
      executeNoteVerification({ verify }, input, options, budget, journal, { generate }),
  }
}

describe('R10: note and follow-up share one execution budget', () => {
  it('uses two steps, one global attempt sequence, one signal and combined usage', async () => {
    const f = fixture()
    f.budget.maxTotalTokens = 1_050
    const result = await f.execute()
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      followUp: { status: 'READY' },
      accounting: {
        knownTotalTokens: 100,
        knownCostMicrounits: 2_000,
        usageComplete: true,
        warnings: [],
      },
    })
    expect(
      result.accounting.attempts.map(({ stepId, attempt, kind }) => ({ stepId, attempt, kind })),
    ).toEqual([
      { stepId: 'NOTE_SEMANTICS', attempt: 1, kind: 'INITIAL' },
      { stepId: 'GENERATE_FOLLOW_UP', attempt: 2, kind: 'INITIAL' },
    ])
    expect(f.verify).toHaveBeenCalledOnce()
    expect(f.generate).toHaveBeenCalledOnce()
    expect(f.generate.mock.calls[0]![1].maxOutputTokens).toBe(1_000)
    expect(f.generate.mock.calls[0]![1].signal).toBe(f.verify.mock.calls[0]![1].signal)
    expect(f.journal.reserve).toHaveBeenCalledTimes(2)
    expect(f.journal.settle).toHaveBeenCalledTimes(2)
  })

  it('does not give follow-up a new allowance after a semantic repair used both attempts', async () => {
    const f = fixture()
    f.verify.mockRejectedValueOnce(
      new NoteVerificationModelError('MODEL_OUTPUT_INVALID', { usage }),
    )
    const result = await f.execute()
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      results: [{ outcome: 'PASSED' }],
      followUp: { status: 'FAILED', code: 'MODEL_CALL_LIMIT_EXCEEDED' },
    })
    expect(f.verify).toHaveBeenCalledTimes(2)
    expect(f.generate).not.toHaveBeenCalled()
  })

  it.each(['deterministic', 'FAILED', 'INSUFFICIENT_EVIDENCE'] as const)(
    'does not ask a question when a required note check is %s',
    async (mode) => {
      const f = fixture()
      if (mode === 'deterministic') f.input.followUp!.deterministicPassed = false
      else {
        const candidate = structuredClone(noteVerificationCandidate)
        candidate.results[0]!.outcome = mode
        f.verify.mockResolvedValue({ candidate, usage })
      }
      expect(await f.execute()).toMatchObject({
        status: 'SUCCEEDED',
        followUp: { status: 'SKIPPED', reason: 'NOTE_CRITERIA_NOT_PASSED' },
      })
      expect(f.generate).not.toHaveBeenCalled()
    },
  )

  it('keeps an optional failed criterion as advice without blocking the question', async () => {
    const f = fixture()
    f.input.followUp!.requiredSemanticIds = []
    const candidate = structuredClone(noteVerificationCandidate)
    candidate.results[0]!.outcome = 'FAILED'
    f.verify.mockResolvedValue({ candidate, usage })
    expect(await f.execute()).toMatchObject({ status: 'SUCCEEDED', followUp: { status: 'READY' } })
    expect(f.generate).toHaveBeenCalledOnce()
  })

  it.each(['unknown', 'exceeded'])(
    'keeps valid note results but blocks another paid call when usage is %s',
    async (mode) => {
      const f = fixture()
      f.verify.mockResolvedValue({
        candidate: noteVerificationCandidate,
        usage:
          mode === 'unknown' ? null : { inputTokens: 2_000, outputTokens: 1, totalTokens: 2_001 },
      })
      expect(await f.execute()).toMatchObject({
        status: 'SUCCEEDED',
        results: [{ outcome: 'PASSED' }],
        followUp: {
          status: 'FAILED',
          code: mode === 'unknown' ? 'MODEL_USAGE_UNKNOWN' : 'MODEL_BUDGET_EXCEEDED',
        },
      })
      expect(f.generate).not.toHaveBeenCalled()
    },
  )

  it('rejects a forged question but keeps both calls in the ledger and the valid note result', async () => {
    const f = fixture()
    const candidate = structuredClone(followUpCandidate)
    candidate.citations[0]!.excerpt = 'forged'
    f.generate.mockResolvedValue({ candidate, usage })
    const result = await f.execute()
    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      results: [{ outcome: 'PASSED' }],
      followUp: { status: 'FAILED', code: 'MODEL_CALL_LIMIT_EXCEEDED' },
      accounting: { knownTotalTokens: 100 },
    })
    expect(result.accounting.attempts[1]?.errorCode).toBe('INVALID_FOLLOW_UP_CITATION')
    expect(f.generate).toHaveBeenCalledOnce()
  })

  it.each(['unknown', 'exceeded'])(
    'retains a valid generated question with accounting warnings when its usage is %s',
    async (mode) => {
      const f = fixture()
      f.generate.mockResolvedValue({
        candidate: followUpCandidate,
        usage:
          mode === 'unknown' ? null : { inputTokens: 2_000, outputTokens: 1, totalTokens: 2_001 },
      })
      const result = await f.execute()
      expect(result).toMatchObject({ status: 'SUCCEEDED', followUp: { status: 'READY' } })
      expect(result.accounting.warnings).toContain(
        mode === 'unknown' ? 'MODEL_USAGE_UNKNOWN' : 'MODEL_BUDGET_EXCEEDED',
      )
      expect(f.generate).toHaveBeenCalledOnce()
    },
  )

  it('can generate after deterministic-only checks without spending a semantic call', async () => {
    const f = fixture()
    f.input.criteria = []
    f.input.followUp!.requiredSemanticIds = []
    expect(await f.execute()).toMatchObject({
      status: 'SUCCEEDED',
      results: [],
      followUp: { status: 'READY' },
    })
    expect(f.verify).not.toHaveBeenCalled()
    expect(f.generate).toHaveBeenCalledOnce()
  })

  it('does not call the model when reserving the second attempt fails', async () => {
    const f = fixture()
    const outage = new Error('fixture-database-unavailable')
    f.journal.reserve.mockResolvedValueOnce(undefined).mockRejectedValueOnce(outage)
    await expect(f.execute()).rejects.toBe(outage)
    expect(f.verify).toHaveBeenCalledOnce()
    expect(f.generate).not.toHaveBeenCalled()
  })

  it('rejects success when cancelled during question generation', async () => {
    const f = fixture()
    f.generate.mockImplementation(async () => {
      f.controller.abort()
      return { candidate: followUpCandidate, usage }
    })
    expect(await f.execute()).toMatchObject({ status: 'FAILED', code: 'MODEL_ABORTED' })
  })
})
