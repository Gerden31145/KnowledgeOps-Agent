import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, type EffectScope } from 'vue'
import { QueryClient } from '@tanstack/vue-query'
import { useRetryNoteVerification } from '../app/composables/use-retry-note-verification'
import { KnowledgeOpsApiError } from '../app/lib/knowledge-ops-api'
import { knowledgeOpsQueryKeys as keys } from '../app/lib/query-keys'
import { noteRun, taskDetail, runId, taskId, otherRunId } from './fixtures/note-verification'

const ports = vi.hoisted(() => ({ retry: vi.fn(), client: undefined as unknown as QueryClient }))
vi.mock('../app/composables/use-knowledge-ops-api', () => ({
  useKnowledgeOpsApi: () => ({ retryNoteVerification: ports.retry }),
}))
vi.mock('@tanstack/vue-query', async (original) => ({
  ...(await original<typeof import('@tanstack/vue-query')>()),
  useQueryClient: () => ports.client,
}))
const receipt = () => ({
  status: 'ACCEPTED' as const,
  taskId,
  runId: otherRunId,
  retryOfRunId: runId,
  taskVersion: 8,
})
let scope: EffectScope
function mount() {
  const run = ref(noteRun({ status: 'FAILED', version: 2, report: null }))
  const task = ref(
    taskDetail({
      version: 7,
      runs: [
        {
          id: runId,
          kind: 'NOTE_VERIFICATION',
          status: 'FAILED',
          errorCode: 'MODEL_TIMEOUT',
          queuedAt: run.value.queuedAt,
          startedAt: null,
          finishedAt: run.value.finishedAt,
        },
      ],
    }),
  )
  return {
    run,
    task,
    command: scope.run(() =>
      useRetryNoteVerification(() => ({ run: run.value, task: task.value })),
    )!,
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  ports.client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  ports.retry.mockResolvedValue(receipt())
  scope = effectScope()
})
afterEach(() => {
  scope.stop()
  ports.client.clear()
})

describe('R15 linked note retry UI', () => {
  it('sends the observed versions once, exposes the successor and refreshes without overwriting history', async () => {
    let resolve!: (value: ReturnType<typeof receipt>) => void
    ports.retry.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const invalidate = vi.spyOn(ports.client, 'invalidateQueries')
    const { run, task, command } = mount()
    const pending = command.retry()
    await command.retry()
    expect(command.busy.value).toBe(true)
    expect(ports.retry).toHaveBeenCalledExactlyOnceWith(runId, {
      expectedRunVersion: 2,
      expectedTaskVersion: 7,
    })
    resolve(receipt())
    await pending
    expect(command.retryRunId.value).toBe(otherRunId)
    expect(command.canRetry.value).toBe(false)
    expect(run.value.status).toBe('FAILED')
    expect(task.value.state).toBe('IN_PROGRESS')
    expect(invalidate.mock.calls.map(([options]) => options?.queryKey)).toEqual([
      keys.task(taskId),
      keys.todayTasks(),
      keys.plan(task.value.stage.plan.id),
    ])
  })

  it('finds a persisted successor after reopening without automatically sending a command', async () => {
    const { run, command } = mount()
    run.value.retryRunId = otherRunId
    expect(command.retryRunId.value).toBe(otherRunId)
    await command.retry()
    expect(ports.retry).not.toHaveBeenCalled()
  })

  it('keeps an unknown response uncertain and retries only after an explicit user action', async () => {
    ports.retry.mockRejectedValueOnce(new TypeError('private-network-error'))
    const { command } = mount()
    await command.retry()
    expect(command.issue.value).toContain('尚未确认')
    expect(command.issue.value).not.toContain('private-network-error')
    expect(command.retryRunId.value).toBeNull()
    expect(ports.retry).toHaveBeenCalledTimes(1)
    await command.retry()
    expect(ports.retry).toHaveBeenCalledTimes(2)
    expect(command.retryRunId.value).toBe(otherRunId)
  })

  it('finds an accepted retry through the refreshed old snapshot after a lost response', async () => {
    ports.retry.mockRejectedValueOnce(new TypeError('lost'))
    const { run, task, command } = mount()
    vi.spyOn(ports.client, 'invalidateQueries').mockImplementation(async () => {
      run.value.retryRunId = otherRunId
      task.value.state = 'VERIFYING'
    })
    await command.retry()
    expect(command.retryRunId.value).toBe(otherRunId)
    expect(command.canRetry.value).toBe(false)
    expect(ports.retry).toHaveBeenCalledTimes(1)
  })

  it.each(['SUCCEEDED', 'QUEUED', 'RUNNING', 'CANCEL_REQUESTED'] as const)(
    'does not retry Run status %s',
    async (status) => {
      const { run, command } = mount()
      run.value.status = status
      await command.retry()
      expect(ports.retry).not.toHaveBeenCalled()
    },
  )

  it.each(['PASSED', 'VERIFYING', 'BLOCKED', 'READY'] as const)(
    'does not retry Task state %s',
    async (state) => {
      const { task, command } = mount()
      task.value.state = state
      await command.retry()
      expect(ports.retry).not.toHaveBeenCalled()
    },
  )

  it('keeps historical Runs and inactive plans from offering a fresh retry', async () => {
    const { task, command } = mount()
    task.value.runs.unshift({ ...task.value.runs[0]!, id: otherRunId })
    await command.retry()
    task.value.runs.shift()
    task.value.stage.plan.status = 'ARCHIVED'
    await command.retry()
    expect(ports.retry).not.toHaveBeenCalled()
  })

  it('refreshes after a conflict and shows only a safe message', async () => {
    ports.retry.mockRejectedValueOnce(
      new KnowledgeOpsApiError('private conflict', 409, 'CONFLICT', null),
    )
    const invalidate = vi.spyOn(ports.client, 'invalidateQueries')
    const { command } = mount()
    await command.retry()
    expect(command.issue.value).toContain('任务或证据已变化')
    expect(command.issue.value).not.toContain('private')
    expect(invalidate).toHaveBeenCalled()
    expect(command.retryRunId.value).toBeNull()
  })

  it.each(['resolve', 'reject'])(
    'ignores late %s after switching Run or leaving',
    async (result) => {
      let resolve!: (value: ReturnType<typeof receipt>) => void, reject!: (error: Error) => void
      ports.retry.mockReturnValueOnce(
        new Promise((yes, no) => {
          resolve = yes
          reject = no
        }),
      )
      const invalidate = vi.spyOn(ports.client, 'invalidateQueries')
      const { command } = mount()
      const pending = command.retry()
      scope.stop()
      if (result === 'resolve') resolve(receipt())
      else reject(new Error('late'))
      await pending
      expect(command.receipt.value).toBeNull()
      expect(command.issue.value).toBe('')
      expect(invalidate).not.toHaveBeenCalled()
    },
  )

  it('rejects a receipt for another source', async () => {
    ports.retry.mockResolvedValueOnce({ ...receipt(), retryOfRunId: otherRunId })
    const { command } = mount()
    await command.retry()
    expect(command.retryRunId.value).toBeNull()
    expect(command.issue.value).toContain('尚未确认')
  })

  it('keeps the accepted destination when list refresh fails', async () => {
    vi.spyOn(ports.client, 'invalidateQueries').mockRejectedValueOnce(new TypeError('offline'))
    const { command } = mount()
    await command.retry()
    expect(command.retryRunId.value).toBe(otherRunId)
    expect(command.issue.value).toContain('列表更新失败')
    expect(command.busy.value).toBe(false)
  })
})
