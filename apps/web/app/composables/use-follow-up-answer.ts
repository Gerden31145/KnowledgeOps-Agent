import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import { z } from 'zod'
import {
  submitFollowUpAnswerInputSchema,
  followUpAnswerAcceptedResponseSchema,
  type FollowUpAnswerAcceptedResponse,
} from '@knowledgeops/contracts'
import { useKnowledgeOpsApi } from './use-knowledge-ops-api'
import { KnowledgeOpsApiError } from '../lib/knowledge-ops-api'

const savedSubmissionSchema = z
  .object({
    command: submitFollowUpAnswerInputSchema,
    receipt: followUpAnswerAcceptedResponseSchema.nullable(),
  })
  .strict()

// 只保存已点击提交的命令，按用户/任务/追问隔离。同标签页刷新后可重发，不自动 POST。
export function useFollowUpAnswer(input: {
  userId: string
  taskId: string
  questionId: string
  taskVersion: () => number
  canSubmit: () => boolean
}) {
  const api = useKnowledgeOpsApi()
  const key = `knowledgeops:answer-command:v1:${input.userId}:${input.taskId}:${input.questionId}`
  const draft = ref('')
  const saved = shallowRef<z.infer<typeof savedSubmissionSchema> | null>(null)
  const submitting = ref(false)
  const issue = ref('')
  const storageBlocked = ref(false)
  const rejection = ref<number | null>(null)
  let disposed = false
  onScopeDispose(() => {
    disposed = true
  })
  try {
    const value = window.sessionStorage.getItem(key)
    if (value) {
      const record = savedSubmissionSchema.parse(JSON.parse(value))
      if (record.receipt && record.receipt.taskId !== input.taskId)
        throw new Error('mismatched receipt')
      saved.value = record
      draft.value = record.command.answer
      if (!record.receipt) issue.value = '发现一份尚未确认受理结果的回答，可重发本次回答确认。'
    }
  } catch {
    storageBlocked.value = true
    issue.value = '本地提交记录不可用，请先核对已保存的回答，再重新填写。'
  }

  const receipt = computed(() => saved.value?.receipt ?? null)
  const pendingConfirmation = computed(() => Boolean(saved.value && !saved.value.receipt))
  const locked = computed(() => Boolean(saved.value) || submitting.value)

  function reset() {
    if (submitting.value || disposed) return
    try {
      window.sessionStorage.removeItem(key)
      saved.value = null
      storageBlocked.value = false
      rejection.value = null
      issue.value = ''
    } catch {
      issue.value = '浏览器无法保存提交记录，请检查存储设置后再试。'
    }
  }

  async function submit(): Promise<FollowUpAnswerAcceptedResponse | null> {
    if (disposed || submitting.value || storageBlocked.value || rejection.value) return null
    if (saved.value?.receipt) return saved.value.receipt
    issue.value = ''
    if (!saved.value) {
      if (!input.canSubmit()) {
        issue.value = '当前追问暂不可提交，请刷新任务状态。'
        return null
      }
      const parsed = submitFollowUpAnswerInputSchema.safeParse({
        requestId: crypto.randomUUID(),
        expectedTaskVersion: input.taskVersion(),
        answer: draft.value,
      })
      if (!parsed.success) {
        issue.value = '请填写 1 至 8000 字符的回答。'
        return null
      }
      saved.value = { command: parsed.data, receipt: null }
    }
    const command = saved.value.command
    // 必须先保存，再发 POST；重发时不换 ID、答案或期望版本。
    try {
      window.sessionStorage.setItem(key, JSON.stringify(saved.value))
    } catch {
      storageBlocked.value = true
      issue.value = '浏览器无法保存提交记录，本次尚未发送。请检查存储设置后再试。'
      return null
    }
    submitting.value = true
    try {
      const accepted = await api.submitFollowUpAnswer(input.questionId, command)
      if (
        accepted.taskId !== input.taskId ||
        accepted.taskVersion !== command.expectedTaskVersion + 1
      )
        throw new Error('mismatched acceptance')
      const record = { command, receipt: accepted }
      // 即使离开页面，也只写回原用户/原题的记录；不改变新页面的状态或 URL。
      try {
        window.sessionStorage.setItem(key, JSON.stringify(record))
      } catch {
        if (!disposed) issue.value = '回答已受理，本地记录保存失败，可从已保存的回答找回结果。'
      }
      if (disposed) return null
      saved.value = record
      return accepted
    } catch (error) {
      if (disposed) return null
      if (
        error instanceof KnowledgeOpsApiError &&
        [400, 401, 403, 404, 409].includes(error.status)
      ) {
        rejection.value = error.status
        issue.value =
          error.status === 401
            ? '登录已过期，请重新登录。'
            : error.status === 404
              ? '追问不存在，或当前账号无权访问。'
              : error.status === 409
                ? '追问或任务已变化，请刷新任务与报告后重新确认。'
                : '提交未被接受，请刷新页面并检查回答内容。'
      } else {
        issue.value = '尚未确认是否受理。请重发本次回答；会沿用原提交，不会另建一次验收。'
      }
      return null
    } finally {
      if (!disposed) submitting.value = false
    }
  }
  return {
    draft,
    receipt,
    submitting,
    issue,
    storageBlocked,
    rejection,
    locked,
    pendingConfirmation,
    submit,
    reset,
  }
}
