import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribePlanGenerationRun } from '../app/lib/plan-generation-stream'

const runId = 'abfe5ca9-5873-49df-bbf0-f45667a41d55'
const snapshot = {
  generationRunId: runId,
  goalId: '69057518-5456-4e20-a956-1c2c021452f3',
  version: 1,
  status: 'RUNNING',
  queuedAt: '2026-09-17T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  error: null,
  plan: null,
}
function fixture() {
  const sources: FakeSource[] = []
  class FakeSource extends EventTarget {
    close = vi.fn()
    constructor(
      readonly url: URL,
      readonly options: EventSourceInit,
    ) {
      super()
      sources.push(this)
    }
  }
  vi.stubGlobal('EventSource', FakeSource)
  const handlers = { onOpen: vi.fn(), onSnapshot: vi.fn(), onIssue: vi.fn() }
  const subscription = subscribePlanGenerationRun('https://test.example/api', runId, handlers)
  const source = sources[0]!
  const emit = (type: string, data: unknown) =>
    source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }))
  return { source, handlers, subscription, emit }
}
afterEach(() => vi.unstubAllGlobals())
describe('R13 browser EventSource transport (not C2 coordination)', () => {
  it('preserves the API prefix, sends cookies, validates snapshots and reports native reconnects', () => {
    const f = fixture()
    expect(f.source.url.href).toBe(`https://test.example/api/plan-generation-runs/${runId}/events`)
    expect(f.source.options).toEqual({ withCredentials: true })
    f.source.dispatchEvent(new Event('open'))
    f.emit('snapshot', snapshot)
    f.source.dispatchEvent(new Event('error'))
    f.source.dispatchEvent(new Event('open'))
    expect(f.handlers.onOpen).toHaveBeenCalledTimes(2)
    expect(f.handlers.onSnapshot).toHaveBeenCalledWith(snapshot)
    expect(f.handlers.onIssue).toHaveBeenCalledWith({ kind: 'connection' })
    expect(f.source.close).not.toHaveBeenCalled()
    f.subscription.close()
  })
  it('removes listeners and closes once; no callbacks after close', () => {
    const f = fixture()
    f.subscription.close()
    f.subscription.close()
    f.emit('snapshot', snapshot)
    f.source.dispatchEvent(new Event('open'))
    f.source.dispatchEvent(new Event('error'))
    expect(f.source.close).toHaveBeenCalledOnce()
    for (const handler of Object.values(f.handlers)) expect(handler).not.toHaveBeenCalled()
  })
  it.each([
    { ...snapshot, version: -1 },
    { ...snapshot, generationRunId: '69057518-5456-4e20-a956-1c2c021452f3' },
    { token: 'must-not-be-used' },
  ])('rejects invalid protocol data and closes the transport', (invalid) => {
    const f = fixture()
    f.emit('snapshot', invalid)
    expect(f.handlers.onSnapshot).not.toHaveBeenCalled()
    expect(f.handlers.onIssue).toHaveBeenCalledWith({ kind: 'protocol' })
    expect(f.source.close).toHaveBeenCalledOnce()
  })
  it('closes on an explicit server error rather than endlessly retrying invalid credentials', () => {
    const f = fixture()
    f.emit('stream-error', { code: 'UNAUTHENTICATED' })
    expect(f.handlers.onIssue).toHaveBeenCalledWith({ kind: 'server', code: 'UNAUTHENTICATED' })
    expect(f.source.close).toHaveBeenCalledOnce()
  })
})
