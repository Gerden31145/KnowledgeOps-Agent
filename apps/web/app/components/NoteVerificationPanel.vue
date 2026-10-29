<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import {
  isAgentRunTerminalState,
  type AcceptanceCriterionSummary,
  type NoteCitation,
  type TaskDetailResponse,
} from '@knowledgeops/contracts'
import { useNoteVerificationRunQuery } from '../composables/use-workspace-queries'
import { KnowledgeOpsApiError } from '../lib/knowledge-ops-api'
import { useSessionUser } from '../composables/use-session-user'

const props = defineProps<{
  taskId: string
  runId: string
  criteria: AcceptanceCriterionSummary[]
  task: TaskDetailResponse
}>()
const user = useSessionUser()
const query = useNoteVerificationRunQuery(
  () => props.taskId,
  () => props.runId,
)
const snapshot = query.data
const report = computed(() => snapshot.value?.report?.body)
const evidenceOpen = ref(false)
const selection = shallowRef<{ citation: NoteCitation; request: number } | null>(null)
function locate(citation: NoteCitation) {
  evidenceOpen.value = true
  selection.value = { citation, request: (selection.value?.request ?? 0) + 1 }
}
const denied = computed(
  () => query.error.value instanceof KnowledgeOpsApiError && query.error.value.status === 401,
)
const missing = computed(
  () => query.error.value instanceof KnowledgeOpsApiError && query.error.value.status === 404,
)
const stateLabels = {
  QUEUED: '排队中',
  RUNNING: '验收中',
  CANCEL_REQUESTED: '正在取消',
  SUCCEEDED: '执行完成',
  FAILED: '执行失败',
  CANCELLED: '已取消',
  TIMED_OUT: '已超时',
}
const outcomeLabels = { PASSED: '通过', FAILED: '未通过', INSUFFICIENT_EVIDENCE: '证据不足' }
function criterionTitle(id: string) {
  return props.criteria.find((criterion) => criterion.id === id)?.description ?? '历史验收标准'
}
</script>

<template>
  <section
    id="note-report"
    class="scroll-mt-8 border-t border-hairline pt-8"
    aria-labelledby="note-report-title"
  >
    <div class="flex flex-wrap items-center justify-between gap-4">
      <h2 id="note-report-title" class="font-display text-3xl font-normal tracking-display">
        笔记验收报告
      </h2>
      <button
        class="min-h-11 rounded-full border border-ink px-6 font-mono text-sm disabled:border-muted-soft disabled:text-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
        type="button"
        :disabled="query.isFetching.value"
        @click="query.refetch()"
      >
        {{ query.isFetching.value ? '读取中' : '刷新报告' }}
      </button>
    </div>

    <AsyncStatePanel
      v-if="query.isError.value"
      class="mt-6"
      tone="warning"
      :title="denied ? '登录已过期' : missing ? '无法查看此运行' : '报告读取失败'"
      :description="
        denied
          ? '请重新登录后查看报告。'
          : missing
            ? '这条运行不存在，或当前账号无权访问。'
            : '本次请求未成功，请检查网络后重新读取；不会改变验收运行或任务状态。'
      "
    >
      <template v-if="denied" #actions>
        <NuxtLink
          class="inline-flex min-h-11 items-center text-link underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
          to="/login"
          >重新登录</NuxtLink
        >
      </template>
    </AsyncStatePanel>
    <AsyncStatePanel
      v-else-if="query.isPending.value"
      class="mt-6"
      title="正在读取报告"
      description="正在查询这次运行保存的状态与验收结果。"
    />
    <div v-else-if="snapshot" class="mt-6 space-y-8 [overflow-wrap:anywhere]">
      <dl class="grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt class="text-muted">运行状态</dt>
          <dd class="mt-2 text-body-strong">{{ stateLabels[snapshot.status] }}</dd>
        </div>
        <div>
          <dt class="text-muted">开始排队</dt>
          <dd class="mt-2 text-body-strong">
            <time :datetime="snapshot.queuedAt">{{
              new Date(snapshot.queuedAt).toLocaleString('zh-CN')
            }}</time>
          </dd>
        </div>
      </dl>
      <p class="text-sm leading-6 text-muted">
        运行状态说明这次后台执行是否结束；任务是否通过，以任务状态为准。
      </p>

      <AsyncStatePanel
        v-if="!report"
        :title="
          !isAgentRunTerminalState(snapshot.status)
            ? '报告尚未生成'
            : snapshot.status === 'SUCCEEDED'
              ? '暂无可展示的报告'
              : '本次运行未生成报告'
        "
        :description="
          !isAgentRunTerminalState(snapshot.status)
            ? '后台仍在处理，可稍后刷新报告。'
            : snapshot.status === 'SUCCEEDED'
              ? '这次运行已结束，但没有保存可展示的报告。'
              : '这次执行已结束。请查看运行状态，已有任务结果不会因页面读取而改变。'
        "
        :tone="
          snapshot.status === 'FAILED' || snapshot.status === 'TIMED_OUT' ? 'warning' : 'default'
        "
      />
      <template v-else>
        <ul class="divide-y divide-hairline border-y border-hairline" aria-label="逐项验收结果">
          <li v-for="result in report.results" :key="result.criterionId" class="py-6">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <h3 class="text-lg text-ink">{{ criterionTitle(result.criterionId) }}</h3>
              <span
                class="text-sm"
                :class="result.outcome === 'PASSED' ? 'text-success' : 'text-warning'"
                >{{ outcomeLabels[result.outcome] }}</span
              >
            </div>
            <p class="mt-3 whitespace-pre-wrap leading-7 text-body">{{ result.rationale }}</p>
            <ul
              v-if="result.suggestions.length"
              class="mt-3 list-disc space-y-2 pl-5 text-body"
              aria-label="修改建议"
            >
              <li v-for="(suggestion, index) in result.suggestions" :key="index">
                {{ suggestion }}
              </li>
            </ul>
            <details v-if="result.citations.length" class="mt-4">
              <summary
                class="min-h-11 cursor-pointer py-3 text-sm text-link focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
              >
                查看引用摘录（{{ result.citations.length }}）
              </summary>
              <blockquote
                v-for="(citation, index) in result.citations"
                :key="index"
                class="mt-4 border-l border-hairline-strong pl-4"
              >
                <p class="font-mono text-sm text-muted">
                  {{ citation.path }} · 第 {{ citation.startLine }}–{{ citation.endLine }} 行 ·
                  {{ citation.commitSha.slice(0, 7) }}
                </p>
                <p class="mt-2 whitespace-pre-wrap leading-7 text-body">{{ citation.excerpt }}</p>
                <button
                  type="button"
                  class="mt-2 min-h-11 px-2 text-sm text-link underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
                  @click="locate(citation)"
                >
                  定位原文第 {{ citation.startLine }}–{{ citation.endLine }} 行
                </button>
              </blockquote>
            </details>
          </li>
          <li v-for="item in report.exemptions" :key="item.criterionId" class="py-6">
            <h3 class="text-lg">{{ criterionTitle(item.criterionId) }} · 不适用</h3>
            <p class="mt-3 leading-7 text-body">
              本次使用提交全文快照，没有原始 Diff，因此不检查文件变更；不代表此项通过。
            </p>
          </li>
        </ul>
        <p v-if="report.pendingCriterionIds.length" class="text-sm leading-6 text-muted">
          仍有
          {{ report.pendingCriterionIds.length }} 项标准等待后续验收，当前报告不能替代任务最终结论。
        </p>
        <section v-if="snapshot.followUpQuestion" aria-labelledby="follow-up-title">
          <h3 id="follow-up-title" class="font-display text-2xl tracking-display">理解追问</h3>
          <p class="mt-4 whitespace-pre-wrap leading-7 text-body">
            {{ snapshot.followUpQuestion.question }}
          </p>
          <p class="mt-3 text-sm text-muted">
            这是本次笔记报告对应的问题，生成问题不代表回答已通过。
          </p>
          <ul class="mt-3 flex flex-wrap gap-3" aria-label="追问引用">
            <li v-for="(citation, index) in snapshot.followUpQuestion.citations" :key="index">
              <button
                type="button"
                class="min-h-11 px-2 text-sm text-link underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
                @click="locate(citation)"
              >
                追问依据：原文第 {{ citation.startLine }}–{{ citation.endLine }} 行
              </button>
            </li>
          </ul>
          <FollowUpAnswerPanel
            v-if="user"
            :key="`${user.id}:${snapshot.followUpQuestion.id}`"
            :user-id="user.id"
            :task="task"
            :note-run-id="runId"
            :question="snapshot.followUpQuestion"
            @locate="locate"
          />
        </section>
        <p v-else class="text-sm leading-6 text-muted">
          本次报告没有保存追问。笔记未满足出题条件或执行预算不足时，都可能没有追问。
        </p>
      </template>
      <template v-if="snapshot.submissionId">
        <button
          type="button"
          class="min-h-11 px-3 text-sm text-link underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
          :aria-expanded="evidenceOpen"
          aria-controls="note-evidence"
          @click="evidenceOpen = !evidenceOpen"
        >
          {{ evidenceOpen ? '收起固定正文与 Diff' : '查看固定正文与 Diff' }}
        </button>
        <NoteEvidencePanel
          v-if="evidenceOpen"
          id="note-evidence"
          :key="`${taskId}:${runId}`"
          :task-id="taskId"
          :run-id="runId"
          :selection="selection"
        />
      </template>
    </div>
  </section>
</template>
