import { z } from 'zod'

import { entityIdSchema } from '../shared/primitives.js'

export const OUTBOX_EVENT_TYPES = [
  'PLAN_GENERATION_REQUESTED',
  'COURSE_GENERATION_REQUESTED',
  'COURSE_QUESTION_REQUESTED',
  'GITHUB_PUSH_RECEIVED',
  'GITHUB_EVIDENCE_RETRY_REQUESTED',
  'NOTE_VERIFICATION_REQUESTED',
  'ANSWER_VERIFICATION_REQUESTED',
] as const

export const PLAN_GENERATION_QUEUE_NAME = 'plan-generation'
export const PLAN_GENERATION_JOB_NAME = 'generate-plan'
export const PLAN_GENERATION_JOB_ID_PREFIX = 'plan-generation-'

export const outboxEventTypeSchema = z.enum(OUTBOX_EVENT_TYPES)

export const planGenerationRequestedEventPayloadSchema = z
  .object({
    generationRunId: entityIdSchema,
  })
  .strict()

export function buildPlanGenerationJobId(generationRunId: string): string {
  return `${PLAN_GENERATION_JOB_ID_PREFIX}${entityIdSchema.parse(generationRunId)}`
}

export type OutboxEventType = z.infer<typeof outboxEventTypeSchema>
export type PlanGenerationRequestedEventPayload = z.infer<
  typeof planGenerationRequestedEventPayloadSchema
>
