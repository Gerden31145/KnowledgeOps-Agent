<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { navigateTo } from '#imports'
import type { RepositoryEvidenceStatus, RepositoryEvidenceResponse } from '@knowledgeops/contracts'
import { useKnowledgeOpsApi } from '../composables/use-knowledge-ops-api'
import { useSessionUser } from '../composables/use-session-user'
import { KnowledgeOpsApiError } from '../lib/knowledge-ops-api'

const props = defineProps<{ repositoryId: string }>()
const api = useKnowledgeOpsApi()
const user = useSessionUser()
const client = useQueryClient()
const retryNotice = ref('')
let disposed = false
onBeforeUnmount(() => {
  disposed = true
})
const history = useQuery({
  queryKey: computed(() => [
    'knowledgeops',
    'repository-evidence',
    user.value?.id,
    props.repositoryId,
  ]),
  queryFn: ({ signal }) => api.getRepositoryEvidence(props.repositoryId, signal),
  enabled: computed(() => !!user.value),
  staleTime: 0,
  retry: false,
  gcTime: 0,
})
watch(history.error, (error) => {
  if (error instanceof KnowledgeOpsApiError && error.status === 401) {
    user.value = null
    client.clear()
    void navigateTo('/login')
  }
})
// 命令回调也绑定用户/仓库；切换绑定或退出后，旧 POST 的迟到响应不影响新页面。
const retry = useMutation({
  mutationFn: (command: {
    userId: string
    repositoryId: string
    deliveryId: string
    expectedAttemptCount: number
    action: 'retry' | 'resync'
  }) =>
    (command.action === 'resync' ? api.resyncRepositoryEvidence : api.retryRepositoryEvidence)(
      command.repositoryId,
      command.deliveryId,
      {
        expectedAttemptCount: command.expectedAttemptCount,
      },
    ),
  retry: false,
  onSettled: async (data, error, command) => {
    if (
      disposed ||
      user.value?.id !== command.userId ||
      props.repositoryId !== command.repositoryId
    )
      return
    if (error instanceof KnowledgeOpsApiError && error.status === 401) {
      user.value = null
      client.clear()
      void navigateTo('/login')
      return
    }
    retryNotice.value = data
      ? `${command.action === 'resync' ? '全文快照重新同步' : '重试'}请求已受理，等待后台取证；这不代表验收成功。可稍后刷新取证记录。`
      : error instanceof KnowledgeOpsApiError && [404, 409].includes(error.status)
        ? '原绑定、任务或取证状态已变化，或此失败不支持本次操作。请刷新记录和绑定状态。'
        : '未能确认恢复请求是否受理，请先刷新记录。网络错误不代表后台取证失败。'
    await client.invalidateQueries({
      queryKey: ['knowledgeops', 'repository-evidence', command.userId, command.repositoryId],
    })
  },
})
function requestRetry(
  item: RepositoryEvidenceResponse['deliveries'][number],
  action: 'retry' | 'resync',
) {
  if (
    !user.value ||
    retry.isPending.value ||
    history.isFetching.value ||
    !(action === 'resync' ? item.canResync : item.canRetry)
  )
    return
  retryNotice.value = ''
  retry.mutate({
    userId: user.value.id,
    repositoryId: props.repositoryId,
    deliveryId: item.deliveryId,
    expectedAttemptCount: item.attemptCount,
    action,
  })
}
const errorText = computed(() => {
  const error = history.error.value
  if (!error) return ''
  if (error instanceof KnowledgeOpsApiError && error.status === 404)
    return '本次绑定已不可用，请使用下方“刷新状态”重新读取绑定。旧通知已隐藏。'
  return '未能读取取证记录，请检查网络并刷新记录。这不代表取证或任务验收失败。'
})
const labels: Record<RepositoryEvidenceStatus, string> = {
  PENDING: '等待取证结果',
  RETRYING: '曾失败，等待后续结果',
  FAILED: '取证失败',
  RESYNC_REQUIRED: '需要重新同步',
  DISPATCH_FAILED: '队列投递失败',
  IGNORED: '已忽略',
  COLLECTED: '已取证',
}
</script>

<template>
  <section aria-labelledby="evidence-heading" class="space-y-5 border-b border-hairline pb-8">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <h2 id="evidence-heading" class="font-display text-2xl font-normal">最近取证通知</h2>
      <button
        type="button"
        :disabled="history.isFetching.value"
        class="min-h-11 rounded-full border border-hairline-strong px-6 font-mono text-sm disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
        @click="history.refetch()"
      >
        {{ history.isFetching.value ? '正在读取…' : '刷新取证记录' }}
      </button>
    </div>
    <p class="leading-7 text-muted">
      显示接收时明确属于本次绑定的最近 20 条 Push 通知，包括未进入取证的忽略记录。
      无法确认归属的历史通知不展示。
      刷新只读取已保存结果；“重试取证”和“按本次提交全文重新同步”才会提交恢复请求。
    </p>
    <p v-if="retryNotice" role="status" class="leading-7 text-body">{{ retryNotice }}</p>
    <p v-if="errorText" role="alert" class="text-warning">{{ errorText }}</p>
    <p v-else-if="history.isPending.value" role="status" class="text-muted">正在读取取证记录…</p>
    <template v-else-if="history.data.value && user">
      <p v-if="history.data.value.deliveries.length === 0" role="status" class="text-body">
        暂无可归属本次绑定的 Push 通知。这不代表 GitHub 没有发送 Push；请核对 Webhook 接收入口和 App
        的仓库授权。
      </p>
      <ol v-else class="divide-y divide-hairline" aria-label="取证通知">
        <li
          v-for="item in history.data.value.deliveries"
          :key="item.deliveryId"
          class="space-y-3 py-5"
        >
          <p class="font-mono text-sm">{{ labels[item.status] }}</p>
          <p v-if="item.targetPath" class="break-all text-body">目标：{{ item.targetPath }}</p>
          <p v-else class="text-body">未关联任务 · 未进入取证</p>
          <p class="leading-7 text-body">{{ item.message }}</p>
          <p class="break-all font-mono text-sm text-muted">Commit：{{ item.commitSha }}</p>
          <p class="text-sm text-muted">
            接收：<time :datetime="item.receivedAt">{{
              new Date(item.receivedAt).toLocaleString()
            }}</time>
            <span v-if="item.taskId"> · 已尝试 {{ item.attemptCount }} 次</span>
            <span v-else> · 未开始取证</span>
          </p>
          <p v-if="item.lastAttemptAt" class="text-sm text-muted">
            最近尝试：<time :datetime="item.lastAttemptAt">{{
              new Date(item.lastAttemptAt).toLocaleString()
            }}</time>
          </p>
          <button
            v-if="item.canRetry || item.canResync"
            type="button"
            :disabled="retry.isPending.value || history.isFetching.value"
            :aria-label="`${item.canResync ? '按本次提交全文重新同步' : '重试取证'}：${item.targetPath}，提交 ${item.commitSha.slice(0, 7)}`"
            class="min-h-11 rounded-full border border-hairline-strong px-6 font-mono text-sm disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
            @click="requestRetry(item, item.canResync ? 'resync' : 'retry')"
          >
            {{
              retry.isPending.value && retry.variables.value?.deliveryId === item.deliveryId
                ? '正在提交…'
                : item.canResync
                  ? '按本次提交全文重新同步'
                  : '重试取证'
            }}
          </button>
          <p v-if="item.canResync" class="leading-7 text-muted">
            仅读取上方固定 Commit 的目标正文，不切换到分支最新版本。此模式不提供原始 Diff，
            免检文件变化；正文与理解追问仍须验收。若该提交或文件也无法读取，重新同步仍会失败。
          </p>
        </li>
      </ol>
    </template>
  </section>
</template>
