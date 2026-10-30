<script setup lang="ts">
import { computed, onScopeDispose, ref } from 'vue'
import { useRoute, useRouter } from '#imports'
import { useQueryClient } from '@tanstack/vue-query'
import {
  entityIdSchema,
  isAgentRunTerminalState,
  type NoteCitation,
  type NoteVerificationRunResponse,
  type TaskDetailResponse,
} from '@knowledgeops/contracts'
import { useFollowUpAnswer } from '../composables/use-follow-up-answer'
import { useFollowUpAnswerQuery } from '../composables/use-workspace-queries'
import { KnowledgeOpsApiError } from '../lib/knowledge-ops-api'
import { knowledgeOpsQueryKeys } from '../lib/query-keys'

const props = defineProps<{
  userId: string
  task: TaskDetailResponse
  noteRunId: string
  question: NonNullable<NoteVerificationRunResponse['followUpQuestion']>
}>()
const emit = defineEmits<{ locate: [citation: NoteCitation] }>()
const route = useRoute()
const router = useRouter()
const client = useQueryClient()
const acting = ref(false)
const refreshIssue = ref('')
let disposed = false
onScopeDispose(() => {
  disposed = true
})
const latestNote = computed(() => props.task.runs.find((run) => run.kind === 'NOTE_VERIFICATION'))
const canSubmit = computed(
  () =>
    props.task.state === 'NEEDS_EVIDENCE' &&
    props.task.stage.plan.status === 'ACTIVE' &&
    latestNote.value?.id === props.noteRunId &&
    latestNote.value.status === 'SUCCEEDED' &&
    !props.task.runs.some((run) => !isAgentRunTerminalState(run.status)),
)
const submission = useFollowUpAnswer({
  userId: props.userId,
  taskId: props.task.id,
  questionId: props.question.id,
  taskVersion: () => props.task.version,
  canSubmit: () => canSubmit.value,
})
const {
  draft,
  receipt,
  submitting,
  issue,
  storageBlocked,
  rejection,
  locked,
  pendingConfirmation,
} = submission
const answers = computed(() => {
  const list = props.question.answers.map((answer) => ({
    id: answer.id,
    label: new Date(answer.createdAt).toLocaleString('zh-CN'),
  }))
  if (receipt.value && !list.some((answer) => answer.id === receipt.value!.answerSubmissionId))
    list.unshift({ id: receipt.value.answerSubmissionId, label: '本次已受理回答' })
  return list
})
const invalidSelection = computed(
  () =>
    (route.query.answerId !== undefined &&
      !entityIdSchema.safeParse(route.query.answerId).success) ||
    (route.query.answerRunId !== undefined &&
      (!entityIdSchema.safeParse(route.query.answerRunId).success ||
        route.query.answerId === undefined)),
)
const selectedId = computed(() => {
  if (invalidSelection.value) return null
  if (typeof route.query.answerId === 'string') return route.query.answerId
  return receipt.value?.answerSubmissionId ?? answers.value[0]?.id ?? null
})
const selectedRunId = computed(() =>
  typeof route.query.answerRunId === 'string' ? route.query.answerRunId : null,
)
const query = useFollowUpAnswerQuery(
  props.task.id,
  props.question.id,
  props.noteRunId,
  selectedId,
  selectedRunId,
)
const answer = query.data
const result = computed(() => answer.value?.report?.body.result)
const denied = computed(
  () => query.error.value instanceof KnowledgeOpsApiError && query.error.value.status === 401,
)
const missing = computed(
  () => query.error.value instanceof KnowledgeOpsApiError && query.error.value.status === 404,
)
const states = {
  QUEUED: '排队中',
  RUNNING: '验收中',
  CANCEL_REQUESTED: '正在取消',
  SUCCEEDED: '执行完成',
  FAILED: '执行失败',
  CANCELLED: '已取消',
  TIMED_OUT: '已超时',
}
const outcomes = { PASSED: '通过', FAILED: '未通过', INSUFFICIENT_EVIDENCE: '证据不足' }

async function select(id: string) {
  if (!disposed)
    await router.replace({
      query: { ...route.query, answerId: id, answerRunId: undefined },
      hash: '#follow-up-answer',
    })
}
async function refreshContext() {
  await Promise.all([
    client.invalidateQueries(
      { queryKey: knowledgeOpsQueryKeys.task(props.task.id), exact: true },
      { throwOnError: true },
    ),
    client.invalidateQueries(
      {
        queryKey: knowledgeOpsQueryKeys.noteVerificationRun(props.task.id, props.noteRunId),
        exact: true,
      },
      { throwOnError: true },
    ),
    client.invalidateQueries({ queryKey: knowledgeOpsQueryKeys.todayTasks(), exact: true }),
    client.invalidateQueries({
      queryKey: knowledgeOpsQueryKeys.plan(props.task.stage.plan.id),
      exact: true,
    }),
  ])
}
async function submit() {
  if (acting.value) return
  acting.value = true
  refreshIssue.value = ''
  try {
    const accepted = await submission.submit()
    if (!accepted || disposed) return
    await select(accepted.answerSubmissionId)
    if (disposed) return
    await refreshContext()
  } catch {
    if (!disposed) refreshIssue.value = '回答已受理，但页面状态更新失败，请刷新读取已保存的回答。'
  } finally {
    if (!disposed) acting.value = false
  }
}
async function refresh() {
  if (acting.value) return
  acting.value = true
  refreshIssue.value = ''
  try {
    if (selectedId.value) await query.refetch()
    if (disposed) return
    await refreshContext()
    // 只有服务端明确拒绝的提交才解锁编辑；网络结果未知时仍保留原命令。
    if (!disposed && rejection.value) submission.reset()
  } catch {
    if (!disposed) refreshIssue.value = '页面状态更新失败，请检查网络后重试。'
  } finally {
    if (!disposed) acting.value = false
  }
}
</script>

<template>
  <section
    id="follow-up-answer"
    class="mt-6 min-w-0 scroll-mt-8 border-t border-hairline pt-6"
    aria-labelledby="answer-title"
  >
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h4 id="answer-title" class="font-display text-2xl tracking-display">回答追问</h4>
      <button
        type="button"
        :disabled="acting || submitting || query.isFetching.value || query.isPaused.value"
        class="min-h-11 px-3 text-sm text-link underline disabled:text-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
        @click="refresh"
      >
        刷新回答与任务
      </button>
    </div>
    <p v-if="latestNote?.id !== noteRunId" class="mt-3 text-sm text-muted">
      这是历史笔记的追问，可查看已有回答。提交新回答请打开最新笔记报告。
    </p>
    <p v-else-if="!canSubmit && !pendingConfirmation" class="mt-3 text-sm text-muted">
      当前任务暂不接受新的回答；验收中可稍后刷新，已通过任务无需再次提交。
    </p>

    <form
      v-if="canSubmit || pendingConfirmation || storageBlocked"
      class="mt-5 space-y-3"
      novalidate
      @submit.prevent="submit"
    >
      <label for="follow-up-answer-input" class="block text-sm text-body-strong">你的回答</label>
      <textarea
        id="follow-up-answer-input"
        v-model="draft"
        :readonly="locked"
        :disabled="storageBlocked"
        maxlength="8000"
        rows="6"
        aria-describedby="answer-input-help answer-command-status"
        class="min-h-36 w-full resize-y border border-hairline-strong bg-canvas p-3 text-body placeholder:text-muted read-only:text-muted disabled:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
      />
      <p id="answer-input-help" class="text-sm text-muted">
        {{ draft.length }} / 8000 字符。提交后会保存回答并开始验收，受理成功不代表回答已通过。
      </p>
      <p v-if="pendingConfirmation" class="text-sm leading-6 text-muted">
        本次回答已保留，确认受理结果前请重发原回答。刷新本标签页后也可继续确认。
      </p>
      <button
        v-if="!receipt && !storageBlocked && !rejection"
        type="submit"
        :disabled="acting || submitting || (!pendingConfirmation && !canSubmit)"
        class="min-h-11 rounded-full border border-ink px-6 font-mono text-sm disabled:border-muted-soft disabled:text-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
      >
        {{ submitting ? '正在提交' : pendingConfirmation ? '重发本次回答' : '提交回答' }}
      </button>
      <button
        v-if="receipt && canSubmit && answer && isAgentRunTerminalState(answer.run.status)"
        type="button"
        :disabled="acting"
        class="min-h-11 px-3 text-link underline focus-visible:outline-2 focus-visible:outline-link"
        @click="submission.reset"
      >
        修改并提交新的回答
      </button>
      <button
        v-if="storageBlocked"
        type="button"
        class="min-h-11 px-3 text-link underline focus-visible:outline-2 focus-visible:outline-link"
        @click="submission.reset"
      >
        核对已保存回答后重新填写
      </button>
    </form>
    <p v-if="receipt" role="status" class="mt-3 text-sm text-success">
      回答已受理，可查看下方验收状态。
    </p>
    <p id="answer-command-status" role="status" class="mt-3 text-sm text-warning">
      {{ issue || refreshIssue }}
    </p>
    <NuxtLink
      v-if="rejection === 401 || denied"
      to="/login"
      class="inline-flex min-h-11 items-center text-link underline focus-visible:outline-2 focus-visible:outline-link"
      >重新登录</NuxtLink
    >

    <div v-if="answers.length" class="mt-6">
      <label for="saved-answer" class="block text-sm text-muted">已保存的回答（最近 20 次）</label>
      <select
        id="saved-answer"
        :value="selectedId ?? ''"
        class="mt-2 min-h-11 w-full border border-hairline-strong bg-canvas px-3 text-sm text-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
        @change="select(($event.target as HTMLSelectElement).value)"
      >
        <option v-if="!answers.some((item) => item.id === selectedId)" value="" disabled>
          请选择已保存的回答
        </option>
        <option v-for="item in answers" :key="item.id" :value="item.id">{{ item.label }}</option>
      </select>
    </div>
    <AsyncStatePanel
      v-if="invalidSelection"
      class="mt-5"
      tone="warning"
      title="无法选择此回答"
      description="请从已保存的回答列表重新选择。"
    />
    <AsyncStatePanel
      v-else-if="query.isPaused.value"
      class="mt-5"
      tone="warning"
      title="网络离线，同步已暂停"
      description="恢复网络后会重新读取回答结果；恢复查询不会自动重新提交回答。"
    />
    <AsyncStatePanel
      v-else-if="query.isError.value"
      class="mt-5"
      tone="warning"
      :title="denied ? '登录已过期' : missing ? '无法查看此回答' : '回答读取失败'"
      :description="
        denied
          ? '请重新登录后查看。'
          : missing
            ? '回答不存在，或当前账号无权访问。'
            : '请检查网络或重新选择回答；本次读取失败不会改变验收或任务状态。'
      "
    />
    <p v-else-if="!selectedId" class="mt-5 text-sm text-muted">这个追问尚无已保存的回答。</p>
    <AsyncStatePanel
      v-else-if="query.isPending.value"
      class="mt-5"
      title="正在读取回答"
      description="读取保存的答案和验收结果。"
    />
    <div v-else-if="answer" class="mt-6 space-y-4 [overflow-wrap:anywhere]">
      <p class="text-sm text-body-strong">回答验收：{{ states[answer.run.status] }}</p>
      <p class="text-sm text-muted">
        本次运行：{{ new Date(answer.run.queuedAt).toLocaleString('zh-CN') }} ·
        {{ answer.run.retryOfRunId ? '重试验收' : '首次验收' }}
      </p>
      <VerificationRunCancel :key="answer.run.runId" :run="answer.run" />
      <AnswerVerificationRetry
        :key="`${answer.answerSubmissionId}:${answer.run.runId}`"
        :answer="answer"
        :task="task"
        :note-run-id="noteRunId"
      />
      <details>
        <summary
          class="min-h-11 cursor-pointer py-3 text-link focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
        >
          查看已提交的回答
        </summary>
        <p class="mt-3 whitespace-pre-wrap leading-7 text-body">{{ answer.answer }}</p>
      </details>
      <template v-if="result">
        <p :class="result.outcome === 'PASSED' ? 'text-success' : 'text-warning'">
          回答结论：{{ outcomes[result.outcome] }}
        </p>
        <p class="whitespace-pre-wrap leading-7 text-body">{{ result.rationale }}</p>
        <ul
          v-if="result.suggestions.length"
          class="list-disc space-y-2 pl-5 text-body"
          aria-label="回答修改建议"
        >
          <li v-for="(suggestion, index) in result.suggestions" :key="index">{{ suggestion }}</li>
        </ul>
        <details v-if="result.answerCitations.length">
          <summary
            class="min-h-11 cursor-pointer py-3 text-link focus-visible:outline-2 focus-visible:outline-link"
          >
            查看答案引用
          </summary>
          <blockquote
            v-for="(citation, index) in result.answerCitations"
            :key="index"
            class="mt-3 border-l border-hairline-strong pl-4"
          >
            <p class="text-sm text-muted">
              已提交回答的第 {{ citation.startLine }}–{{ citation.endLine }} 行
            </p>
            <p class="mt-2 whitespace-pre-wrap leading-7 text-body">{{ citation.excerpt }}</p>
          </blockquote>
        </details>
        <ul
          v-if="result.citations.length"
          class="flex flex-wrap gap-3"
          aria-label="回答验收的笔记依据"
        >
          <li v-for="(citation, index) in result.citations" :key="index">
            <button
              type="button"
              class="min-h-11 px-2 text-sm text-link underline focus-visible:outline-2 focus-visible:outline-link"
              @click="emit('locate', citation)"
            >
              笔记依据：原文第 {{ citation.startLine }}–{{ citation.endLine }} 行
            </button>
          </li>
        </ul>
        <p class="text-sm text-muted">这是这次回答的验收结论；任务当前状态以上方任务信息为准。</p>
      </template>
      <AsyncStatePanel
        v-else
        :title="
          !isAgentRunTerminalState(answer.run.status) ? '回答尚在验收' : '本次运行未保存验收报告'
        "
        :description="
          !isAgentRunTerminalState(answer.run.status)
            ? '页面正在自动更新；离开页面不会停止后台验收。'
            : '请查看运行状态；执行失败与回答内容未通过是不同情况。'
        "
      />
    </div>
  </section>
</template>
