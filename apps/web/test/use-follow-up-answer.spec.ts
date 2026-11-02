import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, type EffectScope } from 'vue'
import { useFollowUpAnswer } from '../app/composables/use-follow-up-answer'
import { KnowledgeOpsApiError } from '../app/lib/knowledge-ops-api'
import { reconcileAnswerCommandSession } from '../app/lib/answer-command-session'
import { taskId, otherRunId } from './fixtures/note-verification'
import { userId, questionId, receipt } from './fixtures/follow-up-answer'

const api = vi.hoisted(() => ({ submitFollowUpAnswer: vi.fn() }))
vi.mock('../app/composables/use-knowledge-ops-api', () => ({ useKnowledgeOpsApi: () => api }))
let scope: EffectScope
let version: number
let eligible: boolean
let storage: {
  readonly length: number
  key: ReturnType<typeof vi.fn>
  getItem: ReturnType<typeof vi.fn>
  setItem: ReturnType<typeof vi.fn>
  removeItem: ReturnType<typeof vi.fn>
}
const key = `knowledgeops:answer-command:v1:${userId}:${taskId}:${questionId}`
function mount(overrides: Partial<{ userId: string; questionId: string }> = {}) {
  return scope.run(() =>
    useFollowUpAnswer({
      userId,
      taskId,
      questionId,
      taskVersion: () => version,
      canSubmit: () => eligible,
      ...overrides,
    }),
  )!
}
describe('follow-up answer command and receipt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const values = new Map<string, string>()
    storage = {
      get length() {
        return values.size
      },
      key: vi.fn((index: number) => [...values.keys()][index] ?? null),
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value)
      }),
      removeItem: vi.fn((key: string) => {
        values.delete(key)
      }),
    }
    vi.stubGlobal('window', { sessionStorage: storage })
    api.submitFollowUpAnswer.mockReset().mockResolvedValue(receipt())
    scope = effectScope()
    version = 5
    eligible = true
  })
  afterEach(() => {
    scope.stop()
    vi.unstubAllGlobals()
  })

  it.each(['   ', 'x'.repeat(8001)])(
    'rejects invalid answer length without sending',
    async (text) => {
      const form = mount()
      form.draft.value = text
      expect(await form.submit()).toBeNull()
      expect(api.submitFollowUpAnswer).not.toHaveBeenCalled()
      expect(form.issue.value).toContain('8000')
    },
  )
  it('persists the normalized command before POST and keeps acceptance separate from grading', async () => {
    const form = mount()
    form.draft.value = '  我的回答  '
    api.submitFollowUpAnswer.mockImplementation(async (question, command) => {
      expect(question).toBe(questionId)
      expect(JSON.parse(storage.getItem(key)!).command).toEqual(command)
      return receipt()
    })
    expect(await form.submit()).toEqual(receipt())
    expect(api.submitFollowUpAnswer.mock.calls[0]![1]).toMatchObject({
      answer: '我的回答',
      expectedTaskVersion: 5,
    })
    expect(form.receipt.value).toEqual(receipt())
    expect(form.pendingConfirmation.value).toBe(false)
    expect('report' in form.receipt.value!).toBe(false)
  })
  it('sends only once on double click', async () => {
    let resolve!: (value: ReturnType<typeof receipt>) => void
    api.submitFollowUpAnswer.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const form = mount()
    form.draft.value = '答案'
    const first = form.submit()
    expect(await form.submit()).toBeNull()
    expect(api.submitFollowUpAnswer).toHaveBeenCalledTimes(1)
    resolve(receipt())
    await first
  })
  it('replays the original command after a lost response despite changed task version and eligibility', async () => {
    api.submitFollowUpAnswer.mockRejectedValueOnce(new TypeError('lost response'))
    const form = mount()
    form.draft.value = '原答案'
    await form.submit()
    const command = api.submitFollowUpAnswer.mock.calls[0]![1]
    version = 9
    eligible = false
    form.draft.value = '无法替换已发出的命令'
    expect(form.pendingConfirmation.value).toBe(true)
    expect(form.locked.value).toBe(true)
    await form.submit()
    expect(api.submitFollowUpAnswer.mock.calls[1]![1]).toEqual(command)
  })
  it('restores an uncertain command after reload without automatically posting', async () => {
    api.submitFollowUpAnswer.mockRejectedValueOnce(new TypeError('offline'))
    const first = mount()
    first.draft.value = '原答案'
    await first.submit()
    scope.stop()
    scope = effectScope()
    reconcileAnswerCommandSession(userId)
    const restored = mount()
    expect(restored.draft.value).toBe('原答案')
    expect(api.submitFollowUpAnswer).toHaveBeenCalledTimes(1)
    await restored.submit()
    expect(api.submitFollowUpAnswer.mock.calls[1]).toEqual(api.submitFollowUpAnswer.mock.calls[0])
  })
  it('restores accepted receipts without another POST', async () => {
    const first = mount()
    first.draft.value = '答案'
    await first.submit()
    scope.stop()
    scope = effectScope()
    const restored = mount()
    expect(restored.receipt.value).toEqual(receipt())
    await restored.submit()
    expect(api.submitFollowUpAnswer).toHaveBeenCalledTimes(1)
  })
  it.each([{ userId: otherRunId }, { questionId: otherRunId }])(
    'does not restore another user/question command %j',
    async (overrides) => {
      const first = mount()
      first.draft.value = '私有答案'
      await first.submit()
      const other = mount(overrides)
      expect(other.draft.value).toBe('')
      expect(other.receipt.value).toBeNull()
    },
  )
  it('does not send when storage fails before POST', async () => {
    const form = mount()
    form.draft.value = '答案'
    storage.setItem.mockImplementation(() => {
      throw new Error('quota')
    })
    await form.submit()
    expect(form.storageBlocked.value).toBe(true)
    expect(api.submitFollowUpAnswer).not.toHaveBeenCalled()
  })
  it('retains known acceptance if receipt storage fails afterwards', async () => {
    const form = mount()
    form.draft.value = '答案'
    api.submitFollowUpAnswer.mockImplementation(async () => {
      storage.setItem.mockImplementation(() => {
        throw new Error('quota')
      })
      return receipt()
    })
    expect(await form.submit()).toEqual(receipt())
    expect(form.receipt.value).toEqual(receipt())
    expect(form.issue.value).toContain('已受理')
  })
  it('blocks a corrupt stored command until the user resets it', async () => {
    storage.setItem(key, JSON.stringify({ command: { answer: 'bad' } }))
    const form = mount()
    form.draft.value = '新答案'
    await form.submit()
    expect(api.submitFollowUpAnswer).not.toHaveBeenCalled()
    form.reset()
    await form.submit()
    expect(api.submitFollowUpAnswer).toHaveBeenCalledTimes(1)
  })
  it.each([401, 404, 409])(
    'keeps explicit rejection %i separate from an uncertain network response',
    async (status) => {
      api.submitFollowUpAnswer.mockRejectedValueOnce(
        new KnowledgeOpsApiError('rejected', status, 'CONFLICT', null),
      )
      const form = mount()
      form.draft.value = '答案'
      await form.submit()
      expect(form.rejection.value).toBe(status)
      await form.submit()
      expect(api.submitFollowUpAnswer).toHaveBeenCalledTimes(1)
    },
  )
  it('uses a new command only after explicit reset for a new answer', async () => {
    const form = mount()
    form.draft.value = '第一次'
    await form.submit()
    form.reset()
    version = 8
    form.draft.value = '补充后的答案'
    api.submitFollowUpAnswer.mockResolvedValueOnce(receipt({ taskVersion: 9 }))
    await form.submit()
    const [first, second] = api.submitFollowUpAnswer.mock.calls
    expect(second![1].requestId).not.toBe(first![1].requestId)
    expect(second![1]).toMatchObject({ answer: '补充后的答案', expectedTaskVersion: 8 })
  })
  it('saves a late receipt only under its original scope and returns no navigation result after unmount', async () => {
    let finish!: (value: ReturnType<typeof receipt>) => void
    api.submitFollowUpAnswer.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r
        }),
    )
    const first = mount()
    first.draft.value = 'A'
    const sending = first.submit()
    scope.stop()
    scope = effectScope()
    const next = mount({ questionId: otherRunId })
    finish(receipt())
    expect(await sending).toBeNull()
    expect(next.receipt.value).toBeNull()
    expect(next.draft.value).toBe('')
    expect(JSON.parse(storage.getItem(key)!).receipt).toEqual(receipt())
  })
  it('does not accept a receipt for a different task', async () => {
    api.submitFollowUpAnswer.mockResolvedValueOnce(receipt({ taskId: otherRunId }))
    const form = mount()
    form.draft.value = '答案'
    await form.submit()
    expect(form.receipt.value).toBeNull()
    expect(form.pendingConfirmation.value).toBe(true)
  })

  it('keeps only the confirmed user commands, and removes all answer commands on logout', () => {
    const otherKey = key.replace(userId, otherRunId)
    storage.setItem(key, 'A-private')
    storage.setItem(otherKey, 'B-private')
    storage.setItem(`${key}-another-question`, 'A-private-2')
    storage.setItem('unrelated-preference', 'keep')
    reconcileAnswerCommandSession(otherRunId)
    expect(storage.getItem(key)).toBeNull()
    expect(storage.getItem(`${key}-another-question`)).toBeNull()
    expect(storage.getItem(otherKey)).toBe('B-private')
    reconcileAnswerCommandSession(null)
    expect(storage.getItem(otherKey)).toBeNull()
    expect(storage.getItem('unrelated-preference')).toBe('keep')
  })
  it.each([null, otherRunId])(
    'does not recreate a private command from a late receipt after changing identity to %s',
    async (nextUser) => {
      let finish!: (value: ReturnType<typeof receipt>) => void
      api.submitFollowUpAnswer.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      const form = mount()
      form.draft.value = 'A-private'
      const sending = form.submit()
      reconcileAnswerCommandSession(nextUser)
      scope.stop()
      finish(receipt())
      expect(await sending).toBeNull()
      expect(storage.getItem(key)).toBeNull()
      expect(form.receipt.value).toBeNull()
    },
  )
  it('rejects an old A receipt even after A → B → A, preserving the new A command', async () => {
    let finish!: (value: ReturnType<typeof receipt>) => void
    api.submitFollowUpAnswer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const old = mount()
    old.draft.value = '旧回答'
    const sending = old.submit()
    reconcileAnswerCommandSession(otherRunId)
    reconcileAnswerCommandSession(userId)
    const current = mount()
    current.draft.value = '重新登录后的回答'
    await current.submit()
    const saved = storage.getItem(key)
    finish(receipt())
    expect(await sending).toBeNull()
    expect(storage.getItem(key)).toBe(saved)
    expect(JSON.parse(saved!).command.answer).toBe('重新登录后的回答')
    old.reset()
    expect(storage.getItem(key)).toBe(saved)
    expect(await old.submit()).toBeNull()
    expect(api.submitFollowUpAnswer).toHaveBeenCalledTimes(2)
  })
  it('ignores an old submission failure immediately after logout, before component disposal', async () => {
    let fail!: (error: Error) => void
    api.submitFollowUpAnswer.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    )
    const form = mount()
    form.draft.value = 'A-private'
    const sending = form.submit()
    reconcileAnswerCommandSession(null)
    fail(new KnowledgeOpsApiError('rejected', 409, 'CONFLICT', null))
    expect(await sending).toBeNull()
    expect(form.issue.value).toBe('')
    expect(form.rejection.value).toBeNull()
    expect(storage.getItem(key)).toBeNull()
  })
})
