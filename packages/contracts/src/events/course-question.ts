import { z } from 'zod'

import { entityIdSchema } from '../shared/primitives.js'

export const COURSE_QUESTION_QUEUE_NAME = 'course-question'
export const COURSE_QUESTION_JOB_NAME = 'answer-course-question'
export const COURSE_QUESTION_JOB_ID_PREFIX = 'course-question-'
export const COURSE_QUESTION_OUTBOX_SCHEMA_VERSION = 1

export const courseQuestionRequestedEventPayloadSchema = z
  .object({ questionId: entityIdSchema })
  .strict()

export function buildCourseQuestionJobId(questionId: string): string {
  return `${COURSE_QUESTION_JOB_ID_PREFIX}${entityIdSchema.parse(questionId)}`
}

export type CourseQuestionRequestedEventPayload = z.infer<
  typeof courseQuestionRequestedEventPayloadSchema
>
