import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { LangChainNoteVerifier, type LangChainChatModelFactory } from '@knowledgeops/agent-core'
import {
  noteVerificationCandidate,
  noteVerificationRequest,
} from '../../../packages/agent-core/test/fixtures/note-verification.js'
import { parseNoteEvidence } from '../src/verification/parse-note-evidence.js'
import { verifyNoteSemantics } from '../src/verification/verify-note-semantics.js'
import { noteEvidence } from './fixtures/note-evidence.js'

function fixture() {
  return {
    runId: noteVerificationRequest.runId,
    model: noteVerificationRequest.model,
    task: noteVerificationRequest.task,
    note: parseNoteEvidence(noteEvidence(noteVerificationRequest.note.lines.join('\n'))),
    criteria: [
      { id: randomUUID(), type: 'SECTION_PRESENT' as const, description: '有事件循环标题' },
      ...noteVerificationRequest.criteria,
      { id: randomUUID(), type: 'FOLLOW_UP_ANSWER' as const, description: '回答追问' },
    ],
  }
}
const options = () => ({ signal: new AbortController().signal, maxOutputTokens: 1_024 })

describe('one semantic verification call', () => {
  it('sends only semantic criteria and returns source-bound results plus usage', async () => {
    const input = fixture()
    const before = structuredClone(input)
    const usage = { inputTokens: 20, outputTokens: 30, totalTokens: 50 }
    const verify = vi.fn().mockResolvedValue({ candidate: noteVerificationCandidate, usage })
    const response = await verifyNoteSemantics({ verify }, input, options())
    expect(verify).toHaveBeenCalledOnce()
    expect(verify.mock.calls[0]?.[0]).toMatchObject({
      criteria: noteVerificationRequest.criteria,
      note: { ...input.note.source, lines: input.note.lines },
    })
    expect(response.usage).toEqual(usage)
    expect(response.results[0]?.citations[0]).toMatchObject(input.note.source)
    expect(input).toEqual(before)
  })

  it('skips the model when only deterministic criteria remain', async () => {
    const input = fixture()
    input.criteria = [input.criteria[0]!]
    const verify = vi.fn()
    expect(await verifyNoteSemantics({ verify }, input, options())).toEqual({
      results: [],
      usage: null,
    })
    expect(verify).not.toHaveBeenCalled()
  })

  it('rejects a forged quote after the adapter has accepted its valid structure', async () => {
    const candidate = structuredClone(noteVerificationCandidate)
    candidate.results[0]!.citations[0]!.excerpt = '伪造引文'
    const invoke = vi.fn().mockResolvedValue({ parsed: candidate, raw: {} })
    const port = new LangChainNoteVerifier(
      { apiKey: 'fixture' },
      () =>
        ({
          withStructuredOutput: () => ({ invoke }),
        }) as unknown as ReturnType<LangChainChatModelFactory>,
    )
    await expect(verifyNoteSemantics(port, fixture(), options())).rejects.toMatchObject({
      code: 'INVALID_MODEL_CITATION',
    })
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('does not retry or replace model failure with a fabricated pass', async () => {
    const error = new Error('model failed')
    const verify = vi.fn().mockRejectedValue(error)
    await expect(verifyNoteSemantics({ verify }, fixture(), options())).rejects.toBe(error)
    expect(verify).toHaveBeenCalledOnce()
  })

  it('rejects late port results even if a replacement port ignores cancellation', async () => {
    const controller = new AbortController()
    const verify = vi.fn().mockImplementation(async () => {
      controller.abort()
      return { candidate: noteVerificationCandidate, usage: null }
    })
    await expect(
      verifyNoteSemantics({ verify }, fixture(), { ...options(), signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'MODEL_ABORTED' })
  })
})
