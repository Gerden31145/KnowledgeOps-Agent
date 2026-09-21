import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, shallowRef, type EffectScope, type ShallowRef } from 'vue'
import { QueryClient } from '@tanstack/vue-query'
import type { SessionResponse } from '@knowledgeops/contracts'
import type { PlanStreamHandlers } from '../app/lib/plan-generation-stream'
import type { RunSnapshot } from '../app/lib/plan-run-recovery.exercise'
import { knowledgeOpsQueryKeys } from '../app/lib/query-keys'
import { usePlanRunRecovery } from '../app/composables/use-plan-run-recovery'

const ports = vi.hoisted(() => ({
  read: vi.fn(),
  subscribe: vi.fn(),
  navigate: vi.fn(),
  client: undefined as unknown as QueryClient,
  user: undefined as unknown as ShallowRef<SessionResponse['user'] | null>,
}))
vi.mock('#imports', () => ({
  useRuntimeConfig: () => ({ public: { apiBaseUrl: 'http://127.0.0.1:4000' } }),
  navigateTo: ports.navigate,
}))
vi.mock('@tanstack/vue-query', async (original) => ({
  ...(await original<typeof import('@tanstack/vue-query')>()),
  useQueryClient: () => ports.client,
}))
vi.mock('../app/composables/use-knowledge-ops-api', () => ({
  useKnowledgeOpsApi: () => ({ getPlanGenerationRun: ports.read }),
}))
vi.mock('../app/composables/use-session-user', () => ({ useSessionUser: () => ports.user }))
vi.mock('../app/lib/plan-generation-stream', () => ({
  subscribePlanGenerationRun: ports.subscribe,
}))

const runId = 'abfe5ca9-5873-49df-bbf0-f45667a41d55'
const otherRunId = '69057518-5456-4e20-a956-1c2c021452f3'
const snapshot: RunSnapshot = {
  generationRunId: runId,
  goalId: otherRunId,
  version: 1,
  status: 'RUNNING',
  queuedAt: '2026-09-18T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  error: null,
  plan: null,
}
let scope: EffectScope
let streams: Array<{ handlers: PlanStreamHandlers; close: ReturnType<typeof vi.fn> }>

function mount(id = shallowRef<string | null>(runId)) {
  return { id, view: scope.run(() => usePlanRunRecovery(id))! }
}

describe('Plan Run Vue / Query integration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    scope = effectScope()
    streams = []
    ports.client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    ports.user = shallowRef({
      id: otherRunId,
      githubLogin: 'recovery-fixture',
      timezone: 'Asia/Shanghai',
    })
    ports.read.mockImplementation(() => new Promise(() => {}))
    ports.subscribe.mockImplementation((_base, _id, handlers: PlanStreamHandlers) => {
      const stream = { handlers, close: vi.fn() }
      streams.push(stream)
      return stream
    })
  })
  afterEach(() => {
    scope.stop()
    ports.client.clear()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('restores matching cache, retains visible progress on connection errors and clears the error on recovery', () => {
    ports.client.setQueryData(knowledgeOpsQueryKeys.generationRun(runId), snapshot)
    const { view } = mount()
    expect(view.data.value).toEqual(snapshot)
    expect(view.mode.value).toBe('connecting')
    expect(ports.read).toHaveBeenCalledOnce()
    streams[0]!.handlers.onOpen()
    streams[0]!.handlers.onIssue({ kind: 'connection' })
    expect(view.data.value?.status).toBe('RUNNING')
    expect(view.error.value?.message).toContain('重连')
    expect(view.isError.value).toBe(false)
    streams[0]!.handlers.onSnapshot(snapshot)
    expect(view.error.value).toBeNull()
  })

  it('switches URL targets without accepting old callbacks, and disposes requests and SSE with the Vue scope', () => {
    const { id, view } = mount()
    const firstSignal = ports.read.mock.calls[0]![1] as AbortSignal
    id.value = otherRunId
    expect(firstSignal.aborted).toBe(true)
    expect(streams[0]!.close).toHaveBeenCalledOnce()
    streams[0]!.handlers.onSnapshot(snapshot)
    expect(view.data.value).toBeUndefined()
    expect(ports.client.getQueryData(knowledgeOpsQueryKeys.generationRun(runId))).toBeUndefined()
    scope.stop()
    expect(streams[1]!.close).toHaveBeenCalledOnce()
    expect((ports.read.mock.calls[1]![1] as AbortSignal).aborted).toBe(true)
  })

  it('clears visible and cached data for denied ownership without offering a no-op refresh', () => {
    ports.client.setQueryData(knowledgeOpsQueryKeys.generationRun(runId), snapshot)
    const { view } = mount()
    streams[0]!.handlers.onIssue({ kind: 'server', code: 'RESOURCE_NOT_FOUND' })
    expect(view.data.value).toBeUndefined()
    expect(ports.client.getQueryData(knowledgeOpsQueryKeys.generationRun(runId))).toBeUndefined()
    expect(view.isError.value).toBe(true)
    expect(view.canRefresh.value).toBe(false)
    expect(ports.navigate).not.toHaveBeenCalled()
  })

  it('clears session and all Query data before redirecting on stream auth failure', () => {
    ports.client.setQueryData(knowledgeOpsQueryKeys.generationRun(runId), snapshot)
    const { view } = mount()
    streams[0]!.handlers.onIssue({ kind: 'server', code: 'UNAUTHENTICATED' })
    expect(ports.user.value).toBeNull()
    expect(view.data.value).toBeUndefined()
    expect(ports.client.getQueryCache().getAll()).toHaveLength(0)
    expect(streams[0]!.close).toHaveBeenCalledOnce()
    expect(ports.navigate).toHaveBeenCalledExactlyOnceWith('/login')
  })

  it('stops synchronization when logout clears the session', () => {
    const { view } = mount()
    ports.user.value = null
    expect(view.mode.value).toBe('idle')
    expect(view.data.value).toBeUndefined()
    expect(streams[0]!.close).toHaveBeenCalledOnce()
    expect((ports.read.mock.calls[0]![1] as AbortSignal).aborted).toBe(true)
  })
})
