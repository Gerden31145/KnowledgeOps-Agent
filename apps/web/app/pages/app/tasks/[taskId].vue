<script setup lang="ts">
import type { AskCourseQuestionInput, CourseSection } from '@knowledgeops/contracts'
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { definePageMeta, useHead, useRoute, useRouter } from '#imports'

import { useGlobalMessage } from '../../../composables/use-global-message'
import { useCourseApi } from '../../../composables/use-course-api'
import { useTaskQuery } from '../../../composables/use-course-query'
import { knowledgeOpsQueryKeys } from '../../../lib/query-keys'
import { isTransientReadError } from '../../../lib/verification-polling'

definePageMeta({ layout: 'workspace' })
useHead({ title: '任务详情 · KnowledgeOps Agent' })

const route = useRoute()
const api = useCourseApi()
const router = useRouter()
const taskId = computed(() => {
  const value = route.params.taskId
  return typeof value === 'string' ? value : null
})
const task = useTaskQuery(taskId)
const courseGenerationNow = ref(Date.now())
const courseGenerationElapsed = computed(() => {
  const queuedAt = task.data.value?.course?.generationQueuedAt
  if (!queuedAt) return '0:00'
  const elapsedSeconds = Math.max(
    0,
    Math.floor((courseGenerationNow.value - Date.parse(queuedAt)) / 1_000),
  )
  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = String(elapsedSeconds % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
})
watch(
  () => task.data.value?.course?.status === 'GENERATING',
  (generating, _previous, onCleanup) => {
    courseGenerationNow.value = Date.now()
    if (!generating || !import.meta.client) return
    const timer = window.setInterval(() => {
      courseGenerationNow.value = Date.now()
    }, 1_000)
    onCleanup(() => window.clearInterval(timer))
  },
  { immediate: true },
)
const courseTabs = [
  { id: 'content', label: '课程内容' },
  { id: 'exercise', label: '练习与验收' },
] as const
type CourseTab = (typeof courseTabs)[number]['id']
const courseTab = computed<CourseTab>(() =>
  route.query.tab === 'exercise' ? 'exercise' : 'content',
)
async function selectCourseTab(value: CourseTab) {
  await router.replace({ query: { ...route.query, tab: value }, hash: '' })
}
async function courseTabKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const index = courseTabs.findIndex(
    (item) => `course-tab-${item.id}` === (event.currentTarget as HTMLElement).id,
  )
  const nextIndex =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? courseTabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + courseTabs.length) % courseTabs.length
  const next = courseTabs[nextIndex]!.id
  await selectCourseTab(next)
  await nextTick()
  document.getElementById(`course-tab-${next}`)?.focus()
}

const courseHeader = ref<HTMLElement | null>(null)
const courseHeaderHeight = ref(0)
watch(
  courseHeader,
  (element, _previous, onCleanup) => {
    if (!element || !import.meta.client) return
    const updateHeight = () => {
      courseHeaderHeight.value = element.offsetHeight
    }
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  },
  { immediate: true, flush: 'post' },
)
function scrollToTop() {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  window.scrollTo({ top: 0, behavior: reducedMotion ? 'instant' : 'smooth' })
}

const queryClient = useQueryClient()
watch(taskId, () => {
  questionSection.value = null
  questionSelection.value = ''
  questionPanelOpen.value = false
  selectionError.value = ''
})
const startError = ref<string | null>(null)

const courseGeneration = useMutation({
  mutationFn: async () => {
    if (!taskId.value) throw new Error('Task ID is missing')
    const retryOfRunId = task.data.value?.course?.generationRunId
    return api.requestCourseGeneration(taskId.value, {
      ...(task.data.value?.course?.status === 'FAILED' && retryOfRunId ? { retryOfRunId } : {}),
    })
  },
  onSuccess: async () => {
    if (taskId.value)
      await queryClient.invalidateQueries({ queryKey: knowledgeOpsQueryKeys.task(taskId.value) })
  },
})

const start = useMutation({
  mutationFn: async (path: string | null) => {
    if (!taskId.value) throw new Error('Task ID is missing')
    return api.startTask(taskId.value, path ? { targetPath: path } : {})
  },
  onSuccess: async (started) => {
    const planId = task.data.value?.stage.plan.id
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: knowledgeOpsQueryKeys.task(started.taskId) }),
      queryClient.invalidateQueries({ queryKey: knowledgeOpsQueryKeys.todayTasks() }),
      ...(planId
        ? [queryClient.invalidateQueries({ queryKey: knowledgeOpsQueryKeys.plan(planId) })]
        : []),
    ])
  },
})

async function startCourse() {
  startError.value = null
  try {
    await start.mutateAsync(null)
  } catch (error: unknown) {
    startError.value = error instanceof Error ? error.message : '课程启动失败。'
  }
}

async function prepareCourse() {
  startError.value = null
  try {
    await courseGeneration.mutateAsync()
  } catch (error: unknown) {
    startError.value = error instanceof Error ? error.message : '课程生成请求失败。'
  }
}

const questionSection = ref<CourseSection | null>(null)
const questionSelection = ref('')
const questionPanelOpen = ref(false)
const selectionError = ref('')
const desktopQuestionPanel = ref(false)
let questionMedia: MediaQueryList | null = null
function updateQuestionMedia() {
  desktopQuestionPanel.value = questionMedia?.matches ?? false
}
onMounted(() => {
  questionMedia = window.matchMedia('(min-width: 1024px)')
  updateQuestionMedia()
  questionMedia.addEventListener('change', updateQuestionMedia)
})
onBeforeUnmount(() => {
  questionMedia?.removeEventListener('change', updateQuestionMedia)
})
const questionPanelVisible = computed(
  () => courseTab.value === 'content' && (desktopQuestionPanel.value || questionPanelOpen.value),
)

function askAboutSection(section: CourseSection) {
  questionSection.value = section
  questionSelection.value = section.title
  selectionError.value = ''
  questionPanelOpen.value = true
}

function restoreCourseQuestion(input: AskCourseQuestionInput) {
  const section = task.data.value?.course?.sections?.find((item) => item.id === input.sectionId)
  if (!section) return
  questionSection.value = section
  questionSelection.value = input.selectedText
  questionPanelOpen.value = true
}

const { showMessage } = useGlobalMessage()
async function exerciseSettled() {
  const planId = task.data.value?.stage.plan.id
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: knowledgeOpsQueryKeys.task(taskId.value ?? '') }),
    queryClient.invalidateQueries({ queryKey: knowledgeOpsQueryKeys.todayTasks() }),
    ...(planId
      ? [queryClient.invalidateQueries({ queryKey: knowledgeOpsQueryKeys.plan(planId) })]
      : []),
  ])
  if (task.data.value?.state === 'PASSED') showMessage('当前课程已完成')
}

function captureCourseSelection(
  section: CourseSection,
  event: MouseEvent | KeyboardEvent | TouchEvent,
) {
  const selection = window.getSelection()
  const container = event.currentTarget as HTMLElement
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return
  const range = selection.getRangeAt(0)
  if (!container.contains(range.commonAncestorContainer)) return
  const selectedText = selection.toString().trim()
  if (selectedText.length < 2) return
  if (selectedText.length > 2_000) {
    selectionError.value = '一次最多选择 2000 个字符，请缩小选文范围。'
    return
  }
  questionSection.value = section
  questionSelection.value = selectedText
  selectionError.value = ''
  questionPanelOpen.value = true
}
</script>

<template>
  <div>
    <NuxtLink
      class="inline-flex min-h-11 items-center font-mono text-caption tracking-label text-link uppercase"
      to="/app/plan"
    >
      ← 返回学习计划
    </NuxtLink>

    <AsyncStatePanel
      v-if="task.isPaused.value && !task.data.value"
      class="mt-8"
      title="网络离线，任务同步已暂停"
      description="恢复网络后会重新读取任务及运行记录。"
      tone="warning"
    />
    <AsyncStatePanel
      v-else-if="task.isPending.value"
      class="mt-8"
      title="正在读取任务"
      description="任务状态与验收信息来自服务端。"
    />

    <AsyncStatePanel
      v-else-if="
        task.isError.value && (!task.data.value || !isTransientReadError(task.error.value))
      "
      class="mt-8"
      title="任务读取失败"
      :description="task.error.value?.message ?? '请检查网络后重试。'"
      tone="warning"
    >
      <template #actions>
        <button
          class="min-h-11 rounded-full border border-ink px-8 font-mono text-sm tracking-label uppercase"
          type="button"
          @click="task.refetch()"
        >
          重新读取
        </button>
      </template>
    </AsyncStatePanel>

    <article v-else-if="task.data.value" class="mt-5 text-reading">
      <p
        v-if="task.isPaused.value || task.isError.value"
        class="mb-5 border-l-2 border-warning pl-4 text-base text-body"
        role="status"
      >
        暂时无法更新任务，当前显示上次读取的内容。联网后会继续同步。
      </p>
      <div
        ref="courseHeader"
        :class="
          task.data.value.type === 'COURSE' && task.data.value.course?.status === 'READY'
            ? 'sticky top-0 z-20 bg-canvas'
            : ''
        "
      >
        <header class="flex flex-wrap items-start justify-between gap-4 py-4">
          <div class="min-w-0">
            <p class="text-base text-muted">{{ task.data.value.stage.title }}</p>
            <h1 class="mt-2 break-words text-2xl font-medium md:text-workspace-title">
              {{ task.data.value.title }}
            </h1>
          </div>
          <div class="flex items-center gap-3">
            <TaskStateLabel :state="task.data.value.state" />
            <button
              v-if="task.data.value.type === 'COURSE' && task.data.value.course?.status === 'READY'"
              class="action-button min-w-11 px-3"
              type="button"
              aria-label="返回页面顶部"
              title="返回页面顶部"
              @click="scrollToTop"
            >
              <svg
                class="size-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                aria-hidden="true"
              >
                <path d="m6 15 6-6 6 6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </div>
        </header>
        <div
          v-if="task.data.value.type === 'COURSE' && task.data.value.course?.status === 'READY'"
          class="flex gap-2 border-b border-hairline pb-3"
          role="tablist"
          aria-label="课程内容与练习"
        >
          <button
            v-for="item in courseTabs"
            :id="`course-tab-${item.id}`"
            :key="item.id"
            class="action-button aria-selected:border-ink aria-selected:bg-surface-elevated"
            type="button"
            role="tab"
            :aria-selected="courseTab === item.id"
            :aria-controls="`course-panel-${item.id}`"
            :tabindex="courseTab === item.id ? 0 : -1"
            @click="selectCourseTab(item.id)"
            @keydown="courseTabKey"
          >
            {{ item.label }}
          </button>
        </div>
      </div>
      <template v-if="task.data.value.type === 'COURSE'">
        <section
          class="my-6 border border-hairline-strong bg-surface-soft p-5"
          aria-label="课程准备状态"
        >
          <p class="text-body">{{ task.data.value.description }}</p>
          <p class="mt-3 text-base text-muted">预计 {{ task.data.value.estimatedMinutes }} 分钟</p>
          <section
            v-if="task.data.value.course?.status === 'GENERATING'"
            class="mt-5 border border-hairline bg-surface-soft p-6 md:p-8"
            aria-labelledby="course-generation-title"
          >
            <h2 id="course-generation-title" class="text-section-title font-medium">
              生成中<AnimatedEllipsis />
            </h2>
            <p class="mt-3 max-w-2xl text-reading text-body">
              课程讲解和练习会一起保存，完成后即可开始学习。
            </p>
            <div
              class="mt-6 h-1 overflow-hidden bg-hairline"
              role="progressbar"
              aria-label="课程正在生成，具体进度暂不可知"
            >
              <div class="course-generation-progress h-full w-1/3 bg-ink"></div>
            </div>
            <p class="mt-3 text-base text-muted" aria-hidden="true">
              已等待 {{ courseGenerationElapsed }}
            </p>
            <p class="sr-only" role="status">课程正在生成，完成后即可开始学习。</p>
          </section>
          <div v-else-if="task.data.value.course?.status !== 'READY'" class="mt-5">
            <p class="text-body">
              {{
                task.data.value.course?.status === 'FAILED'
                  ? '本次课程生成未完成，可以重试。'
                  : '开始学习前，先生成完整课程与练习。'
              }}
            </p>
            <button
              class="action-button mt-4 border-ink"
              :disabled="courseGeneration.isPending.value"
              @click="prepareCourse"
            >
              {{
                courseGeneration.isPending.value
                  ? '正在提交…'
                  : task.data.value.course?.status === 'FAILED'
                    ? '重新生成课程'
                    : '生成课程'
              }}
            </button>
          </div>
          <p v-if="startError" class="mt-3 text-warning" role="alert">{{ startError }}</p>
        </section>
        <template v-if="task.data.value.course?.status === 'READY'">
          <div v-if="task.data.value.state === 'READY'" class="my-6">
            <button
              class="action-button border-ink"
              :disabled="start.isPending.value"
              @click="startCourse"
            >
              {{ start.isPending.value ? '启动中…' : '开始学习' }}
            </button>
          </div>
          <div v-if="task.data.value.course.sections">
            <div
              v-show="courseTab === 'content'"
              id="course-panel-content"
              role="tabpanel"
              aria-labelledby="course-tab-content"
              tabindex="0"
              class="mt-6 focus-visible:outline-2 focus-visible:outline-link"
            >
              <p class="mb-5 text-base text-muted">选中一段原文即可提问；也可以就整节内容交流。</p>
              <p v-if="selectionError" class="mb-5 text-base text-warning" role="alert">
                {{ selectionError }}
              </p>
              <div
                class="relative mt-6 lg:mt-0 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-8"
              >
                <CourseToc
                  :key="`toc-${task.data.value.id}`"
                  :sections="task.data.value.course.sections"
                  :desktop-offset="courseHeaderHeight + 16"
                />
                <div class="mt-6 space-y-8 lg:mt-0">
                  <section
                    v-for="section in task.data.value.course.sections"
                    :id="`course-section-${section.id}`"
                    :key="section.id"
                    class="border-b border-hairline pb-8"
                    :style="{ scrollMarginTop: `${courseHeaderHeight + 16}px` }"
                    @mouseup="captureCourseSelection(section, $event)"
                    @keyup="captureCourseSelection(section, $event)"
                    @touchend="captureCourseSelection(section, $event)"
                  >
                    <h2 class="text-section-title font-medium">{{ section.title }}</h2>
                    <p class="mt-4 whitespace-pre-line text-body">{{ section.explanation }}</p>
                    <h3 class="mt-5 text-base font-medium text-ink">开发情景</h3>
                    <p class="mt-2 whitespace-pre-line text-body">{{ section.scenario }}</p>
                    <h3 class="mt-5 text-base font-medium text-ink">示例</h3>
                    <p class="mt-2 whitespace-pre-line text-body">{{ section.example }}</p>
                    <p class="mt-4 border-l-2 border-warning pl-4 text-base text-body">
                      易错点：{{ section.misconception }}
                    </p>
                    <button
                      class="action-button mt-4"
                      type="button"
                      @click="askAboutSection(section)"
                    >
                      就本节提问
                    </button>
                  </section>
                </div>
                <CourseQuestionPanel
                  :key="task.data.value.id"
                  :task-id="task.data.value.id"
                  :section="questionSection"
                  :selected-text="questionSelection"
                  :open="questionPanelOpen"
                  :visible="questionPanelVisible"
                  :desktop-offset="courseHeaderHeight + 16"
                  @open="questionPanelOpen = true"
                  @close="questionPanelOpen = false"
                  @restore="restoreCourseQuestion"
                />
              </div>
            </div>
            <div
              v-show="courseTab === 'exercise'"
              id="course-panel-exercise"
              role="tabpanel"
              aria-labelledby="course-tab-exercise"
              tabindex="0"
              class="mt-6 focus-visible:outline-2 focus-visible:outline-link"
            >
              <CourseExercisePanel
                v-if="task.data.value.course.exercises && task.data.value.state !== 'READY'"
                :task-id="task.data.value.id"
                :task-version="task.data.value.version"
                :visible="courseTab === 'exercise'"
                :exercises="task.data.value.course.exercises"
                @settled="exerciseSettled"
              />
              <p v-else class="text-base text-muted">开始课程后即可完成练习并查看验收报告。</p>
              <section
                v-if="task.data.value.state === 'PASSED'"
                class="mt-6 border-t border-hairline-strong pt-5"
                aria-label="课程完成"
              >
                <p class="text-section-title font-medium text-ink">当前课程已完成</p>
                <p class="mt-2 text-base text-muted">可以返回学习计划，继续下一门已解锁的课程。</p>
                <NuxtLink class="action-button mt-4 border-ink" to="/app/plan">
                  返回学习计划
                </NuxtLink>
              </section>
            </div>
          </div>
          <AsyncStatePanel
            v-else
            title="课程内容读取异常"
            description="已保存的课程内容未通过结构校验，请重新读取或联系管理员。"
            tone="warning"
          />
        </template>
      </template>
      <AsyncStatePanel
        v-else
        class="my-6"
        title="旧版笔记任务已停用"
        description="笔记验收前端已移除，历史数据仍保留；请返回学习计划继续课程。"
        tone="warning"
      >
        <template #actions>
          <NuxtLink class="action-button border-ink" to="/app/plan">返回学习计划</NuxtLink>
        </template>
      </AsyncStatePanel>
    </article>
  </div>
</template>

<style scoped>
.course-generation-progress {
  animation: course-generation-progress 1.8s ease-in-out infinite;
}

@keyframes course-generation-progress {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(300%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .course-generation-progress {
    width: 100%;
    opacity: 0.35;
    animation: none;
    transform: none;
  }
}
</style>
