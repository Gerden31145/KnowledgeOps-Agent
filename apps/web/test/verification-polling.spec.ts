import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, type EffectScope } from 'vue'
import { QueryClient, focusManager, onlineManager } from '@tanstack/vue-query'
import { AGENT_RUN_TERMINAL_STATES, type TaskDetailResponse } from '@knowledgeops/contracts'
import {
  useNoteVerificationRunQuery,
  useFollowUpAnswerQuery,
} from '../app/composables/use-workspace-queries'
import { knowledgeOpsQueryKeys as keys } from '../app/lib/query-keys'
import { KnowledgeOpsApiError } from '../app/lib/knowledge-ops-api'
import { VERIFICATION_POLL_MS } from '../app/lib/verification-polling'
import { noteRun, taskId, runId, otherRunId } from './fixtures/note-verification'
import { answerResponse, answerId, questionId } from './fixtures/follow-up-answer'

const ports = vi.hoisted(() => {
  // QueryObserver 在浏览器才安装轮询计时器；无需真实 DOM 或网络。
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  return { read: vi.fn(), client: undefined as unknown as QueryClient }
})
vi.mock('../app/composables/use-knowledge-ops-api', () => ({
  useKnowledgeOpsApi: () => ({ getNoteVerificationRun: ports.read, getFollowUpAnswer: ports.read }),
}))
vi.mock('@tanstack/vue-query', async (original) => {
  const library = await original<typeof import('@tanstack/vue-query')>()
  return {
    ...library,
    useQueryClient: () => ports.client,
    useQuery: (options: Parameters<typeof library.useQuery>[0]) =>
      library.useQuery(options, ports.client),
  }
})
let scope: EffectScope
const running = () => noteRun({ status: 'RUNNING', version: 1, report: null, finishedAt: null })
async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms)
  await nextTick()
}
const mount = () => scope.run(() => useNoteVerificationRunQuery(taskId, runId))!

describe('R15 selected verification run polling and recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    ports.read.mockReset().mockImplementation(async () => running())
    focusManager.setFocused(true)
    onlineManager.setOnline(true)
    ports.client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    ports.client.mount()
    scope = effectScope()
  })
  afterEach(() => {
    scope.stop()
    ports.client.unmount()
    ports.client.clear()
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each(AGENT_RUN_TERMINAL_STATES)('polls a running note and stops on %s', async (status) => {
    const query = mount()
    await tick()
    expect(query.data.value?.status).toBe('RUNNING')
    ports.read.mockResolvedValue(noteRun({ status }))
    await tick(VERIFICATION_POLL_MS)
    expect(query.data.value?.status).toBe(status)
    const calls = ports.read.mock.calls.length
    await tick(VERIFICATION_POLL_MS * 3)
    expect(ports.read).toHaveBeenCalledTimes(calls)
  })

  it('pauses the first read while offline, then reads the persisted result on reconnect', async () => {
    onlineManager.setOnline(false)
    ports.read.mockResolvedValue(noteRun())
    const query = mount()
    await tick(VERIFICATION_POLL_MS * 3)
    expect(ports.read).not.toHaveBeenCalled()
    expect(query.isPaused.value).toBe(true)
    expect(query.isError.value).toBe(false)
    onlineManager.setOnline(true)
    await tick()
    expect(ports.read).toHaveBeenCalledTimes(1)
    expect(query.data.value?.status).toBe('SUCCEEDED')
    expect(query.isPaused.value).toBe(false)
  })

  it('retains business state offline and recovers a result completed while disconnected', async () => {
    const query = mount()
    await tick()
    onlineManager.setOnline(false)
    await tick(VERIFICATION_POLL_MS * 3)
    expect(ports.read).toHaveBeenCalledTimes(1)
    expect(query.isPaused.value).toBe(true)
    expect(query.data.value?.status).toBe('RUNNING')
    ports.read.mockResolvedValue(noteRun())
    onlineManager.setOnline(true)
    await tick()
    expect(query.data.value?.status).toBe('SUCCEEDED')
    const calls = ports.read.mock.calls.length
    await tick(VERIFICATION_POLL_MS * 2)
    expect(ports.read).toHaveBeenCalledTimes(calls)
  })

  it('recovers from a transient GET failure without changing the Run to FAILED', async () => {
    const query = mount()
    await tick()
    ports.read.mockRejectedValueOnce(new TypeError('offline'))
    await tick(VERIFICATION_POLL_MS)
    expect(query.isError.value).toBe(true)
    expect(query.data.value?.status).toBe('RUNNING')
    ports.read.mockResolvedValue(noteRun())
    await tick(VERIFICATION_POLL_MS)
    expect(query.isSuccess.value).toBe(true)
    expect(query.data.value?.status).toBe('SUCCEEDED')
  })

  it.each([400, 401, 403, 404])('stops repeated reads for HTTP %i', async (status) => {
    const query = mount()
    await tick()
    ports.read.mockRejectedValue(new KnowledgeOpsApiError('denied', status, 'DENIED', null))
    await tick(VERIFICATION_POLL_MS)
    expect(query.isError.value).toBe(true)
    expect(query.data.value?.status).toBe('RUNNING')
    const calls = ports.read.mock.calls.length
    await tick(VERIFICATION_POLL_MS * 3)
    expect(ports.read).toHaveBeenCalledTimes(calls)
  })

  it('stops automatic polling after an identity mismatch', async () => {
    ports.read.mockResolvedValue(noteRun({ taskId: otherRunId }))
    const query = mount()
    await tick()
    expect(query.isError.value).toBe(true)
    expect(query.data.value).toBeUndefined()
    await tick(VERIFICATION_POLL_MS * 3)
    expect(ports.read).toHaveBeenCalledTimes(1)
  })

  it('rejects lower versions and terminal regression but refreshes metadata at the same terminal version', async () => {
    const query = mount()
    await tick()
    ports.read.mockResolvedValue(noteRun({ status: 'QUEUED', version: 0, report: null }))
    await tick(VERIFICATION_POLL_MS)
    expect(query.data.value?.status).toBe('RUNNING')
    ports.read.mockResolvedValue(noteRun({ status: 'QUEUED', version: 1, report: null }))
    await tick(VERIFICATION_POLL_MS)
    expect(query.data.value?.status).toBe('RUNNING')
    ports.read.mockResolvedValue(noteRun())
    await tick(VERIFICATION_POLL_MS)
    ports.read.mockResolvedValue(noteRun({ status: 'RUNNING', version: 3, report: null }))
    await query.refetch()
    expect(query.data.value?.status).toBe('SUCCEEDED')
    expect(query.data.value?.version).toBe(2)
    const refreshed = noteRun()
    refreshed.followUpQuestion = {
      id: questionId,
      criterionId: questionId,
      question: '合成追问',
      citations: [],
      answers: [{ id: answerId, createdAt: '2026-10-30T00:00:00.000Z' }],
    }
    ports.read.mockResolvedValue(refreshed)
    await query.refetch()
    expect(query.data.value?.followUpQuestion?.answers[0]?.id).toBe(answerId)
  })

  it('pauses background polling and calibrates on returning to the visible page', async () => {
    const query = mount()
    await tick()
    focusManager.setFocused(false)
    await tick(VERIFICATION_POLL_MS * 3)
    expect(ports.read).toHaveBeenCalledTimes(1)
    ports.read.mockResolvedValue(noteRun())
    focusManager.setFocused(true)
    await tick()
    expect(query.data.value?.status).toBe('SUCCEEDED')
  })

  it('refreshes Task, today and plan on a settled answer without looping on repeated reads', async () => {
    ports.client.setQueryData(keys.task(taskId), {
      id: taskId,
      stage: { plan: { id: otherRunId } },
    } as TaskDetailResponse)
    const invalidate = vi.spyOn(ports.client, 'invalidateQueries')
    const current = answerResponse()
    ports.read.mockResolvedValue({
      ...current,
      run: { ...current.run, status: 'RUNNING', version: 1 },
      report: null,
    })
    const query = scope.run(() => useFollowUpAnswerQuery(taskId, questionId, runId, answerId))!
    await tick()
    expect(invalidate).not.toHaveBeenCalled()
    ports.read.mockResolvedValue(current)
    await tick(VERIFICATION_POLL_MS)
    expect(query.data.value?.run.status).toBe('SUCCEEDED')
    expect(query.data.value?.report?.body.result.outcome).toBe('FAILED')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.task(taskId), exact: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.todayTasks(), exact: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.plan(otherRunId), exact: true })
    await query.refetch()
    await tick()
    expect(invalidate).toHaveBeenCalledTimes(3)
    ports.read.mockResolvedValue({
      ...current,
      run: { ...current.run, status: 'RUNNING', version: 1 },
      report: null,
    })
    await query.refetch()
    expect(query.data.value?.report).toEqual(current.report)
  })

  it('cancels a pending poll and releases its timer when leaving', async () => {
    mount()
    await tick()
    ports.read.mockImplementation(() => new Promise(() => {}))
    await tick(VERIFICATION_POLL_MS)
    const signal = ports.read.mock.calls.at(-1)![1] as AbortSignal
    scope.stop()
    expect(signal.aborted).toBe(true)
    const calls = ports.read.mock.calls.length
    await tick(VERIFICATION_POLL_MS * 3)
    expect(ports.read).toHaveBeenCalledTimes(calls)
  })
})
