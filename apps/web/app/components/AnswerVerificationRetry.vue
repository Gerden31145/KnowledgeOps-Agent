<script setup lang="ts">
import type { FollowUpAnswerResponse, TaskDetailResponse } from '@knowledgeops/contracts'
import { useRetryAnswerVerification } from '../composables/use-retry-answer-verification'

const props = defineProps<{
  answer: FollowUpAnswerResponse
  task: TaskDetailResponse
  noteRunId: string
}>()
const { busy, issue, retryRunId, retryableState, canRetry, retry } = useRetryAnswerVerification(
  () => props,
)
const target = (answerRunId: string) => ({
  path: `/app/tasks/${props.task.id}`,
  query: {
    tab: 'follow-up',
    runId: props.noteRunId,
    answerId: props.answer.answerSubmissionId,
    answerRunId,
  },
  hash: '#follow-up-answer',
})
</script>

<template>
  <div v-if="retryableState || retryRunId || answer.run.retryOfRunId" class="space-y-3">
    <NuxtLink
      v-if="answer.run.retryOfRunId"
      :to="target(answer.run.retryOfRunId)"
      class="action-button inline-flex min-h-11 items-center text-base text-link focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
    >
      查看回答重试来源
    </NuxtLink>
    <template v-if="retryRunId">
      <p class="text-base leading-6 text-muted" role="status">
        这份回答已有关联的重试运行，原记录保持不变。
      </p>
      <NuxtLink
        :to="target(retryRunId)"
        class="action-button inline-flex min-h-11 items-center text-base text-link focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
      >
        查看回答重试运行
      </NuxtLink>
    </template>
    <template v-else-if="canRetry">
      <p class="text-base leading-6 text-muted">
        重试将重新验收这份已保存的回答，可能产生新的模型用量。修改回答请提交新的答案。
      </p>
      <button
        type="button"
        :disabled="busy"
        class="min-h-11 rounded-full border border-ink px-6 text-base disabled:border-muted-soft disabled:text-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
        @click="retry"
      >
        {{ busy ? '正在提交重试' : '重试本次回答验收' }}
      </button>
    </template>
    <p v-else-if="retryableState" class="text-base leading-6 text-muted">
      当前任务暂不支持重试这份回答，请刷新并查看最新笔记及回答运行。
    </p>
    <p v-if="issue" class="text-base leading-6 text-warning" role="alert">{{ issue }}</p>
  </div>
</template>
