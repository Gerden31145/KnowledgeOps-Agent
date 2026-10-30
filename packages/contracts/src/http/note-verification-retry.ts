import { z } from 'zod'
import { entityIdSchema } from '../shared/primitives.js'

export const retryNoteVerificationInputSchema = z
  .object({
    expectedRunVersion: z.number().int().nonnegative().max(2_147_483_646),
    expectedTaskVersion: z.number().int().nonnegative().max(2_147_483_646),
  })
  .strict()
export type RetryNoteVerificationInput = z.infer<typeof retryNoteVerificationInputSchema>

export const retryNoteVerificationResponseSchema = z
  .object({
    status: z.literal('ACCEPTED'),
    runId: entityIdSchema,
    retryOfRunId: entityIdSchema,
    taskId: entityIdSchema,
    taskVersion: z.number().int().nonnegative(),
  })
  .strict()
export type RetryNoteVerificationResponse = z.infer<typeof retryNoteVerificationResponseSchema>
