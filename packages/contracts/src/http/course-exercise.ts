import { z } from 'zod'

import { courseReferenceIdSchema } from '../domain/course.js'
import { entityIdSchema, isoDateTimeSchema } from '../shared/primitives.js'

export const COURSE_EXERCISE_SUBMISSION_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
] as const
export const COURSE_FOLLOW_UP_OUTCOMES = ['PASSED', 'FAILED', 'INSUFFICIENT_EVIDENCE'] as const

export const courseExerciseSubmissionStatusSchema = z.enum(COURSE_EXERCISE_SUBMISSION_STATUSES)
export const courseFollowUpOutcomeSchema = z.enum(COURSE_FOLLOW_UP_OUTCOMES)
export const multipleChoiceAnswerSchema = z
  .object({ questionId: courseReferenceIdSchema, optionId: courseReferenceIdSchema })
  .strict()
export const courseExerciseAnswersSchema = z
  .object({
    multipleChoiceAnswers: z.array(multipleChoiceAnswerSchema).length(4),
    followUpAnswer: z.string().trim().min(2).max(8_000),
  })
  .strict()
  .superRefine((answers, context) => {
    const ids = answers.multipleChoiceAnswers.map((answer) => answer.questionId)
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', message: 'Question IDs must be unique' })
  })
export const submitCourseExerciseInputSchema = courseExerciseAnswersSchema
  .extend({ requestId: entityIdSchema, expectedTaskVersion: z.number().int().nonnegative() })
  .strict()

export const multipleChoiceResultSchema = z
  .object({
    questionId: courseReferenceIdSchema,
    selectedOptionId: courseReferenceIdSchema,
    correctOptionId: courseReferenceIdSchema,
    correct: z.boolean(),
    explanation: z.string(),
  })
  .strict()
export const courseFollowUpEvaluationSchema = z
  .object({
    outcome: courseFollowUpOutcomeSchema,
    rationale: z.string().trim().min(1).max(2_000),
    suggestions: z.array(z.string().trim().min(1).max(500)).max(4),
  })
  .strict()
  .superRefine((evaluation, context) => {
    if (evaluation.outcome !== 'PASSED' && evaluation.suggestions.length === 0)
      context.addIssue({
        code: 'custom',
        message: 'A non-passing answer needs an actionable suggestion',
        path: ['suggestions'],
      })
  })
export const courseExerciseReportSchema = z
  .object({
    multipleChoice: z.array(multipleChoiceResultSchema).length(4),
    correctCount: z.number().int().min(0).max(4),
    followUp: courseFollowUpEvaluationSchema,
    passed: z.boolean(),
  })
  .strict()
export const courseExerciseSubmissionSchema = z
  .object({
    id: entityIdSchema,
    status: courseExerciseSubmissionStatusSchema,
    answers: courseExerciseAnswersSchema,
    report: courseExerciseReportSchema.nullable(),
    errorCode: z.string().nullable(),
    createdAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema.nullable(),
  })
  .strict()
export const courseExerciseSubmissionHistoryResponseSchema = z
  .object({ submissions: z.array(courseExerciseSubmissionSchema).max(20) })
  .strict()

export type CourseExerciseSubmissionStatus = z.infer<typeof courseExerciseSubmissionStatusSchema>
export type CourseExerciseAnswers = z.infer<typeof courseExerciseAnswersSchema>
export type SubmitCourseExerciseInput = z.infer<typeof submitCourseExerciseInputSchema>
export type CourseExerciseReport = z.infer<typeof courseExerciseReportSchema>
export type CourseFollowUpEvaluation = z.infer<typeof courseFollowUpEvaluationSchema>
export type CourseExerciseSubmission = z.infer<typeof courseExerciseSubmissionSchema>
export type CourseExerciseSubmissionHistoryResponse = z.infer<
  typeof courseExerciseSubmissionHistoryResponseSchema
>
