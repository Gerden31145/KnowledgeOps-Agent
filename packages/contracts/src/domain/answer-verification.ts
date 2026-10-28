import { z } from 'zod'
import { entityIdSchema } from '../shared/primitives.js'
import { criterionResultSchema } from './note-verification.js'

// 回答来自不可覆盖的 AnswerSubmission，不伪造仓库路径或 Commit。
export const answerCitationSchema = z
  .object({
    answerSubmissionId: entityIdSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    excerpt: z.string().min(1).max(4_000),
  })
  .strict()
  .refine((value) => value.endLine >= value.startLine)

export const answerVerificationResultSchema = criterionResultSchema.extend({
  questionId: entityIdSchema,
  answerSubmissionId: entityIdSchema,
  answerCitations: z.array(answerCitationSchema).max(3),
})
export type AnswerVerificationResult = z.infer<typeof answerVerificationResultSchema>
