import { z } from 'zod'
import { entityIdSchema } from '@knowledgeops/contracts'
import { noteVerificationRequestSchema, type NoteVerificationUsage } from './note-verification.js'

// 一次只生成一道题；Rubric 是后续回答验收使用的评分要点，不是已通过的结论。
// 模型不能选择 taskId、Submission、报告或 Commit，这些由 Worker 从原运行绑定。
export const followUpQuestionCandidateSchema = z
  .object({
    question: z.string().trim().min(1).max(1_000),
    rubric: z.array(z.string().trim().min(1).max(500)).min(1).max(5),
    citations: z
      .array(
        z
          .object({
            startLine: z.number().int().positive(),
            endLine: z.number().int().positive(),
            excerpt: z.string().max(4_000),
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict()

export type FollowUpQuestionCandidate = z.infer<typeof followUpQuestionCandidateSchema>

export const FOLLOW_UP_PROMPT_VERSION = 'follow-up-v2'
export const FOLLOW_UP_OUTPUT_SCHEMA_VERSION = 'follow-up-output-v1'

// 复用固定笔记/任务/模型的形状；出题只接收一个 FOLLOW_UP_ANSWER 标准。
export const followUpGenerationRequestSchema = z
  .object({
    runId: entityIdSchema,
    model: noteVerificationRequestSchema.shape.model,
    task: noteVerificationRequestSchema.shape.task,
    note: noteVerificationRequestSchema.shape.note,
    criterion: z
      .object({
        id: entityIdSchema,
        type: z.literal('FOLLOW_UP_ANSWER'),
        description: z.string().trim().min(1).max(500),
      })
      .strict(),
  })
  .strict()

export type FollowUpGenerationRequest = z.infer<typeof followUpGenerationRequestSchema>
export interface FollowUpGenerationOptions {
  signal: AbortSignal
  maxOutputTokens: number
  // 仅在外层预算允许修复时传安全错误类别，不传原始模型错误或坏候选。
  repairReason?: 'MODEL_OUTPUT_INVALID' | 'INVALID_FOLLOW_UP_OUTPUT' | 'INVALID_FOLLOW_UP_CITATION'
}
export interface FollowUpGenerationPort {
  generate(
    request: FollowUpGenerationRequest,
    options: FollowUpGenerationOptions,
  ): Promise<{ candidate: FollowUpQuestionCandidate; usage: NoteVerificationUsage | null }>
}
