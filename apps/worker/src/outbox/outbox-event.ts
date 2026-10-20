import {
  GITHUB_PUSH_RECEIVED_SCHEMA_VERSION,
  buildGitHubEvidenceRetryKey,
  githubEvidenceRetryEventSchema,
  type GitHubEvidenceRetryPayload,
  githubPushReceivedEventPayloadSchema,
  planGenerationRequestedEventPayloadSchema,
  type GitHubPushReceivedEventPayload,
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

export interface GitHubPushOutboxMessage {
  eventId: string
  payload: GitHubPushReceivedEventPayload
}

export interface GitHubEvidenceRetryOutboxMessage {
  eventId: string
  payload: GitHubEvidenceRetryPayload
}

export function parseGitHubEvidenceRetryOutboxEvent(
  event: LockedOutboxEvent,
): GitHubEvidenceRetryOutboxMessage {
  const parsed = githubEvidenceRetryEventSchema.safeParse(event)
  if (
    event.type !== 'GITHUB_EVIDENCE_RETRY_REQUESTED' ||
    !parsed.success ||
    event.aggregateId !== parsed.data.payload.deliveryId ||
    event.deduplicationKey !==
      buildGitHubEvidenceRetryKey(
        parsed.data.payload.deliveryId,
        parsed.data.payload.previousAttemptCount,
      )
  ) {
    throw new NonRetryableOutboxDispatchError(
      'OUTBOX_PAYLOAD_INVALID',
      'Invalid evidence retry intent',
    )
  }
  return { eventId: event.id, payload: parsed.data.payload }
}

export function parseGitHubPushOutboxEvent(event: LockedOutboxEvent): GitHubPushOutboxMessage {
  if (event.type !== 'GITHUB_PUSH_RECEIVED') {
    throw new NonRetryableOutboxDispatchError(
      'OUTBOX_EVENT_TYPE_UNSUPPORTED',
      'Not a GitHub push intent',
    )
  }
  if (event.schemaVersion !== GITHUB_PUSH_RECEIVED_SCHEMA_VERSION) {
    throw new NonRetryableOutboxDispatchError(
      'OUTBOX_SCHEMA_VERSION_UNSUPPORTED',
      'GitHub push intent requires the receipt-time task snapshot',
    )
  }
  const parsed = githubPushReceivedEventPayloadSchema.safeParse(event.payload)
  if (
    !parsed.success ||
    event.aggregateId !== parsed.data.deliveryId ||
    event.deduplicationKey !== `github-push-received-${parsed.data.deliveryId}`
  ) {
    throw new NonRetryableOutboxDispatchError(
      'OUTBOX_PAYLOAD_INVALID',
      'GitHub push intent does not match its delivery',
    )
  }
  return { eventId: event.id, payload: parsed.data }
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
