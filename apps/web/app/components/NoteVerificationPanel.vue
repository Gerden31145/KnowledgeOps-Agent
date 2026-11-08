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
  view?: 'feedback' | 'follow-up'
}>()
const user = useSessionUser()
const query = useNoteVerificationRunQuery(
  () => props.taskId,
  () => props.runId,
)
const snapshot = query.data
const report = computed(() => snapshot.value?.report?.body)
const passedCount = computed(
  () => report.value?.results.filter((result) => result.outcome === 'PASSED').length ?? 0,
)
const showingFollowUp = computed(() => props.view === 'follow-up')
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
  <section id="note-report" class="scroll-mt-8 text-base" aria-labelledby="note-report-title">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="note-report-title" class="text-xl font-medium">
          {{ showingFollowUp ? '追问回答' : '笔记验收报告' }}
        </h2>
        <span v-if="!showingFollowUp && report && !query.isError.value" class="text-sm text-body">
          {{ passedCount }}/{{ report.results.length }} 项通过
          <span v-if="report.exemptions.length"> · {{ report.exemptions.length }} 项不适用</span>
        </span>
      </div>
      <button
        class="min-h-11 rounded-full border border-ink px-6 font-mono text-base disabled:border-muted-soft disabled:text-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
        type="button"
        :disabled="query.isFetching.value || query.isPaused.value"
        @click="query.refetch()"
      >
        {{ query.isFetching.value ? '读取中' : showingFollowUp ? '刷新追问' : '刷新报告' }}
      </button>
    </div>

    <AsyncStatePanel
      v-if="query.isPaused.value"
      class="mt-6"
      tone="warning"
      title="网络离线，同步已暂停"
      description="恢复网络后会重新读取已保存的运行状态；后台验收不会因页面离线而停止。"
    />
    <AsyncStatePanel
      v-else-if="query.isError.value"
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
          class="action-button inline-flex min-h-11 items-center text-link focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
          :to="{ path: '/login', query: { next: $route.fullPath } }"
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
    <div v-else-if="snapshot" class="mt-4 space-y-5 [overflow-wrap:anywhere]">
      <div v-show="!showingFollowUp" class="space-y-4">
        <dl class="flex flex-wrap gap-x-8 gap-y-3 text-sm">
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
        <VerificationRunCancel :key="snapshot.runId" :run="snapshot" />
        <NoteVerificationRetry :key="snapshot.runId" :run="snapshot" :task="task" />
      </div>

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
            ? '页面正在自动更新，运行结束后会显示已保存的报告。'
            : snapshot.status === 'SUCCEEDED'
              ? '这次运行已结束，但没有保存可展示的报告。'
              : '这次执行已结束。请查看运行状态，已有任务结果不会因页面读取而改变。'
        "
        :tone="
          snapshot.status === 'FAILED' || snapshot.status === 'TIMED_OUT' ? 'warning' : 'default'
        "
      />
      <template v-else>
        <ul v-show="!showingFollowUp" class="space-y-1" aria-label="逐项验收结果">
          <li v-for="result in report.results" :key="result.criterionId">
            <details class="group/criterion">
              <summary
                class="flex min-h-11 cursor-pointer list-none items-start gap-2 py-2 text-base leading-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link [&::-webkit-details-marker]:hidden"
              >
                <svg
                  aria-hidden="true"
                  class="mt-1 size-4 shrink-0 transition-transform group-open/criterion:rotate-90 motion-reduce:transition-none"
                  viewBox="0 0 20 20"
                  fill="none"
                >
                  <path
                    d="m7 4 6 6-6 6"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <span class="min-w-0 flex-1 text-ink">{{
                  criterionTitle(result.criterionId)
                }}</span>
                <span
                  class="shrink-0 text-sm"
                  :class="result.outcome === 'PASSED' ? 'text-success' : 'text-warning'"
                  >{{ outcomeLabels[result.outcome] }}</span
                >
              </summary>
              <div class="pb-3 pl-6 text-sm leading-6">
                <p class="whitespace-pre-wrap text-body">{{ result.rationale }}</p>
                <ul
                  v-if="result.suggestions.length"
                  class="mt-2 list-disc space-y-1 pl-5 text-body"
                  aria-label="修改建议"
                >
                  <li v-for="(suggestion, index) in result.suggestions" :key="index">
                    {{ suggestion }}
                  </li>
                </ul>
                <details v-if="result.citations.length" class="mt-2">
                  <summary
                    class="min-h-11 cursor-pointer py-3 text-sm text-link focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
                  >
                    查看引用摘录（{{ result.citations.length }}）
                  </summary>
                  <blockquote
                    v-for="(citation, index) in result.citations"
                    :key="index"
                    class="mt-2 border-l border-hairline-strong pl-3"
                  >
                    <p class="font-mono text-sm text-muted">
                      {{ citation.path }} · 第 {{ citation.startLine }}–{{ citation.endLine }} 行 ·
                      {{ citation.commitSha.slice(0, 7) }}
                    </p>
                    <p class="mt-2 whitespace-pre-wrap text-body">{{ citation.excerpt }}</p>
                    <button
                      type="button"
                      class="action-button mt-2 min-h-11 px-3 text-sm text-link focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
                      @click="locate(citation)"
                    >
                      定位原文第 {{ citation.startLine }}–{{ citation.endLine }} 行
                    </button>
                  </blockquote>
                </details>
              </div>
            </details>
          </li>
          <li v-for="item in report.exemptions" :key="item.criterionId">
            <details class="group/criterion">
              <summary
                class="flex min-h-11 cursor-pointer list-none items-start gap-2 py-2 text-base leading-6 focus-visible:outline-2 focus-visible:outline-link [&::-webkit-details-marker]:hidden"
              >
                <svg
                  aria-hidden="true"
                  class="mt-1 size-4 shrink-0 transition-transform group-open/criterion:rotate-90 motion-reduce:transition-none"
                  viewBox="0 0 20 20"
                  fill="none"
                >
                  <path
                    d="m7 4 6 6-6 6"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <span class="min-w-0 flex-1">{{ criterionTitle(item.criterionId) }}</span>
                <span class="shrink-0 text-sm text-muted">不适用</span>
              </summary>
              <p class="pb-3 pl-6 text-sm leading-6 text-body">
                本次使用提交全文快照，没有原始 Diff，因此不检查文件变更；不代表此项通过。
              </p>
            </details>
          </li>
        </ul>
        <div v-show="showingFollowUp">
          <section v-if="snapshot.followUpQuestion" aria-labelledby="follow-up-title">
            <h3 id="follow-up-title" class="sr-only">理解追问</h3>
            <p class="whitespace-pre-wrap leading-7 text-body">
              {{ snapshot.followUpQuestion.question }}
            </p>
            <ul class="mt-3 flex flex-wrap gap-3" aria-label="追问引用">
              <li v-for="(citation, index) in snapshot.followUpQuestion.citations" :key="index">
                <button
                  type="button"
                  class="action-button min-h-11 px-2 text-base text-link focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
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
          <p v-else class="text-base leading-6 text-muted">
            本次报告没有保存追问。笔记未满足出题条件或执行预算不足时，都可能没有追问。
          </p>
        </div>
      </template>
      <template v-if="snapshot.submissionId">
        <button
          type="button"
          class="action-button min-h-11 px-3 text-base text-link focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
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
