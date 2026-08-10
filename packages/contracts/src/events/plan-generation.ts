import { z } from 'zod'

import { entityIdSchema } from '../shared/primitives.js'

export const OUTBOX_EVENT_TYPES = ['PLAN_GENERATION_REQUESTED'] as const

export const outboxEventTypeSchema = z.enum(OUTBOX_EVENT_TYPES)

export const planGenerationRequestedEventPayloadSchema = z
  .object({
    generationRunId: entityIdSchema,
  })
  .strict()

export type OutboxEventType = z.infer<typeof outboxEventTypeSchema>
export type PlanGenerationRequestedEventPayload = z.infer<
  typeof planGenerationRequestedEventPayloadSchema
>
