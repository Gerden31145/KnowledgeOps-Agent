import { randomUUID } from 'node:crypto'
import { GITHUB_EVIDENCE_JOB_NAME } from '@knowledgeops/contracts'
import type { DatabaseClient } from '@knowledgeops/database'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubEvidenceReconciler } from '../src/github/github-evidence-reconciler.js'
import { BullMqGitHubEvidenceQueue } from '../src/queue/bullmq-github-evidence-queue.js'
import { OutboxDispatchLoop } from '../src/outbox/outbox-dispatch-loop.js'
import type { OutboxDispatcher } from '../src/outbox/outbox-dispatcher.js'

const redis = vi.hoisted(() => ({ getJob: vi.fn() }))
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    on = vi.fn()
    getJob = redis.getJob
  },
}))
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('evidence queue failure lookup', () => {
  const payload = { eventId: randomUUID(), deliveryId: randomUUID(), retryEventId: randomUUID() }
  function queue() {
    return new BullMqGitHubEvidenceQueue({
      redisUrl: 'redis://127.0.0.1:6379',
      concurrency: 1,
      jobOptions: { attempts: 3, backoffDelayMs: 30 },
      processor: { process: vi.fn() },
    })
  }
  function job(patch: Record<string, unknown> = {}) {
    return {
      name: GITHUB_EVIDENCE_JOB_NAME,
      data: payload,
      attemptsStarted: 3,
      processedOn: 1000,
      finishedOn: 2000,
      failedReason: 'fixture-secret arbitrary text',
      getState: vi.fn().mockResolvedValue('failed'),
      ...patch,
    }
  }
  it('returns only the matching retained terminal metadata, not error text', async () => {
    redis.getJob.mockResolvedValue(job())
    expect(await queue().getFailure(payload)).toEqual({
      attemptsStarted: 3,
      lastAttemptAt: new Date(1000),
      finishedAt: new Date(2000),
    })
    expect(redis.getJob).toHaveBeenCalledWith(
      `evidence-${payload.deliveryId}-retry-${payload.retryEventId}`,
    )
  })
  it.each(['waiting', 'active', 'delayed', 'completed', 'unknown'])(
    'does not treat %s as failure',
    async (state) => {
      redis.getJob.mockResolvedValue(job({ getState: vi.fn().mockResolvedValue(state) }))
      expect(await queue().getFailure(payload)).toBeUndefined()
    },
  )
  it.each([
    undefined,
    job({ name: 'other' }),
    job({ data: { ...payload, eventId: randomUUID() } }),
    job({ data: { ...payload, retryEventId: undefined } }),
    job({ finishedOn: undefined }),
    job({ attemptsStarted: 0 }),
  ])('ignores missing/mismatched/incomplete jobs', async (value) => {
    redis.getJob.mockResolvedValue(value)
    expect(await queue().getFailure(payload)).toBeUndefined()
  })
})

describe('evidence reconciliation paging and lifecycle', () => {
  it('advances past unresolved rows and wraps instead of starving later deliveries', async () => {
    const first = randomUUID(),
      second = randomUUID()
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([{ id: first }])
      .mockResolvedValueOnce([{ id: second }])
      .mockResolvedValueOnce([])
      .mockResolvedValue([])
    const client = {
      webhookDelivery: { findMany },
      outboxEvent: { findUnique: vi.fn().mockResolvedValue(null) },
    }
    const getFailure = vi.fn()
    const reconciler = new GitHubEvidenceReconciler(client as unknown as DatabaseClient, {
      getFailure,
    })
    for (let i = 0; i < 4; i++) expect(await reconciler.reconcile(1)).toBe(0)
    expect(findMany.mock.calls.map(([args]) => args.where.id)).toEqual([
      undefined,
      { gt: first },
      { gt: second },
      undefined,
    ])
    expect(getFailure).not.toHaveBeenCalled()
  })

  it('keeps the existing loop alive after dispatch/reconciliation failures and waits at shutdown', async () => {
    vi.useFakeTimers()
    const dispatchAvailable = vi
      .fn()
      .mockRejectedValueOnce(new Error('dispatch down'))
      .mockResolvedValue({ inspected: 0 })
    const reconcile = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue(0)
    const loop = new OutboxDispatchLoop(
      { dispatchAvailable } as unknown as OutboxDispatcher,
      10,
      50,
      reconcile,
    )
    await loop.start()
    expect(reconcile).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(50)
    expect(reconcile).toHaveBeenCalledTimes(2)
    let release!: (value: number) => void
    reconcile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    await vi.advanceTimersByTimeAsync(150)
    expect(reconcile).toHaveBeenCalledTimes(3)
    let stopped = false
    const stopping = loop.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    release(0)
    await stopping
    await vi.advanceTimersByTimeAsync(100)
    expect(reconcile).toHaveBeenCalledTimes(3)
  })
})
