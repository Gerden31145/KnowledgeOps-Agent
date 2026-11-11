import { z } from 'zod'

export const PLAN_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'] as const

export const TASK_TYPES = ['MARKDOWN_NOTE', 'COURSE'] as const

export const ACCEPTANCE_CRITERION_TYPES = [
  'FILE_CHANGED',
  'SECTION_PRESENT',
  'CONTENT_MINIMUM',
  'SEMANTIC_CORRECTNESS',
  'TOPIC_COVERAGE',
  'EXPLANATION_QUALITY',
  'FOLLOW_UP_ANSWER',
] as const

export const PLAN_TASK_ACCEPTANCE_CRITERION_TYPES = [
  'FILE_CHANGED',
  'SECTION_PRESENT',
  'CONTENT_MINIMUM',
  'SEMANTIC_CORRECTNESS',
  'TOPIC_COVERAGE',
  'EXPLANATION_QUALITY',
] as const satisfies readonly AcceptanceCriterionType[]

export const taskTypeSchema = z.enum(TASK_TYPES)
export const planStatusSchema = z.enum(PLAN_STATUSES)
export const acceptanceCriterionTypeSchema = z.enum(ACCEPTANCE_CRITERION_TYPES)
export const planTaskAcceptanceCriterionTypeSchema = z.enum(PLAN_TASK_ACCEPTANCE_CRITERION_TYPES)

export const markdownTargetPathSchema = z
  .string()
  .trim()
  .min(3)
  .max(1_024)
  .refine((path) => !path.includes('\\'), 'Use forward slashes in repository paths')
  .regex(/^(?!\/)(?![a-zA-Z]:)(?!.*(?:^|\/)\.\.(?:\/|$)).+\.md$/i)
  .describe('A repository-relative Markdown path without parent traversal')

export type PlanStatus = z.infer<typeof planStatusSchema>
export type TaskType = z.infer<typeof taskTypeSchema>
export type AcceptanceCriterionType = z.infer<typeof acceptanceCriterionTypeSchema>
export type PlanTaskAcceptanceCriterionType = z.infer<typeof planTaskAcceptanceCriterionTypeSchema>
