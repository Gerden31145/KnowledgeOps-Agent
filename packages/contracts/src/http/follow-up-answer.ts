import { z } from 'zod'
import { entityIdSchema, isoDateTimeSchema } from '../shared/primitives.js'
import { agentRunStateSchema } from '../domain/agent-run-state.js'
import { answerVerificationResultSchema } from '../domain/answer-verification.js'
import { followUpQuestionDraftSchema } from '../domain/follow-up-question.js'
import { noteVerificationReportBodySchema } from './note-verification.js'
import {
  retryNoteVerificationInputSchema,
  retryNoteVerificationResponseSchema,
} from './note-verification-retry.js'

export const retryAnswerVerificationInputSchema = retryNoteVerificationInputSchema
export type RetryAnswerVerificationInput = z.infer<typeof retryAnswerVerificationInputSchema>
export const retryAnswerVerificationResponseSchema = retryNoteVerificationResponseSchema.extend({
  answerSubmissionId: entityIdSchema,
})
export type RetryAnswerVerificationResponse = z.infer<typeof retryAnswerVerificationResponseSchema>
export const followUpAnswerQuerySchema = z.object({ runId: entityIdSchema.optional() }).strict()

export const answerVerificationReportBodySchema = z
  .object({
    source: followUpQuestionDraftSchema.shape.source,
    result: answerVerificationResultSchema,
    accounting: noteVerificationReportBodySchema.shape.accounting,
  })
  .strict()

export const submitFollowUpAnswerInputSchema = z
  .object({
    // 同一次用户提交生成一次 UUID；网络重试复用，修改答案后重新提交使用新 UUID。
    requestId: entityIdSchema,
    expectedTaskVersion: z.number().int().nonnegative().max(2_147_483_646),
    answer: z.string().trim().min(1).max(8_000),
  })
  .strict()
export type SubmitFollowUpAnswerInput = z.infer<typeof submitFollowUpAnswerInputSchema>

export const followUpAnswerAcceptedResponseSchema = z
  .object({
    status: z.literal('ACCEPTED'),
    answerSubmissionId: entityIdSchema,
    runId: entityIdSchema,
    taskId: entityIdSchema,
    taskVersion: z.number().int().nonnegative(),
  })
  .strict()
export type FollowUpAnswerAcceptedResponse = z.infer<typeof followUpAnswerAcceptedResponseSchema>

export const followUpAnswerResponseSchema = z
  .object({
    answerSubmissionId: entityIdSchema,
    questionId: entityIdSchema,
    answer: z.string().min(1).max(8_000),
    createdAt: isoDateTimeSchema,
    run: z
      .object({
        runId: entityIdSchema,
        taskId: entityIdSchema,
        status: agentRunStateSchema,
        version: z.number().int().nonnegative(),
        retryOfRunId: entityIdSchema.nullable().default(null),
        retryRunId: entityIdSchema.nullable().default(null),
        errorCode: z.string().max(64).nullable(),
        queuedAt: isoDateTimeSchema,
        startedAt: isoDateTimeSchema.nullable(),
        finishedAt: isoDateTimeSchema.nullable(),
      })
      .strict(),
    report: z
      .object({
        id: entityIdSchema,
        createdAt: isoDateTimeSchema,
        body: answerVerificationReportBodySchema,
      })
      .strict()
      .nullable(),
  })
  .strict()

export type FollowUpAnswerResponse = z.infer<typeof followUpAnswerResponseSchema>
