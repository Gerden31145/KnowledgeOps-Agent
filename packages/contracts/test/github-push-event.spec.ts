import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  GITHUB_PUSH_RECEIVED_SCHEMA_VERSION,
  buildGitHubEvidenceJobId,
  githubEvidenceJobPayloadSchema,
  githubPushPayloadSchema,
  githubPushReceivedEventPayloadSchema,
  githubEvidenceRetryPayloadSchema,
  githubEvidenceRetryEventSchema,
  buildGitHubEvidenceRetryKey,
} from '../src/events/github-push.js'
import { noteVerificationRequestedEventPayloadSchema } from '../src/events/note-verification.js'

const payload = {
  deliveryId: randomUUID(),
  binding: { repositoryId: randomUUID(), userId: randomUUID(), repositoryVersion: 7 },
  task: { taskId: randomUUID(), taskVersion: 3, targetPath: 'notes/vue.md' },
}

describe('minimal evidence queue notification', () => {
  it('keeps v1 retries in DIFF mode and requires explicit mode for v2 snapshot recovery', () => {
    const legacy = {
      deliveryId: payload.deliveryId,
      sourceEventId: randomUUID(),
      previousAttemptCount: 2,
      previousErrorCode: 'GITHUB_UNAVAILABLE',
      previousFailedAt: '2026-10-16T00:00:00Z',
    }
    expect(
      githubEvidenceRetryEventSchema.parse({ schemaVersion: 1, payload: legacy }).payload
        .evidenceMode,
    ).toBe('DIFF')
    expect(
      githubEvidenceRetryEventSchema.safeParse({ schemaVersion: 2, payload: legacy }).success,
    ).toBe(false)
    expect(
      githubEvidenceRetryEventSchema.safeParse({
        schemaVersion: 1,
        payload: { ...legacy, evidenceMode: 'SNAPSHOT' },
      }).success,
    ).toBe(false)
    expect(
      githubEvidenceRetryEventSchema.safeParse({
        schemaVersion: 2,
        payload: {
          ...legacy,
          evidenceMode: 'DIFF',
          previousErrorCode: 'RESYNC_REQUIRED',
        },
      }).success,
    ).toBe(false)
    expect(
      githubEvidenceRetryEventSchema.parse({
        schemaVersion: 2,
        payload: {
          ...legacy,
          evidenceMode: 'SNAPSHOT',
          previousErrorCode: 'RESYNC_REQUIRED',
        },
      }).payload.evidenceMode,
    ).toBe('SNAPSHOT')
    expect(
      githubEvidenceJobPayloadSchema.safeParse({
        eventId: legacy.sourceEventId,
        deliveryId: legacy.deliveryId,
        evidenceMode: 'SNAPSHOT',
      }).success,
    ).toBe(false)
  })
  it('gives a recovery request its own stable Job ID without replacing the original receipt IDs', () => {
    const retryEventId = randomUUID()
    const ids = { eventId: randomUUID(), deliveryId: payload.deliveryId, retryEventId }
    expect(githubEvidenceJobPayloadSchema.parse(ids)).toEqual(ids)
    expect(buildGitHubEvidenceJobId(ids.deliveryId, retryEventId)).toBe(
      `evidence-${ids.deliveryId}-retry-${retryEventId}`,
    )
    expect(buildGitHubEvidenceRetryKey(ids.deliveryId, 3)).toBe(
      `github-evidence-retry-${ids.deliveryId}-3`,
    )
    expect(
      githubEvidenceRetryPayloadSchema.safeParse({
        deliveryId: ids.deliveryId,
        sourceEventId: ids.eventId,
        previousAttemptCount: 3,
        previousErrorCode: 'RESYNC_REQUIRED',
        previousFailedAt: '2026-10-15T00:00:00Z',
      }).success,
    ).toBe(false)
  })
  it('contains only receipt IDs and has a stable, colon-free Job ID', () => {
    const ids = { eventId: randomUUID(), deliveryId: payload.deliveryId }
    expect(githubEvidenceJobPayloadSchema.parse(ids)).toEqual(ids)
    expect(buildGitHubEvidenceJobId(ids.deliveryId)).toBe(`evidence-${ids.deliveryId}`)
    expect(buildGitHubEvidenceJobId(ids.deliveryId)).not.toContain(':')
  })
  it.each([
    {},
    { eventId: randomUUID(), deliveryId: 'bad' },
    { eventId: randomUUID(), deliveryId: payload.deliveryId, token: 'fixture-secret' },
  ])('rejects incomplete or expanded messages', (input) => {
    expect(githubEvidenceJobPayloadSchema.safeParse(input).success).toBe(false)
  })
})

describe('GitHub Push receipt v2 freezes task identity separately from binding identity', () => {
  it('requires an explicit version and accepts the minimal server-selected snapshot', () => {
    expect(GITHUB_PUSH_RECEIVED_SCHEMA_VERSION).toBe(2)
    expect(githubPushReceivedEventPayloadSchema.parse(payload)).toEqual(payload)
  })

  it.each([
    { deliveryId: payload.deliveryId, bindings: [payload.binding] },
    { ...payload, task: undefined },
    { ...payload, task: { ...payload.task, taskVersion: -1 } },
    { ...payload, binding: { ...payload.binding, repositoryVersion: -1 } },
    { ...payload, task: { ...payload.task, targetPath: '../private.md' } },
    { ...payload, token: 'never-store-credentials' },
  ])('rejects legacy, incomplete or unsafe context without inventing missing values', (value) => {
    expect(githubPushReceivedEventPayloadSchema.safeParse(value).success).toBe(false)
  })
})

describe('minimal Push and verification handoff payloads', () => {
  it('normalizes GitHub IDs and SHAs and strips unrelated private fields', () => {
    const push = {
      installation: { id: 42 },
      repository: { id: '123' },
      ref: 'refs/heads/main',
      before: 'A'.repeat(40),
      after: 'B'.repeat(40),
      deleted: false,
      forced: false,
      sender: { login: 'do-not-store' },
      commits: [{ message: 'do-not-store' }],
    }
    expect(githubPushPayloadSchema.parse(push)).toEqual({
      installation: { id: '42' },
      repository: { id: '123' },
      ref: 'refs/heads/main',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      deleted: false,
      forced: false,
    })
  })

  it('accepts only the IDs needed by the verification consumer', () => {
    const ids = { runId: randomUUID(), submissionId: randomUUID() }
    expect(noteVerificationRequestedEventPayloadSchema.parse(ids)).toEqual(ids)
  })

  it.each([
    {},
    { runId: randomUUID() },
    { runId: randomUUID(), submissionId: 'not-a-uuid' },
    { runId: randomUUID(), submissionId: randomUUID(), token: 'never-queue-a-token' },
    { runId: randomUUID(), submissionId: randomUUID(), content: 'private Markdown' },
  ])('rejects incomplete or over-broad verification payloads', (value) => {
    expect(noteVerificationRequestedEventPayloadSchema.safeParse(value).success).toBe(false)
  })
})
