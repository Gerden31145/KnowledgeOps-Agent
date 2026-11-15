import {
  courseExerciseReportSchema,
  courseFollowUpEvaluationSchema,
  courseSectionSchema,
  exerciseSetBodySchema,
  followUpExerciseSchema,
  multipleChoiceAnswerSchema,
  type CourseExerciseAnswers,
  type CourseExerciseReport,
  type CourseFollowUpEvaluation,
} from '@knowledgeops/contracts'
import { z } from 'zod'

export const COURSE_EXERCISE_PROMPT_VERSION = 'course-exercise-v1'
export const COURSE_EXERCISE_OUTPUT_SCHEMA_VERSION = 'course-exercise-output-v1'

export class InvalidCourseExerciseAnswersError extends Error {
  override readonly name = 'InvalidCourseExerciseAnswersError'
}
export class InvalidCourseExerciseEvaluationError extends Error {
  override readonly name = 'InvalidCourseExerciseEvaluationError'
}

export const courseFollowUpVerificationRequestSchema = z
  .object({
    model: z
      .object({
        catalogId: z.string().trim().min(1).max(100),
        provider: z.literal('openai'),
        modelName: z.string().trim().min(1).max(160),
        reasoningEffort: z.enum(['low', 'high', 'max']).nullable(),
      })
      .strict(),
    course: z
      .object({
        title: z.string().trim().min(1).max(160),
        description: z.string().trim().min(1).max(1_000),
        sections: z.array(courseSectionSchema).min(3).max(6),
      })
      .strict(),
    question: followUpExerciseSchema,
    answer: z.string().min(2).max(8_000),
  })
  .strict()

export type CourseFollowUpVerificationRequest = z.infer<
  typeof courseFollowUpVerificationRequestSchema
>
export interface CourseExerciseVerificationOptions {
  signal?: AbortSignal
}
export interface CourseExerciseVerificationPort {
  verify(
    request: CourseFollowUpVerificationRequest,
    options?: CourseExerciseVerificationOptions,
  ): Promise<unknown>
}

export function gradeCourseMultipleChoice(exerciseSet: unknown, answers: unknown) {
  const exercises = exerciseSetBodySchema.parse(exerciseSet)
  const selected = z.array(multipleChoiceAnswerSchema).length(4).parse(answers)
  const questionIds = new Set(selected.map((answer) => answer.questionId))
  if (
    questionIds.size !== exercises.multipleChoice.length ||
    exercises.multipleChoice.some((question) => !questionIds.has(question.id))
  )
    throw new InvalidCourseExerciseAnswersError('Every question needs exactly one answer')

  const results = exercises.multipleChoice.map((question) => {
    const answer = selected.find((item) => item.questionId === question.id)!
    if (!question.options.some((option) => option.id === answer.optionId))
      throw new InvalidCourseExerciseAnswersError('Selected option does not belong to the question')
    return {
      questionId: question.id,
      selectedOptionId: answer.optionId,
      correctOptionId: question.correctOptionId,
      correct: answer.optionId === question.correctOptionId,
      explanation: question.explanation,
    }
  })
  return {
    multipleChoice: results,
    correctCount: results.filter((result) => result.correct).length,
  }
}

export function buildCourseExerciseReport(
  exerciseSet: unknown,
  answers: CourseExerciseAnswers,
  followUp: CourseFollowUpEvaluation,
): CourseExerciseReport {
  const graded = gradeCourseMultipleChoice(exerciseSet, answers.multipleChoiceAnswers)
  return courseExerciseReportSchema.parse({
    ...graded,
    followUp,
    passed: graded.correctCount >= 3 && followUp.outcome === 'PASSED',
  })
}

export async function evaluateCourseFollowUpAnswer(
  port: CourseExerciseVerificationPort,
  request: unknown,
  options?: CourseExerciseVerificationOptions,
): Promise<CourseFollowUpEvaluation> {
  const parsed = courseFollowUpVerificationRequestSchema.safeParse(request)
  if (!parsed.success) throw new InvalidCourseExerciseEvaluationError('Invalid evaluation request')
  const evaluated = courseFollowUpEvaluationSchema.safeParse(
    await port.verify(parsed.data, options),
  )
  if (!evaluated.success)
    throw new InvalidCourseExerciseEvaluationError('Invalid follow-up evaluation')
  return evaluated.data
}
