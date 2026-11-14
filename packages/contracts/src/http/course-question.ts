import { z } from 'zod'

import { entityIdSchema, isoDateTimeSchema } from '../shared/primitives.js'

export const COURSE_QUESTION_DEPTHS = ['QUICK', 'CONTEXTUAL', 'DEEP'] as const
export const COURSE_QUESTION_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED'] as const

export const courseQuestionDepthSchema = z.enum(COURSE_QUESTION_DEPTHS)
export const courseQuestionStatusSchema = z.enum(COURSE_QUESTION_STATUSES)

export const askCourseQuestionInputSchema = z
  .object({
    requestId: entityIdSchema,
    sectionId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    selectedText: z.string().trim().min(2).max(2_000),
    question: z.string().trim().min(2).max(1_000),
    depth: courseQuestionDepthSchema.default('CONTEXTUAL'),
  })
  .strict()

export const courseQuestionSchema = z
  .object({
    id: entityIdSchema,
    sectionId: z.string(),
    selectedText: z.string(),
    question: z.string(),
    depth: courseQuestionDepthSchema,
    status: courseQuestionStatusSchema,
    answer: z.string().nullable(),
    createdAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema.nullable(),
  })
  .strict()

export const courseQuestionHistoryResponseSchema = z
  .object({ questions: z.array(courseQuestionSchema).max(50) })
  .strict()

export type CourseQuestionDepth = z.infer<typeof courseQuestionDepthSchema>
export type CourseQuestionStatus = z.infer<typeof courseQuestionStatusSchema>
export type AskCourseQuestionInput = z.infer<typeof askCourseQuestionInputSchema>
export type CourseQuestion = z.infer<typeof courseQuestionSchema>
export type CourseQuestionHistoryResponse = z.infer<typeof courseQuestionHistoryResponseSchema>
