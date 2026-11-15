<script setup lang="ts">
import {
  askCourseQuestionInputSchema,
  type AskCourseQuestionInput,
  type CourseQuestionDepth,
  type CourseSection,
} from '@knowledgeops/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { useKnowledgeOpsApi } from '../composables/use-knowledge-ops-api'
import { useSessionUser } from '../composables/use-session-user'
import { knowledgeOpsQueryKeys } from '../lib/query-keys'

const props = defineProps<{
  taskId: string
  section: CourseSection | null
  selectedText: string
  open: boolean
  desktopOffset: number
}>()
const emit = defineEmits<{ close: []; open: []; restore: [AskCourseQuestionInput] }>()

const api = useKnowledgeOpsApi()
const queryClient = useQueryClient()
const user = useSessionUser()
const panel = ref<HTMLElement | null>(null)
const historyElement = ref<HTMLElement | null>(null)
const questionInput = ref<HTMLTextAreaElement | null>(null)
const draft = ref('')
const depth = ref<CourseQuestionDepth>('CONTEXTUAL')
const lastAttempt = ref<AskCourseQuestionInput | null>(null)
const storageIssue = ref('')
const depths: { id: CourseQuestionDepth; label: string; description: string }[] = [
  { id: 'QUICK', label: '快速解惑', description: '只解释当前疑问，短答不展开' },
  { id: 'CONTEXTUAL', label: '情境理解', description: '结合本节开发情景与短示例' },
  { id: 'DEEP', label: '深入原理', description: '展开机制、边界与易错点' },
]
const storageKey = computed(() => {
  const userId = user.value?.id
  return userId ? `knowledgeops:course-question-command:v1:${userId}:${props.taskId}` : null
})
const history = useQuery({
  queryKey: computed(() => knowledgeOpsQueryKeys.courseQuestions(props.taskId)),
  queryFn: ({ signal }) => api.getCourseQuestions(props.taskId, signal),
  staleTime: 0,
  refetchInterval: (query) =>
    query.state.data?.questions.some(
      (item) => item.status === 'QUEUED' || item.status === 'RUNNING',
    )
      ? 1_000
      : false,
  refetchIntervalInBackground: false,
})

function clearStoredAttempt() {
  const key = storageKey.value
  if (!key) return
  try {
    window.sessionStorage.removeItem(key)
    storageIssue.value = ''
  } catch {
    storageIssue.value = '浏览器无法更新本地提问记录，请检查存储设置。'
  }
}

function clearAttempt() {
  lastAttempt.value = null
  clearStoredAttempt()
}

const ask = useMutation({
  mutationFn: (input: AskCourseQuestionInput) => api.askCourseQuestion(props.taskId, input),
  onSuccess: async () => {
    draft.value = ''
    clearAttempt()
    await queryClient.invalidateQueries({
      queryKey: knowledgeOpsQueryKeys.courseQuestions(props.taskId),
    })
  },
  onError: async () => {
    await queryClient.invalidateQueries({
      queryKey: knowledgeOpsQueryKeys.courseQuestions(props.taskId),
    })
  },
})

function restoreAttempt() {
  const key = storageKey.value
  if (!key) return
  try {
    const raw = window.sessionStorage.getItem(key)
    if (!raw) return
    const restored = askCourseQuestionInputSchema.parse(JSON.parse(raw))
    lastAttempt.value = restored
    draft.value = restored.question
    depth.value = restored.depth
    emit('restore', restored)
  } catch {
    lastAttempt.value = null
    storageIssue.value = '本地提问记录不可用，请重新选择原文后提问。'
  }
}

async function submit() {
  if (!props.section || ask.isPending.value) return
  const question = draft.value.trim()
  if (question.length < 2) {
    ask.error.value = new Error('请至少输入两个字的问题。')
    return
  }
  const inputWithoutId = {
    sectionId: props.section.id,
    selectedText: props.selectedText,
    question,
    depth: depth.value,
  }
  const previous = lastAttempt.value
  const sameAttempt =
    previous?.sectionId === inputWithoutId.sectionId &&
    previous.selectedText === inputWithoutId.selectedText &&
    previous.question === inputWithoutId.question &&
    previous.depth === inputWithoutId.depth
  const input = {
    ...inputWithoutId,
    requestId: sameAttempt && previous ? previous.requestId : crypto.randomUUID(),
  }
  const key = storageKey.value
  if (!key) {
    storageIssue.value = '无法确认当前用户，本次提问尚未发送。请重新登录后再试。'
    return
  }
  try {
    window.sessionStorage.setItem(key, JSON.stringify(input))
    storageIssue.value = ''
  } catch {
    storageIssue.value = '浏览器无法保存提问记录，本次尚未发送。请检查存储设置后再试。'
    return
  }
  lastAttempt.value = input
  ask.error.value = null
  await ask.mutateAsync(input).catch(() => undefined)
}

function depthLabel(value: CourseQuestionDepth): string {
  return depths.find((item) => item.id === value)?.label ?? value
}

async function scrollToLatest() {
  await nextTick()
  historyElement.value?.scrollTo({ top: historyElement.value.scrollHeight })
}

function panelKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    emit('close')
    return
  }
  if (
    event.key !== 'Tab' ||
    !props.open ||
    window.matchMedia('(min-width: 1024px)').matches ||
    !panel.value
  )
    return
  const focusable = Array.from(
    panel.value.querySelectorAll<HTMLElement>(
      'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), [tabindex="0"]',
    ),
  ).filter((element) => element.offsetParent !== null)
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(
  () => [props.section?.id, props.selectedText],
  () => {
    const previous = lastAttempt.value
    const restored =
      previous !== null &&
      previous.sectionId === props.section?.id &&
      previous.selectedText === props.selectedText
    if (!restored) clearAttempt()
    ask.error.value = null
  },
)
watch(
  () => history.data.value?.questions.length,
  () => scrollToLatest(),
)
watch(
  () => [props.open, props.section?.id],
  async () => {
    await nextTick()
    if (props.section) questionInput.value?.focus()
  },
)
watch(
  () => props.open,
  (open) => {
    if (open && !window.matchMedia('(min-width: 1024px)').matches)
      document.body.style.overflow = 'hidden'
    else document.body.style.overflow = ''
  },
)
watch(
  () => props.taskId,
  () => {
    draft.value = ''
    lastAttempt.value = null
    depth.value = 'CONTEXTUAL'
  },
)
onMounted(restoreAttempt)
onBeforeUnmount(() => {
  document.body.style.overflow = ''
})
</script>

<template>
  <button
    v-if="!open"
    class="action-button fixed bottom-5 right-5 z-30 border-ink bg-surface-elevated lg:hidden"
    type="button"
    @click="emit('open')"
  >
    课程答疑
  </button>
  <button
    v-if="open"
    class="fixed inset-0 z-40 bg-ink/20 lg:hidden"
    type="button"
    aria-label="关闭课程答疑"
    @click="emit('close')"
  />
  <aside
    ref="panel"
    class="z-50 flex max-h-[85dvh] flex-col overflow-y-auto border border-hairline-strong bg-surface-elevated lg:sticky lg:top-[var(--course-question-offset)] lg:z-auto lg:max-h-[calc(100dvh-var(--course-question-offset))] lg:self-start"
    :class="open ? 'fixed inset-x-0 bottom-0' : 'hidden lg:block'"
    :style="{ '--course-question-offset': `${desktopOffset}px` }"
    role="dialog"
    aria-label="课程选文答疑"
    @keydown="panelKeydown"
  >
    <header class="flex shrink-0 items-start justify-between gap-4 border-b border-hairline p-5">
      <div>
        <p class="font-mono text-caption tracking-label text-muted uppercase">COURSE Q&amp;A</p>
        <h2 class="mt-1 text-section-title font-medium">结合原文提问</h2>
      </div>
      <button
        class="action-button lg:hidden"
        type="button"
        aria-label="关闭答疑"
        @click="emit('close')"
      >
        关闭
      </button>
    </header>

    <div ref="historyElement" class="min-h-0 flex-1 overflow-y-auto p-5">
      <div v-if="section" class="border-l-2 border-link pl-3">
        <p class="text-sm text-muted">{{ section.title }} · 选中原文</p>
        <blockquote class="mt-2 max-h-32 overflow-y-auto whitespace-pre-line text-base text-body">
          {{ selectedText }}
        </blockquote>
      </div>
      <p v-else class="text-base text-muted">
        在课程中选中一段文字，或使用“就本节提问”。回答只结合课程上下文，不涉及练习答案。
      </p>

      <div class="mt-5 space-y-5" aria-live="polite">
        <p v-if="history.isPending.value" class="text-base text-muted">正在恢复答疑历史…</p>
        <div v-else-if="history.isError.value" class="text-base text-warning">
          <p>答疑历史暂时读取失败。</p>
          <button class="action-button mt-2" type="button" @click="history.refetch()">
            重新读取
          </button>
        </div>
        <article
          v-for="item in history.data.value?.questions"
          :key="item.id"
          class="border-t border-hairline pt-4"
        >
          <p class="text-sm text-muted">{{ depthLabel(item.depth) }} · 你问</p>
          <p class="mt-1 whitespace-pre-line text-base text-ink">{{ item.question }}</p>
          <p v-if="item.answer" class="mt-3 whitespace-pre-line text-base leading-7 text-body">
            {{ item.answer }}
          </p>
          <p v-else-if="item.status === 'FAILED'" class="mt-3 text-base text-warning">
            本次回答未完成，可以重新提问。
          </p>
          <p v-else class="mt-3 text-base text-muted">回答仍在处理中，可稍后刷新历史。</p>
        </article>
      </div>
    </div>

    <form class="shrink-0 border-t border-hairline p-5" @submit.prevent="submit">
      <fieldset :disabled="ask.isPending.value">
        <legend class="text-sm font-medium text-ink">回答深度</legend>
        <label
          v-for="item in depths"
          :key="item.id"
          class="mt-1 flex min-h-11 cursor-pointer items-center gap-3 text-base text-body"
        >
          <input v-model="depth" type="radio" name="course-question-depth" :value="item.id" />
          <span
            >{{ item.label }}<span class="text-muted"> · {{ item.description }}</span></span
          >
        </label>
      </fieldset>
      <label class="mt-3 block">
        <span class="text-sm font-medium text-ink">你的问题</span>
        <textarea
          ref="questionInput"
          v-model="draft"
          class="mt-2 min-h-24 w-full resize-y border border-hairline-strong bg-transparent p-3 text-base text-ink outline-none focus:border-link"
          maxlength="1000"
          rows="3"
          placeholder="例如：为什么这里不会阻塞下一次渲染？"
          :disabled="!section || ask.isPending.value"
        />
      </label>
      <p v-if="storageIssue" class="mt-2 text-sm text-warning" role="alert">
        {{ storageIssue }}
      </p>
      <p v-if="ask.error.value" class="mt-2 text-sm text-warning" role="alert">
        {{ ask.error.value.message }}；问题已保留，可重试。
      </p>
      <button
        class="action-button mt-3 w-full border-ink"
        type="submit"
        :disabled="!section || draft.trim().length < 2 || ask.isPending.value"
      >
        {{ ask.isPending.value ? 'AI 正在回答…' : ask.error.value ? '重试回答' : '发送问题' }}
      </button>
    </form>
  </aside>
</template>
