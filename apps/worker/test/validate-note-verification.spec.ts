import { randomUUID } from 'node:crypto'
import type { NoteVerificationCandidate } from '@knowledgeops/agent-core'
import { describe, expect, it } from 'vitest'
import { parseNoteEvidence } from '../src/verification/parse-note-evidence.js'
import { validateNoteVerification } from '../src/verification/validate-note-verification.js'
import { noteEvidence } from './fixtures/note-evidence.js'

function fixture() {
  const evidence = noteEvidence('# 事件循环\r\n\r\n当前任务结束后，先清空微任务队列。\r\n')
  const criteria = [
    { id: randomUUID(), type: 'SECTION_PRESENT' as const },
    { id: randomUUID(), type: 'SEMANTIC_CORRECTNESS' as const },
    { id: randomUUID(), type: 'TOPIC_COVERAGE' as const },
    { id: randomUUID(), type: 'FOLLOW_UP_ANSWER' as const },
  ]
  const candidate: NoteVerificationCandidate = {
    results: criteria.slice(1, 3).map((criterion) => ({
      criterionId: criterion.id,
      outcome: 'PASSED',
      rationale: '正文描述了当前任务与微任务的执行顺序。',
      suggestions: [],
      citations: [{ startLine: 3, endLine: 3, excerpt: '当前任务结束后，先清空微任务队列。' }],
      confidence: 0.8,
    })),
  }
  return { note: parseNoteEvidence(evidence), criteria, candidate }
}

describe('note model candidate boundary', () => {
  it('accepts exact source quotes and binds source metadata in task order without mutations', () => {
    const input = fixture()
    input.candidate.results.reverse()
    const before = structuredClone(input)
    const results = validateNoteVerification(input)
    expect(results.map((result) => result.criterionId)).toEqual(
      input.criteria.slice(1, 3).map((criterion) => criterion.id),
    )
    expect(results[0]?.citations[0]).toEqual({
      ...input.note.source,
      startLine: 3,
      endLine: 3,
      excerpt: input.note.lines[2],
    })
    expect(input).toEqual(before)
  })

  it.each(['PASSED', 'FAILED'] as const)(
    'rejects an unsupported %s even at confidence 1',
    (outcome) => {
      const input = fixture()
      Object.assign(input.candidate.results[0]!, { outcome, confidence: 1, citations: [] })
      expect(() => validateNoteVerification(input)).toThrow('INVALID_MODEL_CITATION')
    },
  )

  it('allows honest insufficient evidence without a fabricated quote', () => {
    const input = fixture()
    Object.assign(input.candidate.results[0]!, {
      outcome: 'INSUFFICIENT_EVIDENCE',
      confidence: 0,
      citations: [],
      rationale: '笔记没有提供足以判断的说明。',
    })
    expect(validateNoteVerification(input)[0]).toMatchObject({
      outcome: 'INSUFFICIENT_EVIDENCE',
      citations: [],
      confidence: 0,
    })
  })

  it.each([
    { startLine: 3, endLine: 3, excerpt: '模型编造的句子' },
    { startLine: 1, endLine: 1, excerpt: '当前任务结束后，先清空微任务队列。' },
    { startLine: 2, endLine: 2, excerpt: '' },
    { startLine: 3, endLine: 4, excerpt: '引用超出正文' },
    { startLine: 3, endLine: 2, excerpt: '倒置范围' },
  ])('rejects invalid source citation $startLine–$endLine / $excerpt', (citation) => {
    const input = fixture()
    // Even if another result is valid, the entire candidate must be rejected.
    input.candidate.results[1]!.citations = [citation]
    expect(() => validateNoteVerification(input)).toThrow('INVALID_MODEL_CITATION')
  })

  it('rejects invented quotes even when the outcome says insufficient evidence', () => {
    const input = fixture()
    input.candidate.results[0]!.outcome = 'INSUFFICIENT_EVIDENCE'
    input.candidate.results[0]!.citations[0]!.excerpt = '伪造'
    expect(() => validateNoteVerification(input)).toThrow('INVALID_MODEL_CITATION')
  })

  it.each(['missing', 'duplicate', 'foreign', 'deterministic', 'follow-up'])(
    'rejects %s criterion results',
    (scenario) => {
      const input = fixture()
      if (scenario === 'missing') input.candidate.results.pop()
      else
        input.candidate.results[1]!.criterionId =
          scenario === 'duplicate'
            ? input.criteria[1]!.id
            : scenario === 'deterministic'
              ? input.criteria[0]!.id
              : scenario === 'follow-up'
                ? input.criteria[3]!.id
                : randomUUID()
      expect(() => validateNoteVerification(input)).toThrow('INVALID_MODEL_OUTPUT')
    },
  )

  it.each([
    { confidence: 2 },
    { rationale: ' ' },
    { outcome: 'APPROVED' },
    { taskState: 'PASSED' },
    { suggestions: Array.from({ length: 6 }, () => '更多建议') },
    { citations: [{ startLine: 0, endLine: 1, excerpt: '零行号' }] },
    { citations: [{ startLine: 1.5, endLine: 2, excerpt: '小数行号' }] },
    { citations: [{ startLine: 3, endLine: 3, excerpt: 'x'.repeat(4_001) }] },
    { citations: [{ startLine: 3, endLine: 3, excerpt: '原文', commitSha: 'a'.repeat(40) }] },
  ])('rejects malformed or over-limit output %j', (change) => {
    const input = fixture()
    Object.assign(input.candidate.results[0]!, change)
    expect(() => validateNoteVerification(input)).toThrow('INVALID_MODEL_OUTPUT')
  })

  it('accepts canonical LF multi-line excerpts from a CRLF source', () => {
    const input = fixture()
    input.candidate.results[0]!.citations = [
      {
        startLine: 1,
        endLine: 3,
        excerpt: input.note.lines.join('\n'),
      },
    ]
    expect(validateNoteVerification(input)[0]?.citations[0]?.excerpt).toBe(
      '# 事件循环\n\n当前任务结束后，先清空微任务队列。',
    )
  })

  it('does not claim to prove semantic correctness from an authentic citation', () => {
    const input = fixture()
    input.candidate.results[0]!.rationale = '微任务总在下一轮宏任务之后执行。'
    // The quote is authentic, but the rationale is wrong: evaluation remains necessary.
    expect(validateNoteVerification(input)[0]?.rationale).toBe(
      input.candidate.results[0]!.rationale,
    )
  })

  it('handles no semantic criteria without inventing a result', () => {
    const input = fixture()
    expect(
      validateNoteVerification({
        ...input,
        criteria: [input.criteria[0]!],
        candidate: { results: [] },
      }),
    ).toEqual([])
  })
})
