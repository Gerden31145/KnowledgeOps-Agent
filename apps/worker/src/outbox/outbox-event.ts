import {
  planGenerationRequestedEventPayloadSchema,
  type PlanGenerationRequestedEventPayload,
} from '@knowledgeops/contracts'

import { NonRetryableOutboxDispatchError } from './outbox-dispatch-error.js'

export const SUPPORTED_OUTBOX_SCHEMA_VERSION = 1

export interface LockedOutboxEvent {
  aggregateId: string
  deduplicationKey: string
  dispatchAttemptCount: number
  id: string
  payload: unknown
  schemaVersion: number
  type: string
}

export interface PlanGenerationOutboxMessage {
  eventId: string
  payload: PlanGenerationRequestedEventPayload
}

export function parsePlanGenerationOutboxEvent(
  event: LockedOutboxEvent,
): PlanGenerationOutboxMessage {
  if (event.schemaVersion !== SUPPORTED_OUTBOX_SCHEMA_VERSION) {
    throw new NonRetryableOutboxDispatchError(
      'OUTBOX_SCHEMA_VERSION_UNSUPPORTED',
      `Unsupported outbox schema version ${event.schemaVersion}`,
    )
  }

  if (event.type !== 'PLAN_GENERATION_REQUESTED') {
    throw new NonRetryableOutboxDispatchError(
      'OUTBOX_EVENT_TYPE_UNSUPPORTED',
      `Unsupported outbox event type ${event.type}`,
    )
  }

  const payloadResult = planGenerationRequestedEventPayloadSchema.safeParse(event.payload)

  if (
    !payloadResult.success ||
    payloadResult.data.generationRunId !== event.aggregateId ||
    event.deduplicationKey !== `plan-generation-requested-${payloadResult.data.generationRunId}`
  ) {
    throw new NonRetryableOutboxDispatchError(
      'OUTBOX_PAYLOAD_INVALID',
      'Plan generation outbox payload does not match its aggregate',
    )
  }

  return {
    eventId: event.id,
    payload: payloadResult.data,
  }
}
