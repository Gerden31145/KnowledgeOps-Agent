import { z } from 'zod'

export const TASK_TYPES = ['MARKDOWN_NOTE'] as const

export const ACCEPTANCE_CRITERION_TYPES = [
  'FILE_CHANGED',
  'SECTION_PRESENT',
  'CONTENT_MINIMUM',
  'SEMANTIC_CORRECTNESS',
  'TOPIC_COVERAGE',
  'EXPLANATION_QUALITY',
  'FOLLOW_UP_ANSWER',
] as const

export const taskTypeSchema = z.enum(TASK_TYPES)
export const acceptanceCriterionTypeSchema = z.enum(ACCEPTANCE_CRITERION_TYPES)

export type TaskType = z.infer<typeof taskTypeSchema>
export type AcceptanceCriterionType = z.infer<typeof acceptanceCriterionTypeSchema>
