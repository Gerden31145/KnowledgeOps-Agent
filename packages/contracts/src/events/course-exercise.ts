import { z } from 'zod'

import { entityIdSchema } from '../shared/primitives.js'

export const COURSE_EXERCISE_QUEUE_NAME = 'course-exercise'
export const COURSE_EXERCISE_JOB_NAME = 'verify-course-exercise'
export const COURSE_EXERCISE_JOB_ID_PREFIX = 'course-exercise-'
export const COURSE_EXERCISE_OUTBOX_SCHEMA_VERSION = 1

export const courseExerciseRequestedEventPayloadSchema = z
  .object({ submissionId: entityIdSchema })
  .strict()

export function buildCourseExerciseJobId(submissionId: string): string {
  return `${COURSE_EXERCISE_JOB_ID_PREFIX}${entityIdSchema.parse(submissionId)}`
}

export type CourseExerciseRequestedEventPayload = z.infer<
  typeof courseExerciseRequestedEventPayloadSchema
>
