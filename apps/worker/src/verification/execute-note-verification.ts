import {
  noteSemanticCriterionTypeSchema,
  type NoteVerificationOptions,
  type NoteVerificationPort,
  type FollowUpGenerationPort,
  type FollowUpGenerationOptions,
} from '@knowledgeops/agent-core'
import type { CriterionResult, FollowUpGenerationState } from '@knowledgeops/contracts'
import { verifyNoteSemantics } from './verify-note-semantics.js'
import { generateFollowUpQuestion } from './generate-follow-up-question.js'
import type { FollowUpQuestionDraft } from './validate-follow-up-question.js'
import {
  executeVerificationSteps,
  type VerificationOutcome,
  type NoteVerificationAccounting,
  type NoteVerificationBudget,
  type NoteVerificationJournal,
} from './verification-budget.js'
export {
  noteVerificationBudgetSchema,
  type NoteVerificationAccounting,
  type NoteVerificationAttempt,
  type NoteVerificationBudget,
  type NoteVerificationJournal,
} from './verification-budget.js'

export type FollowUpExecution =
  | Exclude<FollowUpGenerationState, { status: 'READY' }>
  | { status: 'READY'; question: FollowUpQuestionDraft }
export type NoteVerificationInput = Parameters<typeof verifyNoteSemantics>[1] & {
  followUp?: Pick<
    Parameters<typeof generateFollowUpQuestion>[1],
    'source' | 'model' | 'criterion'
  > & {
    deterministicPassed: boolean
    requiredSemanticIds: string[]
  }
}
export function canGenerateFollowUp(
  input: NonNullable<NoteVerificationInput['followUp']>,
  results: CriterionResult[],
) {
  return (
    input.deterministicPassed &&
    input.requiredSemanticIds.every((id) =>
      results.some((result) => result.criterionId === id && result.outcome === 'PASSED'),
    )
  )
}

type NoteResult = { results: CriterionResult[]; followUp?: FollowUpExecution | undefined }
export type NoteVerificationExecution = (
  ({ status: 'SUCCEEDED' } & NoteResult) | { status: 'FAILED'; code: string }
) & { accounting: NoteVerificationAccounting }

// 保留笔记 → 出题的业务顺序；预算/取消/修复规则与回答验收共用。
export async function executeNoteVerification(
  port: NoteVerificationPort,
  input: NoteVerificationInput,
  options: Pick<NoteVerificationOptions, 'signal' | 'maxOutputTokens'>,
  budget: NoteVerificationBudget,
  journal?: NoteVerificationJournal,
  followUpPort?: FollowUpGenerationPort,
): Promise<NoteVerificationExecution> {
  let results: CriterionResult[] | undefined = input.criteria.some(
    (criterion) => noteSemanticCriterionTypeSchema.safeParse(criterion.type).success,
  )
    ? undefined
    : []
  let generated: FollowUpExecution | undefined
  const succeed = (followUp?: FollowUpExecution): VerificationOutcome<NoteResult> => ({
    status: 'SUCCEEDED',
    value: { results: results ?? [], ...(followUp ? { followUp } : {}) },
  })
  const execution = await executeVerificationSteps<NoteResult>(
    input,
    options,
    budget,
    {
      next() {
        if (results === undefined)
          return {
            stepId: 'NOTE_SEMANTICS',
            async invoke(callOptions) {
              const response = await verifyNoteSemantics(
                port,
                input,
                callOptions as NoteVerificationOptions,
              )
              results = response.results
              return response
            },
          }
        if (!input.followUp) return succeed()
        if (!canGenerateFollowUp(input.followUp, results))
          return succeed({ status: 'SKIPPED', reason: 'NOTE_CRITERIA_NOT_PASSED' })
        if (!followUpPort) return succeed({ status: 'FAILED', code: 'FOLLOW_UP_NOT_CONFIGURED' })
        if (generated) return succeed(generated)
        return {
          stepId: 'GENERATE_FOLLOW_UP',
          async invoke(callOptions) {
            const response = await generateFollowUpQuestion(
              followUpPort,
              {
                ...input.followUp!,
                task: input.task,
                note: input.note,
              },
              callOptions as FollowUpGenerationOptions,
            )
            generated = { status: 'READY', question: response.question }
            return response
          },
        }
      },
      onModelStop: (code) =>
        results !== undefined && input.followUp
          ? succeed({ status: 'FAILED', code })
          : { status: 'FAILED', code },
    },
    journal,
  )
  return execution.status === 'SUCCEEDED'
    ? { status: 'SUCCEEDED', ...execution.value, accounting: execution.accounting }
    : execution
}
