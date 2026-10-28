import { z } from 'zod'
import { agentRunStateSchema } from '../domain/agent-run-state.js'
import { criterionResultSchema, noteCitationSchema } from '../domain/note-verification.js'
import { followUpGenerationStateSchema } from '../domain/follow-up-question.js'
import { entityIdSchema, isoDateTimeSchema } from '../shared/primitives.js'

export const noteVerificationReportBodySchema = z
  .object({
    results: z.array(criterionResultSchema).max(20),
    exemptions: z
      .array(
        z
          .object({
            criterionId: entityIdSchema,
            reason: z.literal('SNAPSHOT_FILE_CHANGED_NOT_APPLICABLE'),
          })
          .strict(),
      )
      .max(20),
    // 生成题目不代表回答通过，FOLLOW_UP_ANSWER 仍须保持待验收。
    pendingCriterionIds: z.array(entityIdSchema).max(20),
    // 兼容 R09 的历史报告，读取时不补发模型请求。
    followUp: followUpGenerationStateSchema.nullable().default(null),
    accounting: z
      .object({
        knownTotalTokens: z.number().int().nonnegative(),
        knownCostMicrounits: z.number().int().nonnegative(),
        currency: z.enum(['CNY', 'USD']),
        usageComplete: z.boolean(),
        warnings: z
          .array(
            z.enum(['MODEL_BUDGET_EXCEEDED', 'MODEL_USAGE_UNKNOWN', 'MODEL_ACCOUNTING_INVALID']),
          )
          .max(3),
      })
      .strict(),
  })
  .strict()
export type NoteVerificationReportBody = z.infer<typeof noteVerificationReportBodySchema>

export const noteVerificationRunResponseSchema = z
  .object({
    runId: entityIdSchema,
    taskId: entityIdSchema,
    submissionId: entityIdSchema.nullable(),
    status: agentRunStateSchema,
    version: z.number().int().nonnegative(),
    queuedAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.nullable(),
    finishedAt: isoDateTimeSchema.nullable(),
    errorCode: z.string().max(64).nullable(),
    followUpQuestion: z
      .object({
        id: entityIdSchema,
        criterionId: entityIdSchema,
        question: z.string().min(1).max(1_000),
        citations: z.array(noteCitationSchema).min(1).max(3),
      })
      .strict()
      .nullable()
      .default(null),
    report: z
      .object({
        id: entityIdSchema,
        createdAt: isoDateTimeSchema,
        body: noteVerificationReportBodySchema,
      })
      .strict()
      .nullable(),
  })
  .strict()
