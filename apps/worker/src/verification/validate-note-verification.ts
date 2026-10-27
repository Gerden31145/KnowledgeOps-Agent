import {
  noteSemanticCriterionTypeSchema,
  noteVerificationCandidateSchema,
  type NoteVerificationUsage,
} from '@knowledgeops/agent-core'
import type { CriterionResult } from '@knowledgeops/contracts'
import type { NoteCriterion } from './check-note-criteria.js'
import { readNoteCitation, type ParsedNoteEvidence } from './parse-note-evidence.js'

export class NoteVerificationCandidateError extends Error {
  override readonly name = 'NoteVerificationCandidateError'

  constructor(
    readonly code: 'INVALID_MODEL_OUTPUT' | 'INVALID_MODEL_CITATION',
    readonly usage: NoteVerificationUsage | null = null,
  ) {
    super(code)
  }
}

// note 来自 parseNoteEvidence；criteria 来自同一任务的持久化标准。
// 校验失败整份候选作废，不返回半份结果、不修改 Task，也不替模型决定语义对错。
export function validateNoteVerification(input: {
  note: ParsedNoteEvidence
  criteria: readonly Pick<NoteCriterion, 'id' | 'type'>[]
  candidate: unknown
}): CriterionResult[] {
  const expected = input.criteria.filter(
    (criterion) => noteSemanticCriterionTypeSchema.safeParse(criterion.type).success,
  )
  const parsed = noteVerificationCandidateSchema.safeParse(input.candidate)
  if (!parsed.success) throw new NoteVerificationCandidateError('INVALID_MODEL_OUTPUT')

  const expectedIds = new Set(expected.map((criterion) => criterion.id))
  const results = new Map(parsed.data.results.map((result) => [result.criterionId, result]))
  if (
    expectedIds.size !== expected.length ||
    parsed.data.results.length !== expected.length ||
    results.size !== expected.length ||
    parsed.data.results.some((result) => !expectedIds.has(result.criterionId))
  ) {
    throw new NoteVerificationCandidateError('INVALID_MODEL_OUTPUT')
  }

  return expected.map((criterion) => {
    const result = results.get(criterion.id)!
    // 缺少证据可以如实表示“不足”；通过或失败的语义结论必须有原文依据。
    if (result.outcome !== 'INSUFFICIENT_EVIDENCE' && result.citations.length === 0) {
      throw new NoteVerificationCandidateError('INVALID_MODEL_CITATION')
    }
    const citations = result.citations.map((citation) => {
      if (citation.endLine < citation.startLine || citation.endLine > input.note.lines.length) {
        throw new NoteVerificationCandidateError('INVALID_MODEL_CITATION')
      }
      const actual = readNoteCitation(input.note, citation.startLine, citation.endLine)
      if (citation.excerpt !== actual.excerpt || actual.excerpt.trim().length === 0) {
        throw new NoteVerificationCandidateError('INVALID_MODEL_CITATION')
      }
      return actual
    })
    return { ...result, citations }
  })
}
