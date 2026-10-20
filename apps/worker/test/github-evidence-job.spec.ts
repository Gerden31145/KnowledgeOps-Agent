import { GITHUB_EVIDENCE_JOB_NAME, buildGitHubEvidenceJobId } from '@knowledgeops/contracts'
import { randomUUID } from 'node:crypto'
import { UnrecoverableError } from 'bullmq'
import { describe, expect, it, vi } from 'vitest'
import {
  GitHubEvidenceJobError,
  classifyGitHubEvidenceJobError,
  type GitHubEvidenceJobProcessor,
} from '../src/github/github-evidence-job-processor.js'
import { EvidencePersistenceError } from '../src/github/finalize-github-push-evidence.js'
import { GitHubEvidenceError } from '../src/github/github-evidence-http.js'
import { createGitHubEvidenceBullMqProcessor } from '../src/queue/bullmq-github-evidence-queue.js'

const data = { eventId: randomUUID(), deliveryId: randomUUID() }
const job = (patch: Record<string, unknown> = {}) =>
  ({
    name: GITHUB_EVIDENCE_JOB_NAME,
    data,
    id: buildGitHubEvidenceJobId(data.deliveryId),
    attemptsMade: 1,
    opts: { attempts: 3 },
    ...patch,
  }) as Parameters<ReturnType<typeof createGitHubEvidenceBullMqProcessor>>[0]

describe('GitHub evidence BullMQ boundary', () => {
  it('accepts only the matching retry request Job ID', async () => {
    const retryEventId = randomUUID()
    const payload = { ...data, retryEventId }
    const process = vi
      .fn<GitHubEvidenceJobProcessor['process']>()
      .mockResolvedValue({ status: 'IGNORED', reason: 'TARGET_NOT_CHANGED' })
    const adapter = createGitHubEvidenceBullMqProcessor({ process })
    await expect(adapter(job({ data: payload }), 'token')).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
    expect(process).not.toHaveBeenCalled()
    await adapter(
      job({ data: payload, id: buildGitHubEvidenceJobId(data.deliveryId, retryEventId) }),
      'token',
    )
    expect(process).toHaveBeenCalledWith(payload, { number: 2, maxAttempts: 3 })
  })
  it('passes the attempt number and returns the existing business result', async () => {
    const process = vi
      .fn<GitHubEvidenceJobProcessor['process']>()
      .mockResolvedValue({ status: 'IGNORED', reason: 'TARGET_NOT_CHANGED' })
    await expect(createGitHubEvidenceBullMqProcessor({ process })(job(), 'token')).resolves.toEqual(
      { status: 'IGNORED', reason: 'TARGET_NOT_CHANGED' },
    )
    expect(process).toHaveBeenCalledWith(data, { number: 2, maxAttempts: 3 })
  })
  it.each([
    { name: 'generate-plan' },
    { data: null },
    { id: 'wrong-id' },
    { data: { ...data, content: 'private text' } },
  ])('rejects malformed or misrouted jobs before business processing', async (patch) => {
    const process = vi.fn<GitHubEvidenceJobProcessor['process']>()
    await expect(
      createGitHubEvidenceBullMqProcessor({ process })(job(patch), 'token'),
    ).rejects.toBeInstanceOf(UnrecoverableError)
    expect(process).not.toHaveBeenCalled()
  })
  it.each(['GITHUB_AUTH_REQUIRED', 'RESYNC_REQUIRED'] as const)(
    'stops automatic retries for %s',
    async (code) => {
      const process = vi
        .fn<GitHubEvidenceJobProcessor['process']>()
        .mockRejectedValue(new GitHubEvidenceError(code))
      await expect(
        createGitHubEvidenceBullMqProcessor({ process })(job(), 'token'),
      ).rejects.toThrow(new UnrecoverableError(code))
    },
  )
  it('does not leak arbitrary database/upstream text into Redis failedReason', async () => {
    const process = vi
      .fn<GitHubEvidenceJobProcessor['process']>()
      .mockRejectedValue(new Error('fixture-secret private body'))
    await expect(createGitHubEvidenceBullMqProcessor({ process })(job(), 'token')).rejects.toThrow(
      new GitHubEvidenceJobError('EVIDENCE_PROCESSING_FAILED', true),
    )
  })
  it.each([
    [new GitHubEvidenceError('GITHUB_UNAVAILABLE'), true],
    [new GitHubEvidenceError('SOURCE_UNAVAILABLE'), false],
    [new GitHubEvidenceError('RESYNC_REQUIRED'), false],
    [new GitHubEvidenceError('LIMIT_EXCEEDED'), false],
    [new EvidencePersistenceError('INVALID_EVIDENCE'), false],
    [new EvidencePersistenceError('TASK_CHANGED'), true],
  ] as const)('classifies a known failure without persisting its cause', (error, retryable) => {
    expect(classifyGitHubEvidenceJobError(error)).toMatchObject({
      code: error.code,
      message: error.code,
      retryable,
    })
  })
})
