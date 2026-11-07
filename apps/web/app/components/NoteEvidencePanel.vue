<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import type { NoteCitation } from '@knowledgeops/contracts'
import { useNoteRunEvidenceQuery } from '../composables/use-workspace-queries'
import { matchesNoteCitation } from '../lib/note-evidence'
import { KnowledgeOpsApiError } from '../lib/knowledge-ops-api'

const props = defineProps<{
  taskId: string
  runId: string
  selection: { citation: NoteCitation; request: number } | null
}>()
const query = useNoteRunEvidenceQuery(props.taskId, props.runId)
const data = query.data
const pageSize = 100
const page = ref(0)
const highlighted = ref<NoteCitation | null>(null)
const locationMessage = ref('')
const body = useTemplateRef<HTMLElement>('body')
const pageCount = computed(() => Math.max(1, Math.ceil((data.value?.lines.length ?? 0) / pageSize)))
const visibleLines = computed(() =>
  (data.value?.lines ?? [])
    .slice(page.value * pageSize, (page.value + 1) * pageSize)
    .map((text, index) => ({ text, number: page.value * pageSize + index + 1 })),
)
const denied = computed(
  () => query.error.value instanceof KnowledgeOpsApiError && query.error.value.status === 401,
)
const missing = computed(
  () => query.error.value instanceof KnowledgeOpsApiError && query.error.value.status === 404,
)

// 数据和引用都就绪后才定位；切换运行会卸载本组件并取消读取。
watch(
  [data, query.isError, () => props.selection],
  async ([loaded, failed, selection], _, onCleanup) => {
    let stale = false
    onCleanup(() => {
      stale = true
    })
    highlighted.value = null
    locationMessage.value = ''
    if (!loaded || failed || !selection) return
    const citation = selection.citation
    if (!matchesNoteCitation(loaded.evidence, loaded.lines, citation)) {
      locationMessage.value = '这条引用与本次固定证据不一致，无法定位。'
      return
    }
    highlighted.value = citation
    page.value = Math.floor((citation.startLine - 1) / pageSize)
    locationMessage.value = `已定位原文第 ${citation.startLine}–${citation.endLine} 行。`
    await nextTick()
    if (stale) return
    const line = body.value?.querySelector<HTMLElement>(`[data-line="${citation.startLine}"]`)
    line?.scrollIntoView({ behavior: 'instant', block: 'center' })
    line?.focus({ preventScroll: true })
  },
  { immediate: true },
)
</script>

<template>
  <section class="min-w-0 border-t border-hairline pt-6" aria-labelledby="note-evidence-title">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <h3 id="note-evidence-title" class="text-section-title font-medium">本次固定证据</h3>
      <button
        type="button"
        :disabled="query.isFetching.value"
        class="action-button min-h-11 px-3 text-base text-link disabled:text-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
        @click="query.refetch()"
      >
        重新读取证据
      </button>
    </div>
    <AsyncStatePanel
      v-if="query.isError.value"
      class="mt-4"
      tone="warning"
      :title="denied ? '登录已过期' : missing ? '无法查看此证据' : '证据读取失败'"
      :description="
        denied
          ? '请重新登录后查看固定正文。'
          : missing
            ? '证据不存在，或当前账号无权访问。'
            : '请稍后重试。本次读取失败不会改变验收结果。'
      "
    >
      <template v-if="denied" #actions>
        <NuxtLink
          :to="{ path: '/login', query: { next: $route.fullPath } }"
          class="action-button inline-flex min-h-11 items-center text-link focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
          >重新登录</NuxtLink
        >
      </template>
    </AsyncStatePanel>
    <AsyncStatePanel
      v-else-if="query.isPending.value"
      class="mt-4"
      title="正在读取固定证据"
      description="读取这次运行所用的正文和 Diff。"
    />
    <template v-else-if="data">
      <dl class="mt-4 space-y-2 font-mono text-base text-muted [overflow-wrap:anywhere]">
        <div>
          <dt class="inline">文件：</dt>
          <dd class="inline">{{ data.evidence.path }}</dd>
        </div>
        <div>
          <dt class="inline">正文 Commit：</dt>
          <dd class="inline">{{ data.evidence.sourceCommitSha }}</dd>
        </div>
        <div v-if="data.evidence.previousPath">
          <dt class="inline">原路径：</dt>
          <dd class="inline">{{ data.evidence.previousPath }}</dd>
        </div>
      </dl>
      <p class="mt-3 text-base leading-6 text-muted">
        这是本次取证保存的内容；仓库后续更新不会改变这里的正文。
      </p>
      <p v-if="data.evidence.change === 'removed'" class="mt-3 text-base text-warning">
        文件已删除，以下为删除前提交的正文，不代表当前仓库仍存在此文件。
      </p>
      <p role="status" class="mt-3 text-base text-link">{{ locationMessage }}</p>
      <p v-if="!data.lines.length" class="mt-4 text-body">此提交保存的是空文件。</p>
      <div
        v-else
        ref="body"
        class="mt-4 border-y border-hairline py-3 font-mono text-base leading-6"
        aria-label="固定正文（带行号）"
      >
        <div
          v-for="line in visibleLines"
          :key="line.number"
          :data-line="line.number"
          tabindex="-1"
          class="flex min-w-0 scroll-mt-8 gap-3 px-2 focus-visible:outline-2 focus-visible:outline-link"
          :class="
            highlighted &&
            line.number >= highlighted.startLine &&
            line.number <= highlighted.endLine
              ? 'border-l-2 border-link bg-surface-elevated text-ink'
              : 'border-l-2 border-transparent text-body'
          "
        >
          <span class="w-12 shrink-0 text-right text-muted" :aria-label="`第 ${line.number} 行`">{{
            line.number
          }}</span>
          <code class="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{{
            line.text || '\u00a0'
          }}</code>
        </div>
      </div>
      <nav
        v-if="pageCount > 1"
        class="mt-3 flex flex-wrap items-center gap-4 text-base"
        aria-label="原文分页"
      >
        <button
          type="button"
          :disabled="page === 0"
          class="action-button min-h-11 px-3 text-link disabled:text-muted focus-visible:outline-2 focus-visible:outline-link"
          @click="page--"
        >
          上一页
        </button>
        <span aria-live="polite">第 {{ page + 1 }} / {{ pageCount }} 页</span>
        <button
          type="button"
          :disabled="page + 1 >= pageCount"
          class="action-button min-h-11 px-3 text-link disabled:text-muted focus-visible:outline-2 focus-visible:outline-link"
          @click="page++"
        >
          下一页
        </button>
      </nav>
      <h4 class="mt-6 text-lg">本次 Diff</h4>
      <p v-if="data.evidence.mode === 'SNAPSHOT'" class="mt-3 leading-7 text-muted">
        本次为全文快照，未保存 Diff；不据此判断文件是否发生变更。
      </p>
      <template v-else>
        <p class="mt-3 font-mono text-base text-muted [overflow-wrap:anywhere]">
          {{ data.evidence.beforeCommitSha }} → {{ data.evidence.afterCommitSha }}
        </p>
        <pre
          v-if="data.evidence.diff"
          tabindex="0"
          aria-label="本次提交的 Diff"
          class="mt-4 max-h-96 overflow-auto whitespace-pre-wrap border-y border-hairline py-4 font-mono text-base leading-6 text-body [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-link"
          >{{ data.evidence.diff }}</pre>
        <p v-else class="mt-3 text-muted">没有可展示的 Diff 文本，不代表文件未变化。</p>
      </template>
    </template>
  </section>
</template>
