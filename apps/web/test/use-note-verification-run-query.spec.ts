import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import { QueryClient } from '@tanstack/vue-query'
import {
  useNoteVerificationRunQuery,
  useNoteRunEvidenceQuery,
  useFollowUpAnswerQuery,
} from '../app/composables/use-workspace-queries'
import { KnowledgeOpsApiError } from '../app/lib/knowledge-ops-api'
import { noteRun, noteEvidence, taskId, runId, otherRunId } from './fixtures/note-verification'
import type { NoteVerificationRunResponse } from '@knowledgeops/contracts'
import { answerResponse, answerId, questionId } from './fixtures/follow-up-answer'

const ports = vi.hoisted(() => ({ read: vi.fn(), client: undefined as unknown as QueryClient }))
vi.mock('../app/composables/use-knowledge-ops-api', () => ({
  useKnowledgeOpsApi: () => ({
    getNoteVerificationRun: ports.read,
    getNoteRunEvidence: ports.read,
    getFollowUpAnswer: ports.read,
  }),
}))
vi.mock('@tanstack/vue-query', async (original) => {
  const library = await original<typeof import('@tanstack/vue-query')>()
  return {
    ...library,
    useQuery: (options: Parameters<typeof library.useQuery>[0]) =>
      library.useQuery(options, ports.client),
  }
})

let scope: EffectScope
function mount() {
  const task = ref<string | null>(taskId)
  const run = ref<string | null>(runId)
  const query = scope.run(() => useNoteVerificationRunQuery(task, run))!
  return { task, run, query }
}
describe('Note report query isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ports.client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    scope = effectScope()
    ports.read.mockResolvedValue(noteRun())
  })
  afterEach(() => {
    scope.stop()
    ports.client.clear()
  })

  it('does not request a report until both task and run are selected', async () => {
    const run = ref<string | null>(null)
    const query = scope.run(() => useNoteVerificationRunQuery(taskId, run))!
    await nextTick()
    expect(ports.read).not.toHaveBeenCalled()
    run.value = runId
    await vi.waitFor(() => expect(query.isSuccess.value).toBe(true))
    expect(query.data.value?.report?.body.results[0]?.outcome).toBe('FAILED')
    expect(query.data.value?.status).toBe('SUCCEEDED')
  })

  it('cancels A on selecting B and ignores a late A response even if the transport resolves', async () => {
    let finishA!: (value: NoteVerificationRunResponse) => void
    ports.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishA = resolve
        }),
    )
    const { run, query } = mount()
    const signal = ports.read.mock.calls[0]![1] as AbortSignal
    ports.read.mockResolvedValueOnce(
      noteRun({ runId: otherRunId, report: null, status: 'RUNNING' }),
    )
    run.value = otherRunId
    await vi.waitFor(() => expect(query.data.value?.runId).toBe(otherRunId))
    expect(signal.aborted).toBe(true)
    finishA(noteRun())
    await nextTick()
    expect(query.data.value?.runId).toBe(otherRunId)
    expect(query.data.value?.report).toBeNull()
  })

  it.each([{ taskId: otherRunId }, { runId: otherRunId }])(
    'rejects mismatched snapshot identity %o',
    async (override) => {
      ports.read.mockResolvedValue(noteRun(override))
      const { query } = mount()
      await vi.waitFor(() => expect(query.isError.value).toBe(true))
      expect(query.data.value).toBeUndefined()
    },
  )

  it('uses separate task cache entries and does not carry a previous task report into the new task', async () => {
    const { task, query } = mount()
    await vi.waitFor(() => expect(query.isSuccess.value).toBe(true))
    ports.read.mockImplementation(() => new Promise(() => {}))
    task.value = otherRunId
    await nextTick()
    expect(query.data.value).toBeUndefined()
    expect(query.isPending.value).toBe(true)
  })

  it.each([
    new TypeError('offline'),
    new KnowledgeOpsApiError('denied', 401, 'UNAUTHENTICATED', null),
  ])('reports refresh errors independently of a previously completed Run', async (error) => {
    const { query } = mount()
    await vi.waitFor(() => expect(query.isSuccess.value).toBe(true))
    ports.read.mockRejectedValueOnce(error)
    await query.refetch()
    expect(query.isError.value).toBe(true)
    expect(query.error.value).toBe(error)
    expect(query.data.value?.status).toBe('SUCCEEDED')
    // 页面在 isError 分支隐藏缓存报告；不伪造 Run FAILED 来表示读取失败。
  })

  it('aborts the in-flight read on leaving the component', () => {
    ports.read.mockImplementation(() => new Promise(() => {}))
    mount()
    const signal = ports.read.mock.calls[0]![1] as AbortSignal
    scope.stop()
    expect(signal.aborted).toBe(true)
  })

  it('isolates fixed evidence when the old component unmounts while its read is still pending', async () => {
    let finish!: (value: ReturnType<typeof noteEvidence>) => void
    ports.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const old = scope.run(() => useNoteRunEvidenceQuery(taskId, runId))!
    const signal = ports.read.mock.calls[0]![1] as AbortSignal
    scope.stop()
    expect(signal.aborted).toBe(true)
    scope = effectScope()
    ports.read.mockResolvedValueOnce(noteEvidence({ runId: otherRunId }))
    const current = scope.run(() => useNoteRunEvidenceQuery(taskId, otherRunId))!
    await vi.waitFor(() => expect(current.isSuccess.value).toBe(true))
    finish(noteEvidence())
    await nextTick()
    expect(old.data.value).toBeUndefined()
    expect(current.data.value?.evidence.runId).toBe(otherRunId)
    expect(current.data.value?.lines).toHaveLength(3)
  })

  it.each([{ taskId: otherRunId }, { runId: otherRunId }, { lineCount: 99 }])(
    'rejects evidence that cannot be safely displayed %j',
    async (override) => {
      ports.read.mockResolvedValue(noteEvidence(override))
      const query = scope.run(() => useNoteRunEvidenceQuery(taskId, runId))!
      await vi.waitFor(() => expect(query.isError.value).toBe(true))
      expect(query.data.value).toBeUndefined()
    },
  )

  it('does not read an answer until there is a saved answer id', async () => {
    const selected = ref<string | null>(null)
    const query = scope.run(() => useFollowUpAnswerQuery(taskId, questionId, runId, selected))!
    await nextTick()
    expect(ports.read).not.toHaveBeenCalled()
    ports.read.mockResolvedValue(answerResponse())
    selected.value = answerId
    await vi.waitFor(() => expect(query.isSuccess.value).toBe(true))
    expect(query.data.value?.run.status).toBe('SUCCEEDED')
    expect(query.data.value?.report?.body.result.outcome).toBe('FAILED')
  })
  it.each(['answer', 'question', 'task', 'source', 'sourceTask', 'result'] as const)(
    'refuses an answer with wrong %s identity',
    async (kind) => {
      const saved = answerResponse()
      if (kind === 'answer') saved.answerSubmissionId = otherRunId
      if (kind === 'question') saved.questionId = otherRunId
      if (kind === 'task') saved.run.taskId = otherRunId
      if (kind === 'source') saved.report!.body.source.noteRunId = otherRunId
      if (kind === 'sourceTask') saved.report!.body.source.taskId = otherRunId
      if (kind === 'result') saved.report!.body.result.answerSubmissionId = otherRunId
      ports.read.mockResolvedValue(saved)
      const query = scope.run(() => useFollowUpAnswerQuery(taskId, questionId, runId, answerId))!
      await vi.waitFor(() => expect(query.isError.value).toBe(true))
      expect(query.data.value).toBeUndefined()
    },
  )
  it('isolates late answer reads and aborts the former selection', async () => {
    let finish!: (value: ReturnType<typeof answerResponse>) => void
    ports.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const selected = ref(answerId)
    const query = scope.run(() => useFollowUpAnswerQuery(taskId, questionId, runId, selected))!
    const signal = ports.read.mock.calls[0]![1] as AbortSignal
    ports.read.mockResolvedValueOnce(
      answerResponse({ answerSubmissionId: otherRunId, report: null }),
    )
    selected.value = otherRunId
    await vi.waitFor(() => expect(query.data.value?.answerSubmissionId).toBe(otherRunId))
    expect(signal.aborted).toBe(true)
    finish(answerResponse())
    await nextTick()
    expect(query.data.value?.answerSubmissionId).toBe(otherRunId)
  })
})
