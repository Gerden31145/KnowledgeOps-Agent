import { z } from 'zod'

import { entityIdSchema } from '../shared/primitives.js'

export const COURSE_GENERATION_PROMPT_VERSION = 'course-generation-v1'
export const COURSE_GENERATION_OUTPUT_SCHEMA_VERSION = 'course-generation-output-v1'
export const COURSE_STATUSES = ['PENDING', 'GENERATING', 'READY', 'FAILED'] as const
export const COURSE_KNOWLEDGE_ROLES = ['TEACH', 'REVIEW'] as const

export const courseStatusSchema = z.enum(COURSE_STATUSES)
export const courseKnowledgeRoleSchema = z.enum(COURSE_KNOWLEDGE_ROLES)
export const courseReferenceIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/)
  .describe('A stable lowercase identifier local to the plan or learning package')

export const courseKnowledgePointSchema = z
  .object({
    id: courseReferenceIdSchema,
    title: z.string().trim().min(2).max(120),
    description: z.string().trim().min(5).max(500),
  })
  .strict()

export const courseSectionSchema = z
  .object({
    id: courseReferenceIdSchema,
    title: z.string().trim().min(2).max(160),
    explanation: z.string().trim().min(20).max(4_000),
    scenario: z.string().trim().min(10).max(2_000),
    example: z.string().trim().min(5).max(2_000),
    misconception: z.string().trim().min(5).max(1_000),
  })
  .strict()

export const multipleChoiceQuestionSchema = z
  .object({
    id: courseReferenceIdSchema,
    knowledgePointId: courseReferenceIdSchema,
    prompt: z.string().trim().min(5).max(1_000),
    options: z
      .array(
        z
          .object({
            id: courseReferenceIdSchema,
            text: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .length(4),
    correctOptionId: courseReferenceIdSchema,
    explanation: z.string().trim().min(5).max(1_000),
  })
  .strict()
  .superRefine((question, context) => {
    const optionIds = new Set(question.options.map((option) => option.id))
    if (optionIds.size !== question.options.length) {
      context.addIssue({
        code: 'custom',
        message: 'Option IDs must be unique within a question',
        path: ['options'],
      })
    }
    if (!optionIds.has(question.correctOptionId)) {
      context.addIssue({
        code: 'custom',
        message: 'The correct answer must refer to an existing option',
        path: ['correctOptionId'],
      })
    }
  })

export const followUpExerciseSchema = z
  .object({
    id: courseReferenceIdSchema,
    knowledgePointIds: z.array(courseReferenceIdSchema).min(1).max(3),
    prompt: z.string().trim().min(10).max(1_000),
    rubric: z.array(z.string().trim().min(5).max(500)).min(1).max(4),
  })
  .strict()

export const exerciseSetBodySchema = z
  .object({
    multipleChoice: z.array(multipleChoiceQuestionSchema).length(4),
    followUp: followUpExerciseSchema,
  })
  .strict()

export const courseLearningPackageSchema = z
  .object({
    sections: z.array(courseSectionSchema).min(3).max(6),
    exercises: exerciseSetBodySchema,
  })
  .strict()
  .superRefine((learningPackage, context) => {
    const sectionIds = new Set(learningPackage.sections.map((section) => section.id))
    if (sectionIds.size !== learningPackage.sections.length) {
      context.addIssue({
        code: 'custom',
        message: 'Section IDs must be unique',
        path: ['sections'],
      })
    }
    const questionIds = new Set(
      learningPackage.exercises.multipleChoice.map((question) => question.id),
    )
    if (questionIds.size !== learningPackage.exercises.multipleChoice.length) {
      context.addIssue({
        code: 'custom',
        message: 'Question IDs must be unique',
        path: ['exercises', 'multipleChoice'],
      })
    }
    if (questionIds.has(learningPackage.exercises.followUp.id)) {
      context.addIssue({
        code: 'custom',
        message: 'The follow-up question ID must be unique',
        path: ['exercises', 'followUp', 'id'],
      })
    }
  })

export const publicMultipleChoiceQuestionSchema = z
  .object({
    id: courseReferenceIdSchema,
    knowledgePointId: courseReferenceIdSchema,
    prompt: z.string(),
    options: z
      .array(z.object({ id: courseReferenceIdSchema, text: z.string() }).strict())
      .length(4),
  })
  .strict()
export const publicExerciseSetSchema = z
  .object({
    multipleChoice: z.array(publicMultipleChoiceQuestionSchema).length(4),
    followUp: z
      .object({
        id: courseReferenceIdSchema,
        knowledgePointIds: z.array(courseReferenceIdSchema).min(1).max(3),
        prompt: z.string(),
      })
      .strict(),
  })
  .strict()

export function toPublicExerciseSet(value: unknown): PublicExerciseSet {
  const exerciseSet = exerciseSetBodySchema.parse(value)
  return {
    multipleChoice: exerciseSet.multipleChoice.map((question) => ({
      id: question.id,
      knowledgePointId: question.knowledgePointId,
      prompt: question.prompt,
      options: question.options.map((option) => ({ id: option.id, text: option.text })),
    })),
    followUp: {
      id: exerciseSet.followUp.id,
      knowledgePointIds: exerciseSet.followUp.knowledgePointIds,
      prompt: exerciseSet.followUp.prompt,
    },
  }
}

export const courseGenerationSummarySchema = z
  .object({
    status: courseStatusSchema,
    generationRunId: entityIdSchema.nullable(),
    generationQueuedAt: z.iso.datetime().nullable(),
    error: z
      .object({
        code: z.string().trim().min(1).max(64),
        message: z.string().trim().min(1).max(500),
      })
      .strict()
      .nullable(),
  })
  .strict()

export type CourseStatus = z.infer<typeof courseStatusSchema>
export type CourseKnowledgeRole = z.infer<typeof courseKnowledgeRoleSchema>
export type CourseKnowledgePoint = z.infer<typeof courseKnowledgePointSchema>
export type CourseSection = z.infer<typeof courseSectionSchema>
export type ExerciseSetBody = z.infer<typeof exerciseSetBodySchema>
export type PublicExerciseSet = z.infer<typeof publicExerciseSetSchema>
export type CourseLearningPackage = z.infer<typeof courseLearningPackageSchema>
export type CourseGenerationSummary = z.infer<typeof courseGenerationSummarySchema>
