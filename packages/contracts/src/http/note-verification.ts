import { z } from 'zod'
import { agentRunStateSchema } from '../domain/agent-run-state.js'
import { criterionResultSchema, noteCitationSchema } from '../domain/note-verification.js'
import { followUpGenerationStateSchema } from '../domain/follow-up-question.js'
import { entityIdSchema, isoDateTimeSchema } from '../shared/primitives.js'
import { markdownTargetPathSchema } from '../domain/plan.js'

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
        // 最近 20 次已保存的回答；正文/报告仍通过回答详情接口按需读取。
        answers: z
          .array(z.object({ id: entityIdSchema, createdAt: isoDateTimeSchema }).strict())
          .max(20)
          .default([]),
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

export type NoteVerificationRunResponse = z.infer<typeof noteVerificationRunResponseSchema>

// 独立读取固定证据，刷新报告不必重复传输整份正文。没有“最新分支”查询语义。
export const noteRunEvidenceResponseSchema = z
  .object({
    runId: entityIdSchema,
    taskId: entityIdSchema,
    submissionId: entityIdSchema,
    repositoryId: entityIdSchema,
    path: markdownTargetPathSchema,
    beforeCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
    afterCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
    sourceCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    content: z.string().max(1_000_000),
    lineCount: z.number().int().nonnegative(),
    mode: z.enum(['DIFF', 'SNAPSHOT']),
    change: z.enum(['added', 'modified', 'removed', 'renamed']).nullable(),
    previousPath: z.string().min(1).max(1024).nullable(),
    diff: z.string().nullable(),
  })
  .strict()
export type NoteRunEvidenceResponse = z.infer<typeof noteRunEvidenceResponseSchema>
