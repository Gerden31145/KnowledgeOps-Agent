import { z } from 'zod'
import { agentRunStateSchema } from '../domain/agent-run-state.js'
import { criterionResultSchema } from '../domain/note-verification.js'
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
    // 追问尚待 R10，不能把这些标准伪装为已通过。
    pendingCriterionIds: z.array(entityIdSchema).max(20),
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
