import { describe, expect, it, vi } from 'vitest'
import {
  NoteVerificationModelError,
  type NoteVerificationPort,
  type AnswerVerificationPort,
} from '@knowledgeops/agent-core'
import { cases } from '../scripts/r11-evaluation/cases.js'
import {
  checkCases,
  evaluateCase,
  prepareCase,
  summarize,
} from '../scripts/r11-evaluation/evaluate.js'

const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
const noAnswer: AnswerVerificationPort = { verify: vi.fn() }
const success: NoteVerificationPort['verify'] = async (request) => ({
  usage,
  candidate: {
    results: request.criteria.map((c) => ({
      criterionId: c.id,
      outcome: 'PASSED',
      rationale: '合成返回',
      suggestions: [],
      confidence: 0.8,
      citations: [{ startLine: 3, endLine: 4, excerpt: request.note.lines.slice(2, 4).join('\n') }],
    })),
  },
})

describe('R11 fixed evaluation measurements (no paid calls)', () => {
  it('has 15 prelabelled samples with valid evidence ranges and 16 criterion expectations', () => {
    expect(() => checkCases()).not.toThrow()
    expect(cases).toHaveLength(15)
    expect(cases.reduce((sum, c) => sum + c.expected.length, 0)).toBe(16)
    expect(cases.filter((c) => c.answer !== undefined)).toHaveLength(5)
  })
  it('does not send gold labels, sample IDs or scoring reasons to the model', async () => {
    const verify = vi.fn<NoteVerificationPort['verify']>().mockImplementation(success)
    await evaluateCase(cases[0]!, 'v2', { note: { verify }, answer: noAnswer })
    const request = verify.mock.calls[0]![0]
    expect(request).not.toHaveProperty('expected')
    expect(request).not.toHaveProperty('category')
    expect(JSON.stringify(request)).not.toContain(cases[0]!.expected[0]!.reason)
    expect(JSON.stringify(request)).not.toContain(cases[0]!.id)
    expect(request.note.path).toBe('notes/evaluation.md')
    expect(verify).toHaveBeenCalledOnce()
  })
  it('changes only the prompt version between the two prepared requests', () => {
    for (const sample of cases) {
      const before = prepareCase(sample, 'v1')
      const after = prepareCase(sample, 'v2')
      before.noteInput.model.promptVersion = after.noteInput.model.promptVersion
      if (before.answerInput)
        before.answerInput.model.promptVersion = after.answerInput!.model.promptVersion
      expect(before).toEqual(after)
    }
  })
  it('keeps a malformed response in the agreement denominator and charges its tokens', async () => {
    const verify = vi
      .fn()
      .mockRejectedValue(new NoteVerificationModelError('MODEL_OUTPUT_TRUNCATED', { usage }))
    const row = await evaluateCase(cases[0]!, 'v2', { note: { verify }, answer: noAnswer })
    expect(row).toMatchObject({
      actual: null,
      schemaValid: false,
      errorCode: 'MODEL_OUTPUT_TRUNCATED',
      costMicrounits: 1360,
    })
    expect(summarize([row], 1)).toMatchObject({
      technicalFailures: 1,
      totalTokens: 120,
      conclusionAgreement: { numerator: 0, denominator: 1 },
      insufficientRate: { numerator: 0, denominator: 0, value: null },
      relevantRangeCoverage: { numerator: 0, denominator: 1 },
    })
    expect(verify).toHaveBeenCalledOnce()
  })
  it('counts bad raw citations even though the business validator rejects the candidate', async () => {
    const verify: NoteVerificationPort['verify'] = async (request, options) => {
      const response = await success(request, options)
      response.candidate.results[0]!.citations[0]!.excerpt = 'invented quote'
      return response
    }
    const row = await evaluateCase(cases[0]!, 'v2', { note: { verify }, answer: noAnswer })
    expect(row).toMatchObject({
      schemaValid: true,
      actual: null,
      errorCode: 'INVALID_MODEL_CITATION',
      citations: { valid: 0, total: 1 },
    })
  })
  it('rejects another criterion ID without hiding its returned citation', async () => {
    const verify: NoteVerificationPort['verify'] = async (request, options) => {
      const response = await success(request, options)
      response.candidate.results[0]!.criterionId = '00000000-0000-4000-8000-999999999999'
      return response
    }
    const row = await evaluateCase(cases[0]!, 'v2', { note: { verify }, answer: noAnswer })
    expect(row).toMatchObject({
      actual: null,
      errorCode: 'INVALID_MODEL_OUTPUT',
      citations: { valid: 1, total: 1 },
      relevantRanges: { covered: 0, total: 1 },
    })
  })
  it('counts a wrong pass against all expected non-passing criteria', async () => {
    const row = await evaluateCase(cases[1]!, 'v2', { note: { verify: success }, answer: noAnswer })
    expect(summarize([row], 1)).toMatchObject({
      falsePassRate: { numerator: 1, denominator: 1, value: 1 },
      conclusionAgreement: { value: 0 },
    })
  })
  it('checks answer citations against the answer, not the correct source note', async () => {
    const verify: AnswerVerificationPort['verify'] = async (request) => ({
      usage,
      candidate: {
        outcome: 'PASSED',
        rationale: '合成判断',
        suggestions: [],
        confidence: 0.8,
        citations: [
          { startLine: 3, endLine: 4, excerpt: request.note.lines.slice(2, 4).join('\n') },
        ],
        answerCitations: [{ startLine: 1, endLine: 1, excerpt: request.note.lines[2]! }],
      },
    })
    const row = await evaluateCase(cases[10]!, 'v2', {
      note: { verify: vi.fn() },
      answer: { verify },
    })
    expect(row).toMatchObject({
      actual: null,
      errorCode: 'INVALID_ANSWER_CITATION',
      citations: { valid: 1, total: 2 },
    })
  })
  it('reports unknown usage separately instead of inventing a free call', async () => {
    const verify: NoteVerificationPort['verify'] = async (request, options) => ({
      ...(await success(request, options)),
      usage: null,
    })
    const row = await evaluateCase(cases[0]!, 'v2', { note: { verify }, answer: noAnswer })
    expect(row.actual).toEqual(['PASSED'])
    expect(summarize([row], 2)).toMatchObject({
      unknownUsageCalls: 1,
      averageTokens: null,
      averageCostMicrounits: null,
      unattempted: 1,
    })
  })
})
