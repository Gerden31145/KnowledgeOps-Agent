import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  LangChainFollowUpGenerator,
  NoteVerificationModelError,
  type LangChainChatModelFactory,
} from '@knowledgeops/agent-core'
import {
  followUpCandidate,
  followUpGenerationRequest,
} from '../../../packages/agent-core/test/fixtures/follow-up-question.js'
import { generateFollowUpQuestion } from '../src/verification/generate-follow-up-question.js'
import { parseNoteEvidence } from '../src/verification/parse-note-evidence.js'
import { noteEvidence } from './fixtures/note-evidence.js'

const usage = { inputTokens: 20, outputTokens: 30, totalTokens: 50 }
const options = () => ({ signal: new AbortController().signal, maxOutputTokens: 1_024 })
function fixture() {
  const request = structuredClone(followUpGenerationRequest)
  return {
    source: {
      taskId: request.task.id,
      noteRunId: request.runId,
      submissionId: randomUUID(),
      reportId: randomUUID(),
    },
    model: request.model,
    task: request.task,
    criterion: request.criterion,
    note: parseNoteEvidence(noteEvidence(request.note.lines.join('\n'))),
  }
}

describe('R10: one follow-up generation call', () => {
  it('returns a source-bound question and rubric plus usage, with no answer result', async () => {
    const input = fixture()
    const before = structuredClone(input)
    const generate = vi.fn().mockResolvedValue({ candidate: followUpCandidate, usage })
    const result = await generateFollowUpQuestion({ generate }, input, options())
    expect(result.usage).toEqual(usage)
    expect(result.question).toMatchObject({
      question: followUpCandidate.question,
      rubric: followUpCandidate.rubric,
      criterionId: input.criterion.id,
      source: { ...input.source, ...input.note.source },
    })
    expect(result.question.citations[0]).toMatchObject(input.note.source)
    expect(result.question).not.toHaveProperty('outcome')
    expect(generate).toHaveBeenCalledOnce()
    expect(generate.mock.calls[0]![0]).toEqual({
      runId: input.source.noteRunId,
      model: input.model,
      task: input.task,
      criterion: input.criterion,
      note: { ...input.note.source, lines: input.note.lines },
    })
    expect(input).toEqual(before)
  })

  it('rejects a forged quote even after the LangChain adapter accepts its structure, retaining usage', async () => {
    const candidate = structuredClone(followUpCandidate)
    candidate.citations[0]!.excerpt = '伪造的原文'
    const invoke = vi.fn().mockResolvedValue({
      parsed: candidate,
      raw: { usage_metadata: { input_tokens: 20, output_tokens: 30, total_tokens: 50 } },
    })
    const port = new LangChainFollowUpGenerator(
      { apiKey: 'fixture' },
      () =>
        ({
          withStructuredOutput: () => ({ invoke }),
        }) as unknown as ReturnType<LangChainChatModelFactory>,
    )
    await expect(generateFollowUpQuestion(port, fixture(), options())).rejects.toMatchObject({
      code: 'INVALID_FOLLOW_UP_CITATION',
      usage,
    })
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('does not allow a replacement port to bypass the output schema or lose failed-call usage', async () => {
    const generate = vi
      .fn()
      .mockResolvedValue({ candidate: { ...followUpCandidate, taskId: randomUUID() }, usage })
    await expect(
      generateFollowUpQuestion({ generate }, fixture(), options()),
    ).rejects.toMatchObject({
      code: 'INVALID_FOLLOW_UP_OUTPUT',
      usage,
    })
    expect(generate).toHaveBeenCalledOnce()
  })

  it.each(['missing-report', 'different-task', 'empty-criterion'])(
    'rejects %s context before spending a model call',
    async (mode) => {
      const input = fixture()
      if (mode === 'missing-report') Object.assign(input.source, { reportId: '' })
      if (mode === 'different-task') input.task.id = randomUUID()
      if (mode === 'empty-criterion') input.criterion.description = ''
      const generate = vi.fn()
      await expect(generateFollowUpQuestion({ generate }, input, options())).rejects.toMatchObject({
        code: mode === 'empty-criterion' ? 'MODEL_INPUT_INVALID' : 'INVALID_FOLLOW_UP_CONTEXT',
      })
      expect(generate).not.toHaveBeenCalled()
    },
  )

  it('does not rebind an in-flight question when the caller mutates its input', async () => {
    const input = fixture()
    const before = structuredClone(input)
    const generate = vi.fn().mockImplementation(async () => {
      input.source.reportId = randomUUID()
      input.note.source.commitSha = 'c'.repeat(40)
      input.note.lines[2] = '新提交的正文'
      return { candidate: followUpCandidate, usage }
    })
    const result = await generateFollowUpQuestion({ generate }, input, options())
    expect(result.question.source).toEqual({ ...before.source, ...before.note.source })
    expect(result.question.citations[0]?.excerpt).toBe(before.note.lines[2])
  })

  it('keeps unknown usage separate from a valid question', async () => {
    const generate = vi.fn().mockResolvedValue({ candidate: followUpCandidate, usage: null })
    const result = await generateFollowUpQuestion({ generate }, fixture(), options())
    expect(result.usage).toBeNull()
    expect(result.question.question).toBe(followUpCandidate.question)
    expect(generate).toHaveBeenCalledOnce()
  })

  it('does not retry an upstream error or generate a fallback question', async () => {
    const error = new NoteVerificationModelError('MODEL_UPSTREAM_ERROR', { retryable: true })
    const generate = vi.fn().mockRejectedValue(error)
    await expect(generateFollowUpQuestion({ generate }, fixture(), options())).rejects.toBe(error)
    expect(generate).toHaveBeenCalledOnce()
  })

  it('rejects late responses and pre-cancelled calls even when a replacement port ignores the signal', async () => {
    const controller = new AbortController()
    const generate = vi.fn().mockImplementation(async () => {
      controller.abort()
      return { candidate: followUpCandidate, usage }
    })
    await expect(
      generateFollowUpQuestion({ generate }, fixture(), {
        ...options(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'MODEL_ABORTED', usage })
    generate.mockClear()
    await expect(
      generateFollowUpQuestion({ generate }, fixture(), {
        ...options(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'MODEL_ABORTED' })
    expect(generate).not.toHaveBeenCalled()
  })
})
