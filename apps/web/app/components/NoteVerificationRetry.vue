<script setup lang="ts">
import type { NoteVerificationRunResponse, TaskDetailResponse } from '@knowledgeops/contracts'
import { useRetryNoteVerification } from '../composables/use-retry-note-verification'

const props = defineProps<{ run: NoteVerificationRunResponse; task: TaskDetailResponse }>()
const { busy, issue, retryRunId, retryableState, canRetry, retry } = useRetryNoteVerification(
  () => ({ run: props.run, task: props.task }),
)
const target = (runId: string) => ({
  path: `/app/tasks/${props.task.id}`,
  query: { runId },
  hash: '#note-report',
})
</script>

<template>
  <div v-if="retryableState || retryRunId || run.retryOfRunId" class="space-y-3">
    <NuxtLink
      v-if="run.retryOfRunId"
      :to="target(run.retryOfRunId)"
      class="action-button inline-flex min-h-11 items-center text-base text-link focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
    >
      查看重试来源
    </NuxtLink>
    <template v-if="retryRunId">
      <p class="text-base leading-6 text-muted" role="status">
        已有关联的重试运行，原记录保持不变。
      </p>
      <NuxtLink
        :to="target(retryRunId)"
        class="action-button inline-flex min-h-11 items-center text-base text-link focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
      >
        查看重试运行
      </NuxtLink>
    </template>
    <template v-else-if="canRetry">
      <p class="text-base leading-6 text-muted">
        重试会用原提交的固定证据开始新一轮验收，可能产生新的模型用量。
      </p>
      <button
        type="button"
        :disabled="busy"
        class="min-h-11 rounded-full border border-ink px-6 text-base disabled:border-muted-soft disabled:text-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
        @click="retry"
      >
        {{ busy ? '正在提交重试' : '重试本次笔记验收' }}
      </button>
    </template>
    <p v-else-if="retryableState" class="text-base leading-6 text-muted">
      当前任务暂不支持重试这份笔记，请刷新报告并查看最新运行。
    </p>
    <p v-if="issue" class="text-base leading-6 text-warning" role="alert">{{ issue }}</p>
  </div>
</template>
