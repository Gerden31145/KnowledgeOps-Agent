import { z } from 'zod'
import { markdownTargetPathSchema } from '../domain/plan.js'
import { githubIdSchema } from '../http/repository.js'
import { entityIdSchema, isoDateTimeSchema } from '../shared/primitives.js'

// v1 only saved bindings[]; v2 freezes the task selected at receipt as well.
// Never reconstruct an old event's missing task from the user's current task.
export const GITHUB_PUSH_RECEIVED_SCHEMA_VERSION = 2
export const GITHUB_EVIDENCE_QUEUE_NAME = 'github-evidence'
export const GITHUB_EVIDENCE_JOB_NAME = 'collect-github-evidence'

// Redis 只传定位记录的 ID；任务快照和 Push 从数据库的原接收记录恢复。
export const githubEvidenceJobPayloadSchema = z
  .object({
    eventId: entityIdSchema,
    deliveryId: entityIdSchema,
    retryEventId: entityIdSchema.optional(),
  })
  .strict()
export type GitHubEvidenceJobPayload = z.infer<typeof githubEvidenceJobPayloadSchema>

export function buildGitHubEvidenceJobId(deliveryId: string, retryEventId?: string): string {
  const original = `evidence-${entityIdSchema.parse(deliveryId)}`
  return retryEventId ? `${original}-retry-${entityIdSchema.parse(retryEventId)}` : original
}

// 只允许修复外部条件后仍可用原材料重试的失败；基准缺失、任务变化和坏输入不在其中。
export const retryableEvidenceFailureSchema = z.enum([
  'GITHUB_UNAVAILABLE',
  'GITHUB_AUTH_REQUIRED',
  'SOURCE_UNAVAILABLE',
  'INVALID_GITHUB_RESPONSE',
  'EVIDENCE_PROCESSING_FAILED',
])
export const GITHUB_EVIDENCE_RETRY_SCHEMA_VERSION = 2
const legacyEvidenceRetryPayloadSchema = z
  .object({
    deliveryId: entityIdSchema,
    sourceEventId: entityIdSchema,
    previousAttemptCount: z.number().int().positive(),
    previousErrorCode: retryableEvidenceFailureSchema,
    previousFailedAt: isoDateTimeSchema,
  })
  .strict()
// v2 冻结取证模式。旧 v1 只能还原为 DIFF，不能凭缺失字段推断为快照。
export const githubEvidenceRetryPayloadSchema = legacyEvidenceRetryPayloadSchema
  .extend({
    evidenceMode: z.enum(['DIFF', 'SNAPSHOT']),
    previousErrorCode: z.union([retryableEvidenceFailureSchema, z.literal('RESYNC_REQUIRED')]),
  })
  .refine(
    (value) => value.evidenceMode === 'SNAPSHOT' || value.previousErrorCode !== 'RESYNC_REQUIRED',
  )
export type GitHubEvidenceRetryPayload = z.infer<typeof githubEvidenceRetryPayloadSchema>
export const githubEvidenceRetryEventSchema = z.discriminatedUnion('schemaVersion', [
  z.object({
    schemaVersion: z.literal(1),
    payload: legacyEvidenceRetryPayloadSchema.transform((value) => ({
      ...value,
      evidenceMode: 'DIFF' as const,
    })),
  }),
  z.object({ schemaVersion: z.literal(2), payload: githubEvidenceRetryPayloadSchema }),
])

export function buildGitHubEvidenceRetryKey(deliveryId: string, attemptCount: number): string {
  return `github-evidence-retry-${entityIdSchema.parse(deliveryId)}-${z.number().int().positive().parse(attemptCount)}`
}

const id = z.union([githubIdSchema, z.number().int().positive().safe().transform(String)])
const sha = z
  .string()
  .regex(/^[a-fA-F0-9]{40}$/)
  .transform((value) => value.toLowerCase())

// 接收和消费共用最小 Push 契约；仍剥离 sender、commit message 等非必要字段。
export const githubPushPayloadSchema = z.object({
  installation: z.object({ id }),
  repository: z.object({ id }),
  ref: z.string().min(1).max(1024),
  before: sha,
  after: sha,
  deleted: z.boolean(),
  forced: z.boolean(),
})

export const githubPushReceivedEventPayloadSchema = z
  .object({
    deliveryId: entityIdSchema,
    binding: z
      .object({
        repositoryId: entityIdSchema,
        userId: entityIdSchema,
        repositoryVersion: z.number().int().nonnegative(),
      })
      .strict(),
    task: z
      .object({
        taskId: entityIdSchema,
        taskVersion: z.number().int().nonnegative(),
        targetPath: markdownTargetPathSchema,
      })
      .strict(),
  })
  .strict()

export type GitHubPushReceivedEventPayload = z.infer<typeof githubPushReceivedEventPayloadSchema>
