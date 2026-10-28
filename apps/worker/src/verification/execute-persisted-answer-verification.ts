import { createHash } from 'node:crypto'
import type { AnswerVerificationOptions, AnswerVerificationPort } from '@knowledgeops/agent-core'
import { answerVerificationResultSchema } from '@knowledgeops/contracts'
import { z } from 'zod'
import {
  VerificationExecutionRepository,
  verificationAccountingSchema,
} from './note-verification-execution.repository.js'
import {
  executeVerificationSteps,
  type NoteVerificationBudget,
  type NoteVerificationJournal,
} from './verification-budget.js'
import { verifyFollowUpAnswer } from './verify-follow-up-answer.js'

export const answerExecutionResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('SUCCEEDED'),
      result: answerVerificationResultSchema,
      accounting: verificationAccountingSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('FAILED'),
      code: z.string().min(1).max(64),
      accounting: verificationAccountingSchema,
    })
    .strict(),
])
export type AnswerExecution = z.infer<typeof answerExecutionResultSchema>
export type AnswerVerificationInput = Parameters<typeof verifyFollowUpAnswer>[1]
export type AnswerExecutionRepository = VerificationExecutionRepository<AnswerExecution>

export async function executeAnswerVerification(
  port: AnswerVerificationPort,
  input: AnswerVerificationInput,
  options: Pick<AnswerVerificationOptions, 'signal' | 'maxOutputTokens'>,
  budget: NoteVerificationBudget,
  journal?: NoteVerificationJournal,
): Promise<AnswerExecution> {
  let result: z.infer<typeof answerVerificationResultSchema> | undefined
  const execution = await executeVerificationSteps<z.infer<typeof answerVerificationResultSchema>>(
    input,
    options,
    budget,
    {
      next: () =>
        result
          ? { status: 'SUCCEEDED', value: result }
          : {
              stepId: 'ANSWER_VERIFICATION',
              async invoke(callOptions) {
                const response = await verifyFollowUpAnswer(
                  port,
                  input,
                  callOptions as AnswerVerificationOptions,
                )
                result = response.result
                return response
              },
            },
      onModelStop: (code) => ({ status: 'FAILED', code }),
    },
    journal,
  )
  return execution.status === 'SUCCEEDED'
    ? { status: 'SUCCEEDED', result: execution.value, accounting: execution.accounting }
    : execution
}

// 每个回答 Run 独立 claim；队列重放复用已完成账本，不重建预算或重复请求模型。
export async function executePersistedAnswerVerification(
  repository: AnswerExecutionRepository,
  port: AnswerVerificationPort,
  input: AnswerVerificationInput,
  options: Pick<AnswerVerificationOptions, 'signal' | 'maxOutputTokens'>,
  budget: NoteVerificationBudget,
) {
  const frozen = structuredClone(input)
  const claimed = await repository.claim({
    runId: frozen.runId,
    taskId: frozen.task.id,
    fingerprint: answerExecutionFingerprint(frozen),
    configuration: {
      model: frozen.model,
      budget: structuredClone(budget),
      maxOutputTokens: options.maxOutputTokens,
    },
  })
  if (claimed.status !== 'CLAIMED') return claimed
  const result = await executeAnswerVerification(
    port,
    frozen,
    {
      signal: options.signal,
      maxOutputTokens: claimed.configuration.maxOutputTokens,
    },
    claimed.configuration.budget,
    {
      reserve: (attempt, accounting) => repository.reserve(claimed.claim, attempt, accounting),
      settle: (attempt, accounting) => repository.settle(claimed.claim, attempt, accounting),
    },
  )
  await repository.finish(claimed.claim, result)
  return { status: 'EXECUTED' as const, result }
}

export function answerExecutionFingerprint(input: AnswerVerificationInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        runId: input.runId,
        model: input.model,
        task: input.task,
        question: input.question,
        answer: input.answer,
        note: { ...input.note.source, lines: input.note.lines },
      }),
    )
    .digest('hex')
}
