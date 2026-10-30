import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, nextTick, type EffectScope } from 'vue'
import { QueryClient } from '@tanstack/vue-query'
import { useRetryAnswerVerification } from '../app/composables/use-retry-answer-verification'
import { KnowledgeOpsApiError } from '../app/lib/knowledge-ops-api'
import { taskDetail, runId as noteRunId, taskId, otherRunId } from './fixtures/note-verification'
import { answerResponse, answerId, answerRunId } from './fixtures/follow-up-answer'

const ports = vi.hoisted(() => ({ retry: vi.fn(), client: undefined as unknown as QueryClient }))
vi.mock('../app/composables/use-knowledge-ops-api', () => ({
  useKnowledgeOpsApi: () => ({ retryAnswerVerification: ports.retry }),
}))
vi.mock('@tanstack/vue-query', async (original) => ({
  ...(await original<typeof import('@tanstack/vue-query')>()),
  useQueryClient: () => ports.client,
}))
const receipt = () => ({
  status: 'ACCEPTED' as const,
  answerSubmissionId: answerId,
  taskId,
  runId: otherRunId,
  retryOfRunId: answerRunId,
  taskVersion: 10,
})
let scope: EffectScope
function mount() {
  const answer = ref(answerResponse({ report: null }))
  answer.value.run.status = 'FAILED'
  const task = ref(
    taskDetail({
      state: 'NEEDS_EVIDENCE',
      version: 9,
      runs: [
        {
          id: answerRunId,
          kind: 'ANSWER_VERIFICATION',
          status: 'FAILED',
          errorCode: 'MODEL_TIMEOUT',
          queuedAt: answer.value.run.queuedAt,
          startedAt: null,
          finishedAt: answer.value.run.finishedAt,
        },
        {
          id: noteRunId,
          kind: 'NOTE_VERIFICATION',
          status: 'SUCCEEDED',
          errorCode: null,
          queuedAt: answer.value.run.queuedAt,
          startedAt: null,
          finishedAt: answer.value.run.finishedAt,
        },
      ],
    }),
  )
  const command = scope.run(() =>
    useRetryAnswerVerification(() => ({ answer: answer.value, task: task.value, noteRunId })),
  )!
  return { answer, task, command }
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

describe('R15 linked answer retry UI', () => {
  it('sends only saved identities and observed versions once; preserves the answer and old result', async () => {
    let resolve!: (value: ReturnType<typeof receipt>) => void
    ports.retry.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const { answer, task, command } = mount()
    const before = structuredClone(answerResponse({ report: null }))
    const pending = command.retry()
    await command.retry()
    expect(ports.retry).toHaveBeenCalledExactlyOnceWith(answerId, answerRunId, {
      expectedRunVersion: 2,
      expectedTaskVersion: 9,
    })
    expect(command.busy.value).toBe(true)
    resolve(receipt())
    await pending
    expect(command.retryRunId.value).toBe(otherRunId)
    expect(command.canRetry.value).toBe(false)
    expect(answer.value.answer).toBe(before.answer)
    expect(answer.value.run.status).toBe('FAILED')
    expect(task.value.state).toBe('NEEDS_EVIDENCE')
  })

  it('recovers a successor through GET without automatically repeating POST', async () => {
    const { answer, command } = mount()
    answer.value.run.retryRunId = otherRunId
    await command.retry()
    expect(command.retryRunId.value).toBe(otherRunId)
    expect(ports.retry).not.toHaveBeenCalled()
  })

  it('clears an uncertain response when refreshing finds its persisted successor', async () => {
    ports.retry.mockRejectedValueOnce(new TypeError('private network error'))
    const { answer, task, command } = mount()
    await command.retry()
    expect(command.issue.value).toContain('尚未确认')
    expect(command.issue.value).not.toContain('private')
    answer.value.run.retryRunId = otherRunId
    task.value.state = 'VERIFYING'
    await nextTick()
    expect(command.issue.value).toBe('')
    expect(command.retryRunId.value).toBe(otherRunId)
    await command.retry()
    expect(ports.retry).toHaveBeenCalledTimes(1)
  })

  it.each(['SUCCEEDED', 'RUNNING', 'QUEUED', 'CANCEL_REQUESTED'] as const)(
    'hides retries for Run status %s',
    async (status) => {
      const { answer, command } = mount()
      answer.value.run.status = status
      await command.retry()
      expect(ports.retry).not.toHaveBeenCalled()
    },
  )

  it.each(['new-answer', 'new-note', 'passed', 'busy', 'archived'] as const)(
    'rejects a visibly obsolete context: %s',
    async (change) => {
      const { task, command } = mount()
      if (change === 'new-answer') task.value.runs[0]!.id = otherRunId
      if (change === 'new-note') task.value.runs[1]!.id = otherRunId
      if (change === 'passed') task.value.state = 'PASSED'
      if (change === 'busy') task.value.runs[0]!.status = 'RUNNING'
      if (change === 'archived') task.value.stage.plan.status = 'ARCHIVED'
      await command.retry()
      expect(ports.retry).not.toHaveBeenCalled()
    },
  )

  it('refreshes a conflict without leaking server details', async () => {
    ports.retry.mockRejectedValueOnce(new KnowledgeOpsApiError('private', 409, 'CONFLICT', null))
    const refresh = vi.spyOn(ports.client, 'invalidateQueries')
    const { command } = mount()
    await command.retry()
    expect(command.issue.value).toContain('回答或任务已变化')
    expect(command.issue.value).not.toContain('private')
    expect(refresh).toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'])(
    'ignores late %s after leaving the selected Run',
    async (result) => {
      let resolve!: (value: ReturnType<typeof receipt>) => void, reject!: (error: Error) => void
      ports.retry.mockReturnValueOnce(
        new Promise((yes, no) => {
          resolve = yes
          reject = no
        }),
      )
      const refresh = vi.spyOn(ports.client, 'invalidateQueries')
      const { command } = mount()
      const pending = command.retry()
      scope.stop()
      if (result === 'resolve') resolve(receipt())
      else reject(new Error('late'))
      await pending
      expect(command.receipt.value).toBeNull()
      expect(command.issue.value).toBe('')
      expect(refresh).not.toHaveBeenCalled()
    },
  )

  it.each(['answerSubmissionId', 'retryOfRunId', 'taskId'] as const)(
    'refuses a receipt with mismatched %s',
    async (field) => {
      ports.retry.mockResolvedValueOnce({ ...receipt(), [field]: otherRunId })
      const { command } = mount()
      await command.retry()
      expect(command.retryRunId.value).toBeNull()
      expect(command.issue.value).toContain('尚未确认')
    },
  )

  it('retains the accepted destination if GET refresh fails', async () => {
    vi.spyOn(ports.client, 'invalidateQueries').mockRejectedValueOnce(new TypeError('offline'))
    const { command } = mount()
    await command.retry()
    expect(command.retryRunId.value).toBe(otherRunId)
    expect(command.issue.value).toContain('列表更新失败')
  })
})
