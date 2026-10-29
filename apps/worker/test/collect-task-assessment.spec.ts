import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { CriterionResult, NoteVerificationReportBody } from '@knowledgeops/contracts'
import {
  answerVerificationCandidate,
  answerVerificationRequest,
} from '../../../packages/agent-core/test/fixtures/answer-verification.js'
import {
  collectTaskAssessment,
  TaskAssessmentError,
  type CollectTaskAssessmentInput,
} from '../src/verification/collect-task-assessment.js'
import { validateAnswerVerification } from '../src/verification/verify-follow-up-answer.js'

function fixture() {
  const request = structuredClone(answerVerificationRequest)
  const { id: questionId, ...questionBody } = request.question
  const fileId = randomUUID(),
    semanticId = randomUUID()
  const accounting = {
    knownTotalTokens: 0,
    knownCostMicrounits: 0,
    currency: 'CNY' as const,
    usageComplete: true,
    warnings: [],
  }
  const result = (criterionId: string): CriterionResult => ({
    criterionId,
    outcome: 'PASSED',
    rationale: '合成检查结果',
    suggestions: [],
    citations: [],
    confidence: 1,
  })
  const note: NoteVerificationReportBody = {
    results: [result(fileId), result(semanticId)],
    exemptions: [],
    pendingCriterionIds: [questionBody.criterionId],
    followUp: { status: 'READY' },
    accounting,
  }
  const answerReport = {
    source: structuredClone(questionBody.source),
    result: validateAnswerVerification(request, answerVerificationCandidate),
    accounting,
  }
  const input: CollectTaskAssessmentInput = {
    source: structuredClone(questionBody.source),
    evidenceMode: 'DIFF',
    criteria: [
      { id: fileId, type: 'FILE_CHANGED', required: true },
      { id: semanticId, type: 'SEMANTIC_CORRECTNESS', required: true },
      { id: questionBody.criterionId, type: 'FOLLOW_UP_ANSWER', required: true },
    ],
    noteReport: note,
  }
  const answer = {
    questionId,
    questionBody,
    answerSubmissionId: request.answer.id,
    report: answerReport,
  }
  return { input, note, answer, answerReport, result, fileId, semanticId }
}

describe('R11: collect criterion facts before deciding Task state', () => {
  it('keeps an unanswered follow-up empty even when the note passed and the question is READY', () => {
    const f = fixture()
    const before = structuredClone(f.input)
    const facts = collectTaskAssessment(f.input)
    expect(facts.map(({ outcome }) => outcome)).toEqual(['PASSED', 'PASSED', null])
    expect(facts[2]).toMatchObject({ type: 'FOLLOW_UP_ANSWER', required: true, exemption: null })
    expect(f.input).toEqual(before)
  })

  it('joins only the current answer judgment and preserves a failed answer as its own fact', () => {
    const f = fixture()
    f.input.answer = f.answer
    expect(collectTaskAssessment(f.input).map(({ outcome }) => outcome)).toEqual([
      'PASSED',
      'PASSED',
      'PASSED',
    ])
    f.answerReport.result.outcome = 'FAILED'
    f.answerReport.result.suggestions = ['重新解释微任务顺序。']
    expect(collectTaskAssessment(f.input).map(({ outcome }) => outcome)).toEqual([
      'PASSED',
      'PASSED',
      'FAILED',
    ])
    f.answerReport.result.outcome = 'INSUFFICIENT_EVIDENCE'
    expect(collectTaskAssessment(f.input)[2]!.outcome).toBe('INSUFFICIENT_EVIDENCE')
  })

  it('rejects answers from another question, submission, criterion or original note source', () => {
    for (const field of ['questionId', 'answerSubmissionId', 'criterionId'] as const) {
      const f = fixture()
      f.input.answer = f.answer
      f.answerReport.result[field] = randomUUID()
      expect(() => collectTaskAssessment(f.input)).toThrow(TaskAssessmentError)
    }
    for (const field of [
      'taskId',
      'submissionId',
      'noteRunId',
      'reportId',
      'repositoryId',
    ] as const) {
      const f = fixture()
      f.input.answer = f.answer
      f.answerReport.source[field] = randomUUID()
      expect(() => collectTaskAssessment(f.input)).toThrow(TaskAssessmentError)
    }
    const f = fixture()
    f.input.answer = f.answer
    f.answer.questionBody.source.commitSha = 'f'.repeat(40)
    expect(() => collectTaskAssessment(f.input)).toThrow(TaskAssessmentError)
    f.answer.questionBody.source = structuredClone(f.input.source)
    f.note.followUp = { status: 'FAILED', code: 'MODEL_CALL_LIMIT_EXCEEDED' }
    expect(() => collectTaskAssessment(f.input)).toThrow(TaskAssessmentError)
  })

  it('keeps a missing required result and an optional failed result visible instead of silently dropping them', () => {
    const f = fixture()
    const optionalId = randomUUID()
    f.input.criteria = [
      ...f.input.criteria,
      { id: optionalId, type: 'EXPLANATION_QUALITY', required: false },
    ]
    f.note.results = [f.result(f.fileId), { ...f.result(optionalId), outcome: 'FAILED' }]
    const facts = collectTaskAssessment(f.input)
    expect(facts[1]).toMatchObject({ id: f.semanticId, required: true, outcome: null })
    expect(facts[3]).toMatchObject({ id: optionalId, required: false, outcome: 'FAILED' })
    f.note.results.push({ ...f.result(f.semanticId), outcome: 'INSUFFICIENT_EVIDENCE' })
    expect(collectTaskAssessment(f.input)[1]!.outcome).toBe('INSUFFICIENT_EVIDENCE')
  })

  it('preserves the snapshot FILE_CHANGED exemption without inventing a passing result or allowing arbitrary exemptions', () => {
    const f = fixture()
    f.input.evidenceMode = 'SNAPSHOT'
    // 快照报告不能冒充已证明文件发生变化。
    expect(() => collectTaskAssessment(f.input)).toThrow(TaskAssessmentError)
    f.note.results = [f.result(f.semanticId)]
    f.note.exemptions = [{ criterionId: f.fileId, reason: 'SNAPSHOT_FILE_CHANGED_NOT_APPLICABLE' }]
    expect(collectTaskAssessment(f.input)[0]).toMatchObject({
      outcome: null,
      exemption: 'SNAPSHOT_FILE_CHANGED_NOT_APPLICABLE',
    })
    f.input.evidenceMode = 'DIFF'
    expect(() => collectTaskAssessment(f.input)).toThrow(TaskAssessmentError)
    f.input.evidenceMode = 'SNAPSHOT'
    f.note.exemptions.push({
      criterionId: f.semanticId,
      reason: 'SNAPSHOT_FILE_CHANGED_NOT_APPLICABLE',
    })
    f.note.results = []
    expect(() => collectTaskAssessment(f.input)).toThrow(TaskAssessmentError)
  })

  it('rejects unknown, duplicate or conflicting facts and never accepts a note result as an answer', () => {
    const f = fixture()
    const invalidReports = [
      { ...f.note, results: [...f.note.results, f.result(randomUUID())] },
      { ...f.note, results: [...f.note.results, f.result(f.fileId)] },
      { ...f.note, pendingCriterionIds: [...f.note.pendingCriterionIds, f.fileId] },
      {
        ...f.note,
        pendingCriterionIds: [...f.note.pendingCriterionIds, ...f.note.pendingCriterionIds],
      },
      {
        ...f.note,
        results: [...f.note.results, f.result(f.note.pendingCriterionIds[0]!)],
        pendingCriterionIds: [],
      },
      {
        ...f.note,
        exemptions: [{ criterionId: f.fileId, reason: 'SNAPSHOT_FILE_CHANGED_NOT_APPLICABLE' }],
      },
      null,
    ]
    for (const noteReport of invalidReports)
      expect(() => collectTaskAssessment({ ...f.input, noteReport })).toThrow(TaskAssessmentError)
    expect(() =>
      collectTaskAssessment({ ...f.input, criteria: [...f.input.criteria, f.input.criteria[0]!] }),
    ).toThrow(TaskAssessmentError)
  })

  it('requires a single mandatory follow-up and note criteria before state derivation', () => {
    const f = fixture()
    for (const criteria of [
      [],
      f.input.criteria.slice(0, 2),
      [f.input.criteria[2]!],
      f.input.criteria.map((c) => ({ ...c, required: false })),
      [
        ...f.input.criteria,
        { id: randomUUID(), type: 'FOLLOW_UP_ANSWER' as const, required: true },
      ],
    ])
      expect(() => collectTaskAssessment({ ...f.input, criteria })).toThrow(TaskAssessmentError)
  })
})
