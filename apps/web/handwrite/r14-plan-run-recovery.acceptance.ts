import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  initialRecoveryState,
  reducePlanRunRecovery as reduce,
  type RecoveryEvent,
  type RecoveryState,
  type RunSnapshot,
} from '../app/lib/plan-run-recovery.exercise'
import {
  createPlanRunRecovery,
  RECOVERY_FALLBACK_MS,
  RECOVERY_POLL_MS,
} from '../app/lib/plan-run-recovery-driver'
import { KnowledgeOpsApiError } from '../app/lib/knowledge-ops-api'
import type { PlanStreamHandlers } from '../app/lib/plan-generation-stream'

const A = 'abfe5ca9-5873-49df-bbf0-f45667a41d55'
const B = '69057518-5456-4e20-a956-1c2c021452f3'
function snapshot(version = 1, status: RunSnapshot['status'] = 'RUNNING', id = A): RunSnapshot {
  return {
    generationRunId: id,
    goalId: '2359b0ab-c51e-40df-ac45-7e52e79c8380',
    version,
    status,
    queuedAt: '2026-09-17T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    error: null,
    plan: status === 'SUCCEEDED' ? { id: B, status: 'DRAFT' } : null,
  }
}
function running(data = snapshot()): RecoveryState {
  return { runId: A, epoch: 7, mode: 'streaming', snapshot: data, issue: null, refreshKey: 1 }
}
const receive = (state: RecoveryState, data: RunSnapshot) =>
  reduce(state, { type: 'snapshot', epoch: state.epoch, snapshot: data })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const flush = () => vi.advanceTimersByTimeAsync(0)
function fixture() {
  const reads: Array<
    ReturnType<typeof deferred<RunSnapshot>> & { runId: string; signal: AbortSignal }
  > = []
  const streams: Array<{
    runId: string
    handlers: PlanStreamHandlers
    close: ReturnType<typeof vi.fn>
  }> = []
  const cache = vi.fn()
  const changed = vi.fn()
  const controller = createPlanRunRecovery({
    read: (runId, signal) => {
      const item = { ...deferred<RunSnapshot>(), runId, signal }
      reads.push(item)
      return item.promise
    },
    subscribe: (runId, handlers) => {
      const item = { runId, handlers, close: vi.fn() }
      streams.push(item)
      return item
    },
    cache,
    changed,
  })
  return { controller, reads, streams, cache, changed }
}

describe('C2: PlanGenerationRun snapshot recovery (10 acceptance scenarios)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('1. selects a run, restores only matching cache, and invalidates the batch on stop', () => {
    const initial = Object.freeze(initialRecoveryState())
    const selected = reduce(initial, { type: 'select', runId: A, cached: snapshot(4) })
    expect(selected).toMatchObject({
      runId: A,
      mode: 'connecting',
      snapshot: snapshot(4),
      issue: null,
    })
    expect(selected.epoch).toBeGreaterThan(initial.epoch)
    expect(selected.refreshKey).toBeGreaterThan(initial.refreshKey)
    const wrongCache = reduce(selected, { type: 'select', runId: B, cached: snapshot(9) })
    expect(wrongCache.snapshot).toBeUndefined()
    expect(wrongCache.epoch).toBeGreaterThan(selected.epoch)
    for (const event of [
      { type: 'stop' },
      { type: 'select', runId: null },
    ] satisfies RecoveryEvent[]) {
      const stopped = reduce(selected, event)
      expect(stopped).toMatchObject({ runId: null, mode: 'idle', snapshot: undefined, issue: null })
      expect(stopped.epoch).toBeGreaterThan(selected.epoch)
      // 无目标时任何异步错误都不能改变本地状态。
      for (const kind of ['connection', 'unavailable', 'unauthorized', 'not-found'] as const)
        expect(
          reduce(stopped, {
            type: 'issue',
            epoch: stopped.epoch,
            issue: { kind, message: 'late notification' },
          }),
        ).toEqual(stopped)
    }
    expect(initial).toEqual(initialRecoveryState())
  })

  it('2. accepts newer snapshots without mutation, rejects wrong Run / old / duplicate versions', () => {
    const current = Object.freeze(running(Object.freeze(snapshot(2))))
    const next = Object.freeze(snapshot(3))
    expect(receive(current, next).snapshot).toBe(next)
    for (const incoming of [
      snapshot(1),
      snapshot(2),
      snapshot(1, 'FAILED'),
      snapshot(100, 'RUNNING', B),
    ]) {
      expect(receive(current, incoming).snapshot).toBe(current.snapshot)
      expect(receive(current, incoming).mode).toBe('streaming')
    }
    const empty = { ...current, snapshot: undefined }
    expect(receive(empty, snapshot(0, 'QUEUED')).snapshot?.version).toBe(0)
    expect(current.snapshot?.version).toBe(2)
  })

  it('3. all three terminal states stop synchronization and cannot be overwritten by late events', () => {
    for (const status of ['SUCCEEDED', 'FAILED', 'TIMED_OUT'] as const) {
      const state = receive(running(), snapshot(2, status))
      expect(state.mode).toBe('stopped')
      expect(state.snapshot?.status).toBe(status)
      for (const event of [
        { type: 'snapshot', epoch: state.epoch, snapshot: snapshot(99) },
        { type: 'opened', epoch: state.epoch },
        { type: 'issue', epoch: state.epoch, issue: { kind: 'connection', message: 'offline' } },
        { type: 'fallback-due', epoch: state.epoch },
        { type: 'refresh' },
      ] satisfies RecoveryEvent[])
        expect(reduce(state, event)).toEqual(state)
      // 缓存已经是终态时，即使校准到重复/更旧快照也不能重新等待下一条变化。
      const cached = { ...state, mode: 'connecting' as const }
      expect(receive(cached, snapshot(99, 'RUNNING', B))).toEqual(cached)
      expect(receive(cached, snapshot(1)).snapshot).toBe(state.snapshot)
      expect(receive(cached, snapshot(2, status)).mode).toBe('stopped')
      const denied = reduce(cached, {
        type: 'issue',
        epoch: cached.epoch,
        issue: { kind: 'unauthorized', message: 'login expired' },
      })
      expect(denied.snapshot).toBeUndefined()
      expect(denied.issue?.kind).toBe('unauthorized')
    }
  })

  it('4. rejects old-batch success, failure and open even after switching A → B → A', () => {
    const first = reduce(initialRecoveryState(), { type: 'select', runId: A })
    const second = reduce(first, { type: 'select', runId: B })
    const current = reduce(second, { type: 'select', runId: A })
    expect(current.epoch).toBeGreaterThan(first.epoch)
    for (const event of [
      { type: 'snapshot', epoch: first.epoch, snapshot: snapshot(9) },
      {
        type: 'issue',
        epoch: first.epoch,
        issue: { kind: 'unauthorized', message: 'old session' },
      },
      { type: 'opened', epoch: first.epoch },
      { type: 'fallback-due', epoch: first.epoch },
    ] satisfies RecoveryEvent[])
      expect(reduce(current, event)).toEqual(current)
    const withIssue: RecoveryState = {
      ...current,
      issue: { kind: 'unavailable', message: 'current issue' },
    }
    for (const epoch of [first.epoch, current.epoch + 1]) {
      for (const event of [
        { type: 'opened', epoch },
        { type: 'snapshot', epoch, snapshot: snapshot(9) },
        { type: 'issue', epoch, issue: { kind: 'unauthorized', message: 'wrong batch' } },
        { type: 'fallback-due', epoch },
      ] satisfies RecoveryEvent[])
        expect(reduce(withIssue, event)).toEqual(withIssue)
    }
  })

  it('5. integrates initial HTTP/SSE racing through one cache write gate', async () => {
    const f = fixture()
    f.controller.select(A)
    expect(f.reads).toHaveLength(1)
    expect(f.streams).toHaveLength(1)
    const newer = snapshot(5)
    f.streams[0]!.handlers.onSnapshot(newer)
    f.reads[0]!.resolve(snapshot(1))
    await flush()
    expect(f.controller.state.snapshot).toBe(newer)
    expect(f.cache).toHaveBeenCalledExactlyOnceWith(A, newer)
    f.streams[0]!.handlers.onSnapshot(snapshot(5))
    expect(f.cache).toHaveBeenCalledTimes(1)
    f.controller.dispose()
  })

  it('6. calibrates on initial open, reconnect and manual refresh; recovers a terminal missed offline', async () => {
    const f = fixture()
    f.controller.select(A)
    expect(f.reads).toHaveLength(1)
    f.reads[0]!.resolve(snapshot())
    await flush()
    const stream = f.streams[0]!
    stream.handlers.onOpen()
    expect(f.controller.state.mode).toBe('streaming')
    expect(f.reads).toHaveLength(2)
    f.reads[1]!.resolve(snapshot())
    await flush()
    f.controller.refresh()
    expect(f.reads).toHaveLength(3)
    f.reads[2]!.resolve(snapshot())
    await flush()
    stream.handlers.onIssue({ kind: 'connection' })
    expect(f.controller.state.mode).toBe('connecting')
    expect(f.controller.state.issue?.kind).toBe('connection')
    expect(f.controller.state.snapshot?.status).toBe('RUNNING')
    expect(f.reads).toHaveLength(4) // opaque SSE error → HTTP probe can reveal 401
    f.reads[3]!.resolve(snapshot())
    await flush()
    stream.handlers.onOpen()
    expect(f.reads).toHaveLength(5)
    f.reads[4]!.resolve(snapshot(2, 'SUCCEEDED'))
    await flush()
    expect(f.controller.state.mode).toBe('stopped')
    expect(stream.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    f.controller.dispose()
  })

  it('7. falls back after a connection deadline and never leaves SSE and periodic polling running together', async () => {
    const f = fixture()
    f.controller.select(A)
    expect(f.reads).toHaveLength(1)
    f.reads[0]!.resolve(snapshot())
    await flush()
    await vi.advanceTimersByTimeAsync(RECOVERY_FALLBACK_MS)
    expect(f.controller.state.mode).toBe('polling')
    expect(f.streams[0]!.close).toHaveBeenCalledOnce()
    expect(f.reads).toHaveLength(2)
    f.streams[0]!.handlers.onOpen() // 已关闭传输的迟到回调，不能恢复并行连接
    expect(f.controller.state.mode).toBe('polling')
    f.reads[1]!.resolve(snapshot())
    await flush()
    await vi.advanceTimersByTimeAsync(RECOVERY_POLL_MS)
    expect(f.reads).toHaveLength(3)
    expect(f.streams).toHaveLength(1)
    f.reads[2]!.resolve(snapshot(2, 'TIMED_OUT'))
    await flush()
    expect(vi.getTimerCount()).toBe(0)
    f.controller.dispose()
  })

  it('8. degrades explicit unavailable streams, retries HTTP serially and preserves business state on network errors', async () => {
    const f = fixture()
    f.controller.select(A)
    expect(f.reads).toHaveLength(1)
    f.reads[0]!.resolve(snapshot())
    await flush()
    f.streams[0]!.handlers.onIssue({ kind: 'protocol' })
    expect(f.controller.state.mode).toBe('polling')
    expect(f.reads).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(RECOVERY_POLL_MS * 3)
    expect(f.reads).toHaveLength(2) // 未完成的请求不能叠加下一轮
    f.reads[1]!.reject(new TypeError('Failed to fetch'))
    await flush()
    expect(f.controller.state.snapshot?.status).toBe('RUNNING')
    expect(f.controller.state.issue?.kind).toBe('unavailable')
    await vi.advanceTimersByTimeAsync(RECOVERY_POLL_MS)
    expect(f.reads).toHaveLength(3)
    f.reads[2]!.resolve(snapshot())
    await flush()
    expect(f.controller.state.issue).toBeNull()
    f.controller.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('9. stops and clears visible data for HTTP 401/404 or explicit stream auth/ownership failure', async () => {
    for (const source of ['http-401', 'http-404', 'stream-401', 'stream-404'] as const) {
      const f = fixture()
      f.controller.select(A, snapshot())
      expect(f.reads).toHaveLength(1)
      if (source.startsWith('http')) {
        f.reads[0]!.reject(
          new KnowledgeOpsApiError(
            'private detail',
            source === 'http-401' ? 401 : 404,
            'fixture',
            null,
          ),
        )
        await flush()
      } else {
        f.streams[0]!.handlers.onIssue({
          kind: 'server',
          code: source === 'stream-401' ? 'UNAUTHENTICATED' : 'RESOURCE_NOT_FOUND',
        })
      }
      expect(f.controller.state.mode).toBe('stopped')
      expect(f.controller.state.snapshot).toBeUndefined()
      expect(f.controller.state.issue?.kind).toBe(
        source.endsWith('401') ? 'unauthorized' : 'not-found',
      )
      expect(f.cache).toHaveBeenLastCalledWith(A, undefined)
      await vi.advanceTimersByTimeAsync(RECOVERY_FALLBACK_MS * 2)
      expect(f.reads).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
      f.controller.dispose()
    }
  })

  it('10. cleans old resources on switch/unmount and ignores late responses from an uncooperative request', async () => {
    const f = fixture()
    f.controller.select(A)
    expect(f.reads).toHaveLength(1)
    f.controller.select(B)
    expect(f.reads[0]!.signal.aborted).toBe(true)
    expect(f.streams[0]!.close).toHaveBeenCalledOnce()
    f.reads[0]!.resolve(snapshot(8))
    await flush()
    expect(f.controller.state.runId).toBe(B)
    expect(f.cache).not.toHaveBeenCalled()
    f.controller.dispose()
    expect(f.reads[1]!.signal.aborted).toBe(true)
    expect(f.streams[1]!.close).toHaveBeenCalledOnce()
    f.reads[1]!.resolve(snapshot(9, 'RUNNING', B))
    await flush()
    expect(f.cache).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
