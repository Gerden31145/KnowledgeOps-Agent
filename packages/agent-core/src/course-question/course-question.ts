import { courseQuestionDepthSchema, courseSectionSchema } from '@knowledgeops/contracts'
import { z } from 'zod'

export const COURSE_QUESTION_PROMPT_VERSION = 'course-question-v1'
export const COURSE_QUESTION_OUTPUT_SCHEMA_VERSION = 'course-question-output-v1'

export const COURSE_QUESTION_POLICIES = {
  QUICK: {
    historyLimit: 0,
    maxAnswerCharacters: 500,
    maxOutputTokens: 512,
    instruction:
      'Answer directly and briefly. Clarify only the selected concept and at most one necessary caveat. Do not use headings or expand into a full lesson.',
  },
  CONTEXTUAL: {
    historyLimit: 4,
    maxAnswerCharacters: 1_500,
    maxOutputTokens: 1_024,
    instruction:
      'Answer in 2-4 short paragraphs. Explain the concept, connect it to the supplied development scenario, and include one short example only when it helps.',
  },
  DEEP: {
    historyLimit: 6,
    maxAnswerCharacters: 3_500,
    maxOutputTokens: 2_048,
    instruction:
      'Give a structured explanation with core mechanism, development scenario, and boundaries or misconceptions. Include a small code example when useful, without turning the answer into a broad curriculum.',
  },
} as const

export const courseQuestionAnswerSchema = z
  .object({ answer: z.string().trim().min(1).max(3_500) })
  .strict()

export const courseQuestionModelSchema = z
  .object({
    catalogId: z.string().trim().min(1).max(100),
    provider: z.literal('openai'),
    modelName: z.string().trim().min(1).max(160),
    reasoningEffort: z.enum(['low', 'high', 'max']).nullable(),
  })
  .strict()

export const courseQuestionRequestSchema = z
  .object({
    model: courseQuestionModelSchema,
    goal: z.string().trim().min(1).max(160),
    course: z
      .object({
        title: z.string().trim().min(1).max(160),
        description: z.string().trim().min(1).max(1_000),
      })
      .strict(),
    section: courseSectionSchema,
    selectedText: z.string().trim().min(2).max(2_000),
    question: z.string().trim().min(2).max(1_000),
    depth: courseQuestionDepthSchema,
    history: z
      .array(z.object({ question: z.string().max(1_000), answer: z.string().max(3_500) }).strict())
      .max(6),
  })
  .strict()

export interface CourseQuestionOptions {
  signal?: AbortSignal
}

export interface CourseQuestionPort {
  answer(request: CourseQuestionRequest, options?: CourseQuestionOptions): Promise<unknown>
}

export class InvalidCourseQuestionRequestError extends Error {
  override readonly name = 'InvalidCourseQuestionRequestError'
}

export class InvalidCourseQuestionAnswerError extends Error {
  override readonly name = 'InvalidCourseQuestionAnswerError'
}

export type CourseQuestionRequest = z.infer<typeof courseQuestionRequestSchema>
export type CourseQuestionAnswer = z.infer<typeof courseQuestionAnswerSchema>

export async function generateCourseQuestionAnswer(
  port: CourseQuestionPort,
  request: unknown,
  options?: CourseQuestionOptions,
): Promise<CourseQuestionAnswer> {
  const parsedRequest = courseQuestionRequestSchema.safeParse(request)
  if (!parsedRequest.success) throw new InvalidCourseQuestionRequestError()
  const policy = COURSE_QUESTION_POLICIES[parsedRequest.data.depth]
  if (parsedRequest.data.history.length > policy.historyLimit)
    throw new InvalidCourseQuestionRequestError()

  const parsedAnswer = courseQuestionAnswerSchema.safeParse(
    await port.answer(parsedRequest.data, options),
  )
  if (!parsedAnswer.success || parsedAnswer.data.answer.length > policy.maxAnswerCharacters)
    throw new InvalidCourseQuestionAnswerError()
  return parsedAnswer.data
}
