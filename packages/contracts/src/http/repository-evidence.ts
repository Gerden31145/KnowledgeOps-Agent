import { z } from 'zod'
import { markdownTargetPathSchema } from '../domain/plan.js'
import { entityIdSchema, isoDateTimeSchema } from '../shared/primitives.js'

export const REPOSITORY_EVIDENCE_LIMIT = 20
export const repositoryEvidenceStatusSchema = z.enum([
  'PENDING',
  'RETRYING',
  'FAILED',
  'RESYNC_REQUIRED',
  'DISPATCH_FAILED',
  'IGNORED',
  'COLLECTED',
])
export const repositoryEvidenceResponseSchema = z
  .object({
    repositoryId: entityIdSchema,
    deliveries: z
      .array(
        z
          .object({
            deliveryId: entityIdSchema,
            taskId: entityIdSchema.nullable(),
            targetPath: markdownTargetPathSchema.nullable(),
            commitSha: z.string().regex(/^[0-9a-f]{40}$/),
            receivedAt: isoDateTimeSchema,
            attemptCount: z.number().int().nonnegative(),
            canRetry: z.boolean(),
            canResync: z.boolean(),
            lastAttemptAt: isoDateTimeSchema.nullable(),
            status: repositoryEvidenceStatusSchema,
            message: z.string().min(1).max(240),
          })
          .strict()
          .refine(
            (item) =>
              (item.taskId !== null && item.targetPath !== null) ||
              (item.taskId === null &&
                item.targetPath === null &&
                item.status === 'IGNORED' &&
                item.attemptCount === 0 &&
                item.lastAttemptAt === null &&
                !item.canRetry &&
                !item.canResync),
            { message: 'Unassociated notifications must be ignored without recovery.' },
          ),
      )
      .max(REPOSITORY_EVIDENCE_LIMIT),
  })
  .strict()

export type RepositoryEvidenceStatus = z.infer<typeof repositoryEvidenceStatusSchema>
export type RepositoryEvidenceResponse = z.infer<typeof repositoryEvidenceResponseSchema>

export const retryRepositoryEvidenceInputSchema = z
  .object({
    expectedAttemptCount: z.number().int().positive(),
  })
  .strict()
export const retryRepositoryEvidenceResponseSchema = z
  .object({
    deliveryId: entityIdSchema,
    retryEventId: entityIdSchema,
    status: z.literal('ACCEPTED'),
  })
  .strict()
export type RetryRepositoryEvidenceInput = z.infer<typeof retryRepositoryEvidenceInputSchema>
export type RetryRepositoryEvidenceResponse = z.infer<typeof retryRepositoryEvidenceResponseSchema>
