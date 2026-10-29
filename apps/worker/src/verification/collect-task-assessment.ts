import { isDeepStrictEqual } from 'node:util'
import {
  answerVerificationReportBodySchema,
  followUpQuestionDraftSchema,
  noteVerificationReportBodySchema,
  type AcceptanceCriterionType,
  type CriterionResult,
} from '@knowledgeops/contracts'
import type { z } from 'zod'

type NoteSource = z.infer<typeof followUpQuestionDraftSchema>['source']
type Exemption = 'SNAPSHOT_FILE_CHANGED_NOT_APPLICABLE'
export interface TaskAssessmentCriterion {
  id: string
  type: AcceptanceCriterionType
  required: boolean
}
export interface TaskCriterionAssessment extends TaskAssessmentCriterion {
  // null 表示没有本项结论，不自动补成 PASSED，也不等于模型判断证据不足。
  outcome: CriterionResult['outcome'] | null
  exemption: Exemption | null
}
export interface CollectTaskAssessmentInput {
  criteria: readonly TaskAssessmentCriterion[]
  source: NoteSource
  evidenceMode: 'DIFF' | 'SNAPSHOT'
  noteReport: unknown
  answer?: {
    questionId: string
    questionBody: unknown
    answerSubmissionId: string
    report: unknown
  }
}

export class TaskAssessmentError extends Error {
  constructor() {
    super('INVALID_TASK_ASSESSMENT')
    this.name = 'TaskAssessmentError'
  }
}

// 为状态推导准备事实，不决定 Task 状态。调用方须先在事务内复核运行/绑定/版本，
// 提供同一次笔记的来源及原题；此处的来源相等检查不能代替数据库资格或原文引用核验。
export function collectTaskAssessment(
  input: CollectTaskAssessmentInput,
): TaskCriterionAssessment[] {
  const report = noteVerificationReportBodySchema.safeParse(input.noteReport)
  const source = followUpQuestionDraftSchema.shape.source.safeParse(input.source)
  const criteria = new Map(input.criteria.map((criterion) => [criterion.id, criterion]))
  const followUp = input.criteria.filter((criterion) => criterion.type === 'FOLLOW_UP_ANSWER')
  if (
    !report.success ||
    !source.success ||
    !['DIFF', 'SNAPSHOT'].includes(input.evidenceMode) ||
    criteria.size !== input.criteria.length ||
    followUp.length !== 1 ||
    !followUp[0]!.required ||
    !input.criteria.some((criterion) => criterion.type !== 'FOLLOW_UP_ANSWER')
  )
    throw new TaskAssessmentError()

  // 一个标准只能有一种记录；冲突/未知记录拒绝，缺失记录则保留为空供后续判断。
  const seen = new Set<string>()
  const takeCriterion = (id: string) => {
    const criterion = criteria.get(id)
    if (!criterion || seen.has(id)) throw new TaskAssessmentError()
    seen.add(id)
    return criterion
  }
  const results = new Map<string, CriterionResult['outcome']>()
  const exemptions = new Map<string, Exemption>()
  for (const result of report.data.results) {
    const criterion = takeCriterion(result.criterionId)
    if (criterion.type === 'FOLLOW_UP_ANSWER') throw new TaskAssessmentError()
    results.set(criterion.id, result.outcome)
  }
  for (const exemption of report.data.exemptions) {
    const criterion = takeCriterion(exemption.criterionId)
    if (input.evidenceMode !== 'SNAPSHOT' || criterion.type !== 'FILE_CHANGED')
      throw new TaskAssessmentError()
    exemptions.set(criterion.id, exemption.reason)
  }
  for (const id of report.data.pendingCriterionIds) takeCriterion(id)
  if (
    input.evidenceMode === 'SNAPSHOT' &&
    input.criteria.some(
      (criterion) => criterion.type === 'FILE_CHANGED' && !exemptions.has(criterion.id),
    )
  )
    throw new TaskAssessmentError()

  if (input.answer) {
    const question = followUpQuestionDraftSchema.safeParse(input.answer.questionBody)
    const answer = answerVerificationReportBodySchema.safeParse(input.answer.report)
    if (
      !question.success ||
      !answer.success ||
      report.data.followUp?.status !== 'READY' ||
      !report.data.pendingCriterionIds.includes(followUp[0]!.id) ||
      question.data.criterionId !== followUp[0]!.id ||
      answer.data.result.criterionId !== question.data.criterionId ||
      answer.data.result.questionId !== input.answer.questionId ||
      answer.data.result.answerSubmissionId !== input.answer.answerSubmissionId ||
      !isDeepStrictEqual(question.data.source, source.data) ||
      !isDeepStrictEqual(answer.data.source, source.data)
    )
      throw new TaskAssessmentError()
    results.set(question.data.criterionId, answer.data.result.outcome)
  }

  return input.criteria.map(({ id, type, required }) => ({
    id,
    type,
    required,
    outcome: results.get(id) ?? null,
    exemption: exemptions.get(id) ?? null,
  }))
}
