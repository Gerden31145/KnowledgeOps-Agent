import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { NonRetryableOutboxDispatchError } from '../src/outbox/outbox-dispatch-error.js'
import {
  parsePlanGenerationOutboxEvent,
  type LockedOutboxEvent,
} from '../src/outbox/outbox-event.js'

function createEvent(overrides: Partial<LockedOutboxEvent> = {}): LockedOutboxEvent {
  const generationRunId = randomUUID()

  return {
    aggregateId: generationRunId,
    deduplicationKey: `plan-generation-requested-${generationRunId}`,
    dispatchAttemptCount: 0,
    id: randomUUID(),
    payload: { generationRunId },
    schemaVersion: 1,
    type: 'PLAN_GENERATION_REQUESTED',
    ...overrides,
  }
}

describe('Plan generation outbox event parsing', () => {
  it('returns the minimal queue message for a supported event', () => {
    const event = createEvent()

    expect(parsePlanGenerationOutboxEvent(event)).toEqual({
      eventId: event.id,
      payload: event.payload,
    })
  })

  it('rejects a payload that points at another aggregate', () => {
    expect(() =>
      parsePlanGenerationOutboxEvent(createEvent({ payload: { generationRunId: randomUUID() } })),
    ).toThrowError(
      new NonRetryableOutboxDispatchError(
        'OUTBOX_PAYLOAD_INVALID',
        'Plan generation outbox payload does not match its aggregate',
      ),
    )
  })

  it('rejects a deduplication key that does not belong to the run', () => {
    expect(() =>
      parsePlanGenerationOutboxEvent(
        createEvent({ deduplicationKey: `plan-generation-requested-${randomUUID()}` }),
      ),
    ).toThrow('Plan generation outbox payload does not match its aggregate')
  })

  it('rejects unknown schema versions without asking Redis to retry', () => {
    expect(() => parsePlanGenerationOutboxEvent(createEvent({ schemaVersion: 2 }))).toThrow(
      'Unsupported outbox schema version 2',
    )
  })
})
