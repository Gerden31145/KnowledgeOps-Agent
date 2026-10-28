import { z } from 'zod'
import { entityIdSchema } from '../shared/primitives.js'
import { noteCitationSchema } from './note-verification.js'

// 内部持久化材料含评分要点；查询接口只选择公开题目与引用。
export const followUpQuestionDraftSchema = z
  .object({
    question: z.string().trim().min(1).max(1_000),
    rubric: z.array(z.string().trim().min(1).max(500)).min(1).max(5),
    criterionId: entityIdSchema,
    source: z
      .object({
        taskId: entityIdSchema,
        submissionId: entityIdSchema,
        noteRunId: entityIdSchema,
        reportId: entityIdSchema,
        repositoryId: entityIdSchema,
        commitSha: noteCitationSchema.shape.commitSha,
        path: noteCitationSchema.shape.path,
        contentHash: noteCitationSchema.shape.contentHash,
      })
      .strict(),
    citations: z.array(noteCitationSchema).min(1).max(3),
  })
  .strict()

export const followUpGenerationStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('READY') }).strict(),
  z
    .object({ status: z.literal('SKIPPED'), reason: z.literal('NOTE_CRITERIA_NOT_PASSED') })
    .strict(),
  z.object({ status: z.literal('FAILED'), code: z.string().min(1).max(64) }).strict(),
])
export type FollowUpGenerationState = z.infer<typeof followUpGenerationStateSchema>
