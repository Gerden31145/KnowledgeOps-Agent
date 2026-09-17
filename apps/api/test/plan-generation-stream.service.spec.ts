import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import type { PlanGenerationRunStatusResponse } from '@knowledgeops/contracts'
import { UnauthorizedException } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthRequest } from '../src/identity/auth-http.js'
import type { AuthService } from '../src/identity/auth.service.js'
import type { GetPlanGenerationRunService } from '../src/plan-generation/get-plan-generation-run.service.js'
import { PlanGenerationRunNotFoundError } from '../src/plan-generation/plan-generation.errors.js'
import {
  PLAN_STREAM_INTERVAL_MS,
  PlanGenerationStreamService,
} from '../src/plan-generation/plan-generation-stream.service.js'

const snapshot: PlanGenerationRunStatusResponse = {
  generationRunId: 'abfe5ca9-5873-49df-bbf0-f45667a41d55',
  goalId: '69057518-5456-4e20-a956-1c2c021452f3',
  version: 0,
  status: 'QUEUED',
  queuedAt: '2026-09-17T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  error: null,
  plan: null,
}
function reply() {
  const events = new EventEmitter()
  const response = Object.assign(events, {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(() => {
      response.headersSent = true
    }),
    write: vi.fn<(frame: string) => boolean>(() => true),
    end: vi.fn(() => {
      response.writableEnded = true
    }),
    destroy: vi.fn(() => {
      response.destroyed = true
      events.emit('close')
    }),
  })
  return response
}
function fixture() {
  const execute = vi.fn().mockResolvedValue(snapshot)
  const revalidateUser = vi.fn().mockResolvedValue({ id: 'owner' })
  const service = new PlanGenerationStreamService(
    { execute } as unknown as GetPlanGenerationRunService,
    { revalidateUser } as unknown as AuthService,
  )
  const open = (response = reply(), userId = 'owner') =>
    service.open(
      snapshot.generationRunId,
      userId,
      {} as AuthRequest,
      response as unknown as ServerResponse,
    )
  return { execute, revalidateUser, service, open }
}
describe('R13 persistent snapshot stream', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('sends initial state, suppresses duplicates, heartbeats and ends on a terminal snapshot', async () => {
    const f = fixture()
    const res = reply()
    await f.open(res)
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no')
    expect(res.write).toHaveBeenCalledWith(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)
    await vi.advanceTimersByTimeAsync(16_000)
    expect(
      res.write.mock.calls.filter(([frame]) => String(frame).includes('event: snapshot')),
    ).toHaveLength(1)
    expect(res.write).toHaveBeenCalledWith(': heartbeat\n\n')
    f.execute.mockResolvedValue({ ...snapshot, version: 1, status: 'TIMED_OUT' })
    await vi.advanceTimersByTimeAsync(PLAN_STREAM_INTERVAL_MS)
    expect(res.end).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(res.listenerCount('close')).toBe(0)
  })

  it('returns HTTP 404 before opening headers for an unowned or missing run', async () => {
    const f = fixture()
    const res = reply()
    f.execute.mockRejectedValue(new PlanGenerationRunNotFoundError())
    await expect(f.open(res)).rejects.toMatchObject({ status: 404 })
    expect(res.flushHeaders).not.toHaveBeenCalled()
    expect(res.end).not.toHaveBeenCalled()
    expect(res.listenerCount('close')).toBe(0)
  })

  it.each([
    [new UnauthorizedException(), 'UNAUTHENTICATED'],
    [new PlanGenerationRunNotFoundError(), 'RESOURCE_NOT_FOUND'],
    [new Error('private SQL / credential detail'), 'STREAM_UNAVAILABLE'],
  ])(
    'closes an established stream with a safe error, without mutating the run (%s)',
    async (error, code) => {
      const f = fixture()
      const res = reply()
      await f.open(res)
      if (code === 'UNAUTHENTICATED') f.revalidateUser.mockRejectedValue(error)
      else f.execute.mockRejectedValue(error)
      await vi.advanceTimersByTimeAsync(PLAN_STREAM_INTERVAL_MS)
      expect(res.write).toHaveBeenCalledWith(
        `event: stream-error\ndata: ${JSON.stringify({ code })}\n\n`,
      )
      expect(JSON.stringify(res.write.mock.calls)).not.toContain('private SQL')
      expect(res.end).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('does not overlap slow queries or send their results after the browser disconnects', async () => {
    const f = fixture()
    const res = reply()
    await f.open(res)
    let resolve!: (value: PlanGenerationRunStatusResponse) => void
    f.execute.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.execute).toHaveBeenCalledTimes(2)
    res.emit('close')
    resolve({ ...snapshot, version: 1, status: 'RUNNING' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(res.write).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles disconnect during the first database read without a leaked timer or slot', async () => {
    const f = fixture()
    const res = reply()
    let resolve!: (value: PlanGenerationRunStatusResponse) => void
    f.execute.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const pending = f.open(res)
    await vi.advanceTimersByTimeAsync(0)
    res.emit('close')
    resolve(snapshot)
    await pending
    expect(res.flushHeaders).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    f.execute.mockResolvedValue(snapshot)
    for (let i = 0; i < 3; i++) await f.open()
    f.service.beforeApplicationShutdown()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds connections per user, releases slots on disconnect and closes all on shutdown', async () => {
    const f = fixture()
    const res = reply()
    await f.open(res)
    await f.open()
    await f.open()
    await expect(f.open()).rejects.toMatchObject({ status: 429 })
    res.emit('close')
    await f.open()
    f.service.beforeApplicationShutdown()
    expect(vi.getTimerCount()).toBe(0)
    await expect(f.open()).rejects.toMatchObject({ status: 503 })
  })

  it('disconnects slow readers instead of queuing unbounded writes', async () => {
    const f = fixture()
    const res = reply()
    res.write.mockReturnValue(false)
    await f.open(res)
    expect(res.destroy).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('enforces the process-wide cap across different users', async () => {
    const f = fixture()
    for (let i = 0; i < 100; i++) {
      const userId = `user-${i}`
      f.revalidateUser.mockResolvedValue({ id: userId })
      await f.open(reply(), userId)
    }
    await expect(f.open(reply(), 'overflow')).rejects.toMatchObject({ status: 429 })
    f.service.beforeApplicationShutdown()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['SUCCEEDED', 'FAILED', 'TIMED_OUT'] as const)(
    'sends an already %s snapshot once and does not start a timer',
    async (status) => {
      const f = fixture()
      const res = reply()
      f.execute.mockResolvedValue({ ...snapshot, status, version: 2 })
      await f.open(res)
      expect(res.write).toHaveBeenCalledTimes(2)
      expect(res.end).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('conceals an initial database failure in a 503 and releases its connection slot', async () => {
    const f = fixture()
    const res = reply()
    f.execute.mockRejectedValue(new Error('private database detail'))
    await expect(f.open(res)).rejects.toMatchObject({
      status: 503,
      response: { code: 'STREAM_UNAVAILABLE' },
    })
    expect(res.flushHeaders).not.toHaveBeenCalled()
    expect(res.listenerCount('close')).toBe(0)
    f.execute.mockResolvedValue(snapshot)
    for (let i = 0; i < 3; i++) await f.open()
    f.service.beforeApplicationShutdown()
  })
})
