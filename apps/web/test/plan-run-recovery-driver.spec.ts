import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPlanRunRecovery,
  RECOVERY_FALLBACK_MS,
  RECOVERY_POLL_MS,
} from '../app/lib/plan-run-recovery-driver'
import {
  initialRecoveryState,
  type RecoveryState,
  type RunSnapshot,
} from '../app/lib/plan-run-recovery.exercise'

const runId = 'abfe5ca9-5873-49df-bbf0-f45667a41d55'
// 固定输出夹具只验证适配器的资源执行，不提供任何事件决策/版本归并算法。
function harness(mode: RecoveryState['mode'] = 'connecting') {
  const selected: RecoveryState = {
    ...initialRecoveryState(),
    runId,
    epoch: 1,
    refreshKey: 1,
    mode,
  }
  const reduce = vi.fn().mockReturnValue(selected)
  let resolve!: (snapshot: RunSnapshot) => void
  const read = vi.fn<(id: string, signal: AbortSignal) => Promise<RunSnapshot>>(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const close = vi.fn()
  const subscribe = vi.fn().mockReturnValue({ close })
  const cache = vi.fn(),
    changed = vi.fn()
  const controller = createPlanRunRecovery({ read, subscribe, cache, changed }, reduce)
  return {
    selected,
    reduce,
    read,
    close,
    subscribe,
    cache,
    controller,
    resolve: (data: RunSnapshot) => resolve(data),
  }
}
describe('C2 resource adapter (fixed-state fixtures)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })
  it('opens resources selected by state, dispatches a timeout event and force-cleans on disposal', async () => {
    const f = harness()
    f.controller.select(runId)
    expect(f.subscribe).toHaveBeenCalledOnce()
    expect(f.read).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(RECOVERY_FALLBACK_MS)
    expect(f.reduce).toHaveBeenLastCalledWith(f.selected, { type: 'fallback-due', epoch: 1 })
    f.controller.dispose()
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.read.mock.calls[0]![1].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not open SSE in polling mode and waits until an HTTP request settles before scheduling the next', async () => {
    const f = harness('polling')
    f.controller.select(runId)
    await vi.advanceTimersByTimeAsync(RECOVERY_POLL_MS * 3)
    expect(f.subscribe).not.toHaveBeenCalled()
    expect(f.read).toHaveBeenCalledOnce()
    f.resolve({} as RunSnapshot)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(RECOVERY_POLL_MS)
    expect(f.read).toHaveBeenCalledTimes(2)
    f.controller.dispose()
  })
  it('publishes only a changed snapshot reference and aborts resources when the selected batch changes', () => {
    const f = harness()
    f.controller.select(runId)
    const data = { generationRunId: runId, version: 4 } as RunSnapshot
    const withData = { ...f.selected, snapshot: data }
    f.reduce.mockReturnValue(withData)
    f.controller.refresh()
    f.controller.refresh()
    expect(f.cache).toHaveBeenCalledExactlyOnceWith(runId, data)
    f.reduce.mockReturnValue({ ...initialRecoveryState(), epoch: 2 })
    f.controller.select(null)
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.read.mock.calls[0]![1].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    f.controller.dispose()
  })
})
