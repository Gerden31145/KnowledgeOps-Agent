import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, type EffectScope } from 'vue'
import { QueryClient } from '@tanstack/vue-query'
import type { CancelVerificationRunResponse } from '@knowledgeops/contracts'
import { useCancelVerificationRun } from '../app/composables/use-cancel-verification-run'
import { KnowledgeOpsApiError } from '../app/lib/knowledge-ops-api'
import { knowledgeOpsQueryKeys as keys } from '../app/lib/query-keys'
import { noteRun, taskDetail, runId, taskId, otherRunId } from './fixtures/note-verification'

const ports = vi.hoisted(() => ({ cancel: vi.fn(), client: undefined as unknown as QueryClient }))
vi.mock('../app/composables/use-knowledge-ops-api', () => ({
  useKnowledgeOpsApi: () => ({ cancelVerificationRun: ports.cancel }),
}))
vi.mock('@tanstack/vue-query', async (original) => ({
  ...(await original<typeof import('@tanstack/vue-query')>()),
  useQueryClient: () => ports.client,
}))
let scope: EffectScope
const receipt = (): CancelVerificationRunResponse => ({
  runId,
  taskId,
  status: 'CANCEL_REQUESTED',
  version: 2,
})
function mount() {
  const run = ref(noteRun({ status: 'RUNNING', version: 1, report: null }))
  const cancel = scope.run(() => useCancelVerificationRun(() => run.value))!
  return { run, cancel }
}
beforeEach(() => {
  vi.clearAllMocks()
  ports.client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  ports.client.setQueryData(keys.task(taskId), taskDetail({ state: 'VERIFYING' }))
  ports.cancel.mockResolvedValue(receipt())
  scope = effectScope()
})
afterEach(() => {
  scope.stop()
  ports.client.clear()
})

describe('R15 cancellation command and server confirmation', () => {
  it('blocks repeated clicks, refreshes related queries, and waits for persisted cancellation', async () => {
    let resolve!: (value: CancelVerificationRunResponse) => void
    ports.cancel.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const invalidate = vi.spyOn(ports.client, 'invalidateQueries')
    const { run, cancel } = mount()
    const pending = cancel.cancel()
    await cancel.cancel()
    expect(ports.cancel).toHaveBeenCalledExactlyOnceWith(runId, { expectedRunVersion: 1 })
    expect(cancel.busy.value).toBe(true)
    resolve(receipt())
    await pending
    expect(cancel.waiting.value).toBe(true)
    expect(cancel.canCancel.value).toBe(false)
    expect(run.value.status).toBe('RUNNING')
    expect(ports.client.getQueryData(keys.task(taskId))).toMatchObject({ state: 'VERIFYING' })
    expect(invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual([
      keys.task(taskId),
      keys.todayTasks(),
      keys.plan(taskDetail().stage.plan.id),
    ])
    run.value = noteRun({ status: 'CANCELLED', version: 3, report: null })
    expect(cancel.waiting.value).toBe(false)
    expect(cancel.canCancel.value).toBe(false)
  })

  it('keeps a lost response uncertain, refreshes first and only retries on another user action', async () => {
    ports.cancel.mockRejectedValueOnce(new TypeError('fixture-secret'))
    const { run, cancel } = mount()
    await cancel.cancel()
    expect(cancel.issue.value).toContain('尚未确认')
    expect(cancel.issue.value).not.toContain('fixture-secret')
    expect(run.value.status).toBe('RUNNING')
    expect(ports.cancel).toHaveBeenCalledTimes(1)
    await cancel.cancel()
    expect(ports.cancel).toHaveBeenCalledTimes(2)
    expect(ports.cancel.mock.calls[1]).toEqual([runId, { expectedRunVersion: 1 }])
    expect(cancel.waiting.value).toBe(true)
  })

  it('refreshes on version conflict and uses the newly observed version on explicit retry', async () => {
    ports.cancel.mockRejectedValueOnce(new KnowledgeOpsApiError('private', 409, 'CONFLICT', null))
    const { run, cancel } = mount()
    await cancel.cancel()
    expect(cancel.issue.value).toContain('运行已变化')
    run.value = noteRun({ status: 'RUNNING', version: 4, report: null })
    await cancel.cancel()
    expect(ports.cancel.mock.calls[1]).toEqual([runId, { expectedRunVersion: 4 }])
  })

  it('does not claim cancellation when a success response wins the race', async () => {
    ports.cancel.mockResolvedValueOnce({ ...receipt(), status: 'SUCCEEDED' })
    const { run, cancel } = mount()
    await cancel.cancel()
    expect(cancel.waiting.value).toBe(false)
    expect(cancel.message.value).toContain('运行已结束')
    expect(run.value.status).toBe('RUNNING')
    run.value = noteRun({ status: 'SUCCEEDED', version: 2 })
    expect(cancel.canCancel.value).toBe(false)
  })

  it('does not resend when reopening an already cancelling or terminal Run', async () => {
    const { run, cancel } = mount()
    for (const status of [
      'CANCEL_REQUESTED',
      'CANCELLED',
      'SUCCEEDED',
      'FAILED',
      'TIMED_OUT',
    ] as const) {
      run.value = noteRun({ status })
      await cancel.cancel()
    }
    expect(ports.cancel).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'])(
    'ignores late %s after switching away from the Run',
    async (kind) => {
      let resolve!: (value: CancelVerificationRunResponse) => void, reject!: (error: Error) => void
      ports.cancel.mockReturnValueOnce(
        new Promise((yes, no) => {
          resolve = yes
          reject = no
        }),
      )
      const invalidate = vi.spyOn(ports.client, 'invalidateQueries')
      const { cancel } = mount()
      const pending = cancel.cancel()
      scope.stop()
      if (kind === 'resolve') resolve(receipt())
      else reject(new Error('late-private'))
      await pending
      expect(invalidate).not.toHaveBeenCalled()
      expect(cancel.issue.value).toBe('')
      expect(cancel.message.value).toBe('')
    },
  )

  it('refuses mismatched receipt identity', async () => {
    ports.cancel.mockResolvedValueOnce({ ...receipt(), runId: otherRunId })
    const { cancel } = mount()
    await cancel.cancel()
    expect(cancel.waiting.value).toBe(false)
    expect(cancel.issue.value).toContain('尚未确认')
  })

  it('retains the accepted intent if the subsequent GET fails', async () => {
    vi.spyOn(ports.client, 'invalidateQueries').mockRejectedValueOnce(new Error('offline'))
    const { cancel } = mount()
    await cancel.cancel()
    expect(cancel.waiting.value).toBe(true)
    expect(cancel.issue.value).toContain('状态读取失败')
    expect(cancel.busy.value).toBe(false)
  })
})
