import { z } from 'zod'

import { planGenerationRunStateSchema } from '../domain/plan-generation-run-state.js'
import { entityIdSchema } from '../shared/primitives.js'

export const requestCourseGenerationInputSchema = z
  .object({
    retryOfRunId: entityIdSchema.optional(),
  })
  .strict()

export const courseGenerationAcceptedResponseSchema = z
  .object({
    generationRunId: entityIdSchema,
    status: planGenerationRunStateSchema.extract(['QUEUED', 'RUNNING']),
  })
  .strict()

export type RequestCourseGenerationInput = z.infer<typeof requestCourseGenerationInputSchema>
export type CourseGenerationAcceptedResponse = z.infer<
  typeof courseGenerationAcceptedResponseSchema
>
