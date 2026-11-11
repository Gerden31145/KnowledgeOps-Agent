import { z } from 'zod'

import { entityIdSchema } from '../shared/primitives.js'

export const COURSE_GENERATION_QUEUE_NAME = 'course-generation'
export const COURSE_GENERATION_JOB_NAME = 'generate-course'
export const COURSE_GENERATION_JOB_ID_PREFIX = 'course-generation-'
export const COURSE_GENERATION_OUTBOX_SCHEMA_VERSION = 1

export const courseGenerationRequestedEventPayloadSchema = z
  .object({
    generationRunId: entityIdSchema,
  })
  .strict()

export function buildCourseGenerationJobId(generationRunId: string): string {
  return `${COURSE_GENERATION_JOB_ID_PREFIX}${entityIdSchema.parse(generationRunId)}`
}

export type CourseGenerationRequestedEventPayload = z.infer<
  typeof courseGenerationRequestedEventPayloadSchema
>
