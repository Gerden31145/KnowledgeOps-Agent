import {
  acceptanceCriterionTypeSchema,
  criterionResultSchema,
  entityIdSchema,
  noteCitationSchema,
  planGenerationModelSnapshotSchema,
} from '@knowledgeops/contracts'
import { z } from 'zod'

export const noteSemanticCriterionTypeSchema = acceptanceCriterionTypeSchema.extract([
  'SEMANTIC_CORRECTNESS',
  'TOPIC_COVERAGE',
  'EXPLANATION_QUALITY',
])

// 模型只提供原文行范围和引文；来源由调用方绑定的固定证据决定。
// 这里的大小上限约束候选形状，模型调用/Token/耗时预算由后续执行层管理。
export const noteVerificationCandidateSchema = z
  .object({
    results: z
      .array(
        criterionResultSchema.extend({
          rationale: z.string().trim().min(1).max(2_000),
          suggestions: z.array(z.string().trim().min(1).max(500)).max(5),
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
            .max(3),
        }),
      )
      .max(6),
  })
  .strict()

export type NoteVerificationCandidate = z.infer<typeof noteVerificationCandidateSchema>

export const NOTE_VERIFICATION_PROMPT_VERSION = 'note-verification-v2'
export const NOTE_VERIFICATION_OUTPUT_SCHEMA_VERSION = 'note-verification-output-v1'

export const noteVerificationRequestSchema = z
  .object({
    runId: entityIdSchema,
    // 复用既有快照字段形状，验收版本单独校验，不沿用计划生成的 v2 版本值。
    model: planGenerationModelSnapshotSchema,
    task: z
      .object({
        id: entityIdSchema,
        title: z.string().trim().min(1).max(160),
        description: z.string().trim().min(1).max(1_000),
      })
      .strict(),
    criteria: z
      .array(
        z
          .object({
            id: entityIdSchema,
            type: noteSemanticCriterionTypeSchema,
            description: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(6),
    note: z
      .object({
        repositoryId: noteCitationSchema.shape.repositoryId,
        commitSha: noteCitationSchema.shape.commitSha,
        path: noteCitationSchema.shape.path,
        contentHash: noteCitationSchema.shape.contentHash,
        lines: z.array(z.string()).max(20_000),
      })
      .strict(),
  })
  .strict()
  .refine(
    (request) =>
      new Set(request.criteria.map((criterion) => criterion.id)).size === request.criteria.length,
    { message: 'Duplicate criterion IDs', path: ['criteria'] },
  )

export type NoteVerificationRequest = z.infer<typeof noteVerificationRequestSchema>
export interface NoteVerificationOptions {
  signal: AbortSignal
  maxOutputTokens: number
  // 只传安全错误类别，不回灌供应商错误正文或未经验证的模型回答。
  repairReason?: 'MODEL_OUTPUT_INVALID' | 'INVALID_MODEL_OUTPUT' | 'INVALID_MODEL_CITATION'
}
export type NoteVerificationUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}
export interface NoteVerificationResponse {
  candidate: NoteVerificationCandidate
  // null 表示供应商未提供完整、有效用量；不能当作 0 Token。
  usage: NoteVerificationUsage | null
}
export interface NoteVerificationPort {
  verify(
    request: NoteVerificationRequest,
    options: NoteVerificationOptions,
  ): Promise<NoteVerificationResponse>
}
