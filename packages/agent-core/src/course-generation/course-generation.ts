import {
  courseKnowledgePointSchema,
  courseLearningPackageSchema,
  entityIdSchema,
  planGenerationModelSnapshotSchema,
} from '@knowledgeops/contracts'
import { z } from 'zod'

export {
  COURSE_GENERATION_OUTPUT_SCHEMA_VERSION,
  COURSE_GENERATION_PROMPT_VERSION,
} from '@knowledgeops/contracts'

export const courseGenerationRequestSchema = z
  .object({
    generationRunId: entityIdSchema,
    model: planGenerationModelSnapshotSchema,
    goal: z
      .object({
        title: z.string().trim().min(1).max(160),
        currentLevel: z.string().trim().min(1).max(500),
      })
      .strict(),
    course: z
      .object({
        taskId: entityIdSchema,
        title: z.string().trim().min(3).max(160),
        description: z.string().trim().min(10).max(1_000),
        estimatedMinutes: z.number().int().min(15).max(480),
        knowledgePoints: z.array(courseKnowledgePointSchema).min(1).max(4),
      })
      .strict(),
    review: z
      .array(
        z
          .object({
            knowledgePointId: entityIdSchema,
            key: z.string().trim().min(1).max(64),
            title: z.string().trim().min(2).max(120),
            mastery: z.enum(['WEAK', 'DEVELOPING']),
            misconceptionTags: z.array(z.string().trim().min(1).max(100)).max(3),
          })
          .strict(),
      )
      .max(2),
  })
  .strict()

export interface CourseGenerationOptions {
  signal?: AbortSignal
}

export interface CourseGenerationPort {
  generate(request: CourseGenerationRequest, options?: CourseGenerationOptions): Promise<unknown>
}

export class InvalidCourseGenerationRequestError extends Error {
  override readonly name = 'InvalidCourseGenerationRequestError'
}

export class InvalidCourseGenerationOutputError extends Error {
  override readonly name = 'InvalidCourseGenerationOutputError'
}

export type CourseGenerationRequest = z.infer<typeof courseGenerationRequestSchema>
export type CourseGenerationOutput = z.infer<typeof courseLearningPackageSchema>

export async function generateCourseCandidate(
  port: CourseGenerationPort,
  request: unknown,
  options?: CourseGenerationOptions,
): Promise<CourseGenerationOutput> {
  const parsedRequest = courseGenerationRequestSchema.safeParse(request)
  if (!parsedRequest.success) throw new InvalidCourseGenerationRequestError()

  const candidate = await port.generate(parsedRequest.data, options)
  const parsedCandidate = courseLearningPackageSchema.safeParse(candidate)
  if (!parsedCandidate.success) throw new InvalidCourseGenerationOutputError()

  const knowledgePointIds = new Set(
    parsedRequest.data.course.knowledgePoints.map((point) => point.id),
  )
  const referencedIds = [
    ...parsedCandidate.data.exercises.multipleChoice.map((question) => question.knowledgePointId),
    ...parsedCandidate.data.exercises.followUp.knowledgePointIds,
  ]
  if (referencedIds.some((id) => !knowledgePointIds.has(id)))
    throw new InvalidCourseGenerationOutputError()

  return parsedCandidate.data
}
