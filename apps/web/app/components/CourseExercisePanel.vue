<script setup lang="ts">
import {
  submitCourseExerciseInputSchema,
  type CourseExerciseSubmission,
  type PublicExerciseSet,
  type SubmitCourseExerciseInput,
} from '@knowledgeops/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, onMounted, ref, watch } from 'vue'

import { useKnowledgeOpsApi } from '../composables/use-knowledge-ops-api'
import { useSessionUser } from '../composables/use-session-user'
import { knowledgeOpsQueryKeys } from '../lib/query-keys'

const props = defineProps<{
  taskId: string
  taskVersion: number
  exercises: PublicExerciseSet
}>()
const emit = defineEmits<{ settled: [] }>()
const api = useKnowledgeOpsApi()
const queryClient = useQueryClient()
const user = useSessionUser()
const selected = ref<Record<string, string>>({})
const followUpAnswer = ref('')
const retrying = ref(false)
const lastAttempt = ref<SubmitCourseExerciseInput | null>(null)
const storageIssue = ref('')
const storageKey = computed(() => {
  const userId = user.value?.id
  return userId ? `knowledgeops:course-exercise-command:v1:${userId}:${props.taskId}` : null
})
const history = useQuery({
  queryKey: computed(() => knowledgeOpsQueryKeys.courseExercises(props.taskId)),
  queryFn: ({ signal }) => api.getCourseExerciseSubmissions(props.taskId, signal),
  staleTime: 0,
  refetchInterval: (query) =>
    query.state.data?.submissions.some(
      (item) => item.status === 'QUEUED' || item.status === 'RUNNING',
    )
      ? 1_000
      : false,
  refetchIntervalInBackground: false,
})
const latest = computed(() => history.data.value?.submissions[0] ?? null)
const active = computed(
  () => latest.value?.status === 'QUEUED' || latest.value?.status === 'RUNNING',
)
const showForm = computed(() => retrying.value || (!active.value && !latest.value?.report))
const failureMessage = computed(() => {
  if (latest.value?.errorCode === 'EXECUTION_CONTEXT_CHANGED')
    return '课程状态已变化，请刷新页面后恢复最新练习状态。'
  if (latest.value?.errorCode === 'RUN_DEADLINE_EXCEEDED')
    return '本次验收超时，答案已保留，可直接重试提交。'
  return 'AI 验收暂时未完成，答案已保留，可直接重试提交；无需重新作答。'
})

function clearAttempt() {
  lastAttempt.value = null
  const key = storageKey.value
  if (!key) return
  try {
    window.sessionStorage.removeItem(key)
    storageIssue.value = ''
  } catch {
    storageIssue.value = '浏览器无法更新本地练习记录，请检查存储设置。'
  }
}

const submit = useMutation({
  mutationFn: (input: SubmitCourseExerciseInput) => api.submitCourseExercise(props.taskId, input),
  onSuccess: async () => {
    retrying.value = false
    clearAttempt()
    await queryClient.invalidateQueries({
      queryKey: knowledgeOpsQueryKeys.courseExercises(props.taskId),
    })
  },
  onError: async () => {
    await queryClient.invalidateQueries({
      queryKey: knowledgeOpsQueryKeys.courseExercises(props.taskId),
    })
  },
})

function restoreAnswers(submission: CourseExerciseSubmission) {
  selected.value = Object.fromEntries(
    submission.answers.multipleChoiceAnswers.map((answer) => [answer.questionId, answer.optionId]),
  )
  followUpAnswer.value = submission.answers.followUpAnswer
}

function retry() {
  selected.value = {}
  followUpAnswer.value = ''
  retrying.value = true
  submit.error.value = null
}

async function submitAnswers() {
  if (submit.isPending.value || active.value) return
  const inputWithoutId = {
    expectedTaskVersion: props.taskVersion,
    multipleChoiceAnswers: props.exercises.multipleChoice.map((question) => ({
      questionId: question.id,
      optionId: selected.value[question.id] ?? '',
    })),
    followUpAnswer: followUpAnswer.value.trim(),
  }
  if (
    inputWithoutId.multipleChoiceAnswers.some((answer) => !answer.optionId) ||
    inputWithoutId.followUpAnswer.length < 2
  ) {
    submit.error.value = new Error('请完成全部选择题并填写开放追问。')
    return
  }
  const previous = lastAttempt.value
  const previousInput = previous
    ? {
        expectedTaskVersion: previous.expectedTaskVersion,
        multipleChoiceAnswers: previous.multipleChoiceAnswers,
        followUpAnswer: previous.followUpAnswer,
      }
    : null
  const input = {
    ...inputWithoutId,
    requestId:
      previous && JSON.stringify(previousInput) === JSON.stringify(inputWithoutId)
        ? previous.requestId
        : crypto.randomUUID(),
  }
  const parsed = submitCourseExerciseInputSchema.safeParse(input)
  if (!parsed.success) {
    submit.error.value = new Error('练习答案不完整，请检查后重试。')
    return
  }
  const key = storageKey.value
  if (!key) {
    storageIssue.value = '无法确认当前用户，本次练习尚未提交。请重新登录后再试。'
    return
  }
  try {
    window.sessionStorage.setItem(key, JSON.stringify(parsed.data))
    storageIssue.value = ''
  } catch {
    storageIssue.value = '浏览器无法保存提交记录，本次尚未发送。请检查存储设置后再试。'
    return
  }
  lastAttempt.value = parsed.data
  submit.error.value = null
  await submit.mutateAsync(parsed.data).catch(() => undefined)
}

function outcomeLabel(outcome: string) {
  if (outcome === 'PASSED') return '通过'
  if (outcome === 'FAILED') return '需要修正'
  return '证据不足'
}

function optionText(questionId: string, optionId: string) {
  const question = props.exercises.multipleChoice.find((item) => item.id === questionId)
  return question?.options.find((option) => option.id === optionId)?.text ?? optionId
}

watch(
  () => latest.value,
  (current, previous) => {
    if (
      current &&
      previous &&
      (previous.status === 'QUEUED' || previous.status === 'RUNNING') &&
      (current.status === 'SUCCEEDED' || current.status === 'FAILED')
    )
      emit('settled')
    if (current && !current.report && !active.value && !lastAttempt.value) restoreAnswers(current)
  },
)
onMounted(() => {
  const key = storageKey.value
  if (!key) return
  try {
    const raw = window.sessionStorage.getItem(key)
    if (!raw) return
    const restored = submitCourseExerciseInputSchema.parse(JSON.parse(raw))
    if (restored.expectedTaskVersion !== props.taskVersion) {
      clearAttempt()
      return
    }
    lastAttempt.value = restored
    selected.value = Object.fromEntries(
      restored.multipleChoiceAnswers.map((answer) => [answer.questionId, answer.optionId]),
    )
    followUpAnswer.value = restored.followUpAnswer
    retrying.value = true
  } catch {
    lastAttempt.value = null
    storageIssue.value = '本地练习提交记录不可用，请重新作答。'
  }
})
</script>

<template>
  <section
    class="border border-hairline-strong bg-surface-soft p-5"
    aria-labelledby="exercise-title"
  >
    <p class="font-mono text-caption tracking-label text-muted uppercase">COURSE PRACTICE</p>
    <h2 id="exercise-title" class="mt-2 text-section-title font-medium">练习与验收</h2>
    <p class="mt-2 text-base text-body">至少答对 3/4 道选择题，且开放追问通过，才能完成本课程。</p>

    <p v-if="history.isPending.value" class="mt-5 text-base text-muted">正在恢复练习记录…</p>
    <div v-else-if="history.isError.value" class="mt-5 text-base text-warning">
      <p>练习记录暂时读取失败。</p>
      <button class="action-button mt-2" type="button" @click="history.refetch()">重新读取</button>
    </div>

    <template v-else>
      <div v-if="active" class="mt-5 border-l-2 border-link pl-4" role="status">
        <p class="text-base font-medium text-ink">正在验收本次练习<AnimatedEllipsis /></p>
        <p class="mt-1 text-base text-muted">选择题已提交，开放追问正在由 Agent 验收。</p>
      </div>

      <div
        v-if="latest?.status === 'FAILED' && !retrying"
        class="mt-5 text-base text-warning"
        role="alert"
      >
        {{ failureMessage }}
      </div>

      <div v-if="latest?.report && !active && !retrying" class="mt-5" data-testid="exercise-report">
        <p class="text-base font-medium text-ink">
          选择题 {{ latest.report.correctCount }}/4 ·
          {{ latest.report.passed ? '课程通过' : '尚需修订' }}
        </p>
        <div class="mt-4 space-y-4">
          <article
            v-for="result in latest.report.multipleChoice"
            :key="result.questionId"
            class="border-t border-hairline pt-3"
          >
            <p class="text-base text-body">
              {{
                exercises.multipleChoice.find((question) => question.id === result.questionId)
                  ?.prompt
              }}
            </p>
            <p class="mt-1 text-sm" :class="result.correct ? 'text-ink' : 'text-warning'">
              {{ result.correct ? '回答正确' : '回答错误' }}：{{
                optionText(result.questionId, result.selectedOptionId)
              }}
            </p>
            <p class="mt-1 text-sm text-muted">解析：{{ result.explanation }}</p>
          </article>
        </div>
        <div class="mt-5 border-t border-hairline pt-4">
          <p class="text-base font-medium text-ink">
            开放追问：{{ outcomeLabel(latest.report.followUp.outcome) }}
          </p>
          <p class="mt-2 whitespace-pre-line text-base text-body">
            {{ latest.report.followUp.rationale }}
          </p>
          <ul
            v-if="latest.report.followUp.suggestions.length"
            class="mt-2 list-disc pl-5 text-base text-body"
          >
            <li v-for="suggestion in latest.report.followUp.suggestions" :key="suggestion">
              {{ suggestion }}
            </li>
          </ul>
        </div>
        <button
          v-if="!latest.report.passed"
          class="action-button mt-5 border-ink"
          type="button"
          @click="retry"
        >
          重新作答
        </button>
      </div>

      <form v-if="showForm && !active" class="mt-5" @submit.prevent="submitAnswers">
        <fieldset
          v-for="(question, index) in exercises.multipleChoice"
          :key="question.id"
          class="border-t border-hairline py-4"
          :disabled="submit.isPending.value"
        >
          <legend class="text-base font-medium text-ink">
            {{ index + 1 }}. {{ question.prompt }}
          </legend>
          <label
            v-for="option in question.options"
            :key="option.id"
            class="mt-2 flex min-h-11 cursor-pointer items-start gap-3 text-base text-body"
          >
            <input
              v-model="selected[question.id]"
              type="radio"
              :name="`exercise-${question.id}`"
              :value="option.id"
            />
            <span>{{ option.text }}</span>
          </label>
        </fieldset>
        <label class="mt-4 block">
          <span class="text-base font-medium text-ink">{{ exercises.followUp.prompt }}</span>
          <textarea
            v-model="followUpAnswer"
            class="mt-2 min-h-32 w-full resize-y border border-hairline-strong bg-transparent p-3 text-base text-ink outline-none focus:border-link"
            maxlength="8000"
            :disabled="submit.isPending.value"
          />
        </label>
        <p v-if="storageIssue" class="mt-2 text-sm text-warning" role="alert">{{ storageIssue }}</p>
        <p v-if="submit.error.value" class="mt-2 text-sm text-warning" role="alert">
          {{ submit.error.value.message }}
        </p>
        <button
          class="action-button mt-4 w-full border-ink"
          type="submit"
          :disabled="submit.isPending.value"
        >
          {{ submit.isPending.value ? '正在提交…' : submit.error.value ? '重试提交' : '提交练习' }}
        </button>
      </form>
    </template>
  </section>
</template>
