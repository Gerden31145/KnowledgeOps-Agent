import { z } from 'zod'
import { entityIdSchema, followUpQuestionDraftSchema } from '@knowledgeops/contracts'
import {
  noteVerificationCandidateSchema,
  noteVerificationRequestSchema,
  type NoteVerificationUsage,
} from '../note-verification/note-verification.js'

export const ANSWER_VERIFICATION_PROMPT_VERSION = 'answer-verification-v2'
export const ANSWER_VERIFICATION_OUTPUT_SCHEMA_VERSION = 'answer-verification-output-v1'

const boundedResult = noteVerificationCandidateSchema.shape.results.element
// 模型只判断这一道题；来源标识由执行入口补入，模型不能选择另一份回答。
export const answerVerificationCandidateSchema = boundedResult
  .omit({ criterionId: true })
  .extend({ answerCitations: boundedResult.shape.citations })
  .refine((result) => result.outcome === 'PASSED' || result.suggestions.length > 0, {
    message: 'An unsuccessful answer needs an actionable suggestion',
    path: ['suggestions'],
  })
export type AnswerVerificationCandidate = z.infer<typeof answerVerificationCandidateSchema>

export const answerVerificationRequestSchema = z
  .object({
    runId: entityIdSchema,
    model: noteVerificationRequestSchema.shape.model,
    task: noteVerificationRequestSchema.shape.task,
    note: noteVerificationRequestSchema.shape.note,
    question: followUpQuestionDraftSchema.extend({ id: entityIdSchema }),
    answer: z
      .object({
        id: entityIdSchema,
        questionId: entityIdSchema,
        // 保留已保存的原文；不能在引用核对前再次 trim 或改写换行。
        content: z
          .string()
          .min(1)
          .max(8_000)
          .refine((text) => text.trim().length > 0),
      })
      .strict(),
  })
  .strict()
export type AnswerVerificationRequest = z.infer<typeof answerVerificationRequestSchema>
export interface AnswerVerificationOptions {
  signal: AbortSignal
  maxOutputTokens: number
  repairReason?: 'MODEL_OUTPUT_INVALID' | 'INVALID_ANSWER_OUTPUT' | 'INVALID_ANSWER_CITATION'
}
export interface AnswerVerificationPort {
  verify(
    request: AnswerVerificationRequest,
    options: AnswerVerificationOptions,
  ): Promise<{ candidate: AnswerVerificationCandidate; usage: NoteVerificationUsage | null }>
}
