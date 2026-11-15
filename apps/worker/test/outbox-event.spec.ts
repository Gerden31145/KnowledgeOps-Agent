import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { NonRetryableOutboxDispatchError } from '../src/outbox/outbox-dispatch-error.js'
import {
  parsePlanGenerationOutboxEvent,
  parseCourseExerciseOutboxEvent,
  parseCourseGenerationOutboxEvent,
  parseCourseQuestionOutboxEvent,
  parseGitHubPushOutboxEvent,
  parseGitHubEvidenceRetryOutboxEvent,
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

describe('Evidence recovery request parsing', () => {
  const deliveryId = randomUUID()
  const event = createEvent({
    type: 'GITHUB_EVIDENCE_RETRY_REQUESTED',
    aggregateId: deliveryId,
    deduplicationKey: `github-evidence-retry-${deliveryId}-3`,
    payload: {
      deliveryId,
      sourceEventId: randomUUID(),
      previousAttemptCount: 3,
      previousErrorCode: 'GITHUB_UNAVAILABLE',
      previousFailedAt: '2026-10-15T00:00:00Z',
    },
  })
  it('preserves the original receipt reference and failure basis, normalizing v1 to DIFF', () => {
    expect(parseGitHubEvidenceRetryOutboxEvent(event)).toEqual({
      eventId: event.id,
      payload: { ...(event.payload as object), evidenceMode: 'DIFF' },
    })
    expect(event.payload).not.toHaveProperty('evidenceMode')
  })
  it.each([
    { type: 'GITHUB_PUSH_RECEIVED' },
    { aggregateId: randomUUID() },
    { schemaVersion: 2 },
    { deduplicationKey: 'bad-key' },
    { payload: {} },
  ])('rejects a mismatched retry intent', (patch) => {
    expect(() => parseGitHubEvidenceRetryOutboxEvent({ ...event, ...patch })).toThrow(
      NonRetryableOutboxDispatchError,
    )
  })
})

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

describe('Course generation outbox event parsing', () => {
  it('keeps the run identity aligned across payload, aggregate, and deduplication key', () => {
    const generationRunId = randomUUID()
    const event = createEvent({
      type: 'COURSE_GENERATION_REQUESTED',
      aggregateId: generationRunId,
      deduplicationKey: `course-generation-requested-${generationRunId}`,
      payload: { generationRunId },
    })
    expect(parseCourseGenerationOutboxEvent(event)).toEqual({
      eventId: event.id,
      payload: { generationRunId },
    })
    expect(() =>
      parseCourseGenerationOutboxEvent({
        ...event,
        deduplicationKey: `course-generation-requested-${randomUUID()}`,
      }),
    ).toThrow(NonRetryableOutboxDispatchError)
  })
})

describe('Course question outbox event parsing', () => {
  it('keeps the question identity aligned and rejects a mismatched intent', () => {
    const questionId = randomUUID()
    const event = createEvent({
      type: 'COURSE_QUESTION_REQUESTED',
      aggregateId: questionId,
      deduplicationKey: `course-question-requested-${questionId}`,
      payload: { questionId },
    })
    expect(parseCourseQuestionOutboxEvent(event)).toEqual({
      eventId: event.id,
      payload: { questionId },
    })
    expect(() =>
      parseCourseQuestionOutboxEvent({
        ...event,
        payload: { questionId: randomUUID() },
      }),
    ).toThrow(NonRetryableOutboxDispatchError)
  })
})

describe('Course exercise outbox event parsing', () => {
  it('keeps the submission identity aligned across the intent', () => {
    const submissionId = randomUUID()
    const event = createEvent({
      type: 'COURSE_EXERCISE_REQUESTED',
      aggregateId: submissionId,
      deduplicationKey: `course-exercise-requested-${submissionId}`,
      payload: { submissionId },
    })
    expect(parseCourseExerciseOutboxEvent(event)).toEqual({
      eventId: event.id,
      payload: { submissionId },
    })
    expect(() => parseCourseExerciseOutboxEvent({ ...event, aggregateId: randomUUID() })).toThrow(
      NonRetryableOutboxDispatchError,
    )
  })
})

describe('GitHub receipt event parsing', () => {
  const deliveryId = randomUUID()
  const event = createEvent({
    type: 'GITHUB_PUSH_RECEIVED',
    schemaVersion: 2,
    aggregateId: deliveryId,
    deduplicationKey: `github-push-received-${deliveryId}`,
    payload: {
      deliveryId,
      binding: { repositoryId: randomUUID(), userId: randomUUID(), repositoryVersion: 1 },
      task: { taskId: randomUUID(), taskVersion: 0, targetPath: 'notes/vue.md' },
    },
  })
  it('preserves the original event and task snapshot for the publisher', () => {
    expect(parseGitHubPushOutboxEvent(event)).toEqual({ eventId: event.id, payload: event.payload })
  })
  it.each([
    { schemaVersion: 1 },
    { payload: {} },
    { aggregateId: randomUUID() },
    { deduplicationKey: 'unrelated' },
    { type: 'NOTE_VERIFICATION_REQUESTED' },
  ])('rejects legacy or mismatched intent without looking up a new task', (patch) => {
    expect(() => parseGitHubPushOutboxEvent({ ...event, ...patch })).toThrow(
      NonRetryableOutboxDispatchError,
    )
  })
})
