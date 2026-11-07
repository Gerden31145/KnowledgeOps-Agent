<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  CURRENT_TASK_STATES,
  type PlanDetailResponse,
  type PlanTaskSummary,
} from '@knowledgeops/contracts'
const props = defineProps<{ busy?: boolean; plan: PlanDetailResponse }>()
defineEmits<{ confirm: [] }>()
const root = ref<HTMLElement | null>(null)
const entries = computed(() =>
  props.plan.stages.flatMap((stage) =>
    stage.tasks.map((task, index) => ({ task, stage, startsStage: index === 0 })),
  ),
)
const tasks = computed(() => entries.value.map(({ task }) => task))
const completed = computed(() => tasks.value.filter((task) => task.state === 'PASSED').length)
const currentTaskId = computed(() =>
  props.plan.status === 'ACTIVE'
    ? (tasks.value.find((task) => CURRENT_TASK_STATES.some((state) => state === task.state))?.id ?? null)
    : null,
)
const expandedTasks = ref(new Set<string>())
function isExpanded(task: PlanTaskSummary) {
  return task.id === currentTaskId.value || expandedTasks.value.has(task.id)
}
function toggleDescription(task: PlanTaskSummary) {
  if (task.id === currentTaskId.value) return
  if (expandedTasks.value.has(task.id)) expandedTasks.value.delete(task.id)
  else expandedTasks.value.add(task.id)
}
watch(() => props.plan.id, () => expandedTasks.value.clear())

// 每次进入计划只定位一次；轮询刷新不抢走用户的阅读位置。
let scrolledPlanId: string | null = null
watch(
  [root, () => props.plan.id, currentTaskId],
  async ([element, planId, taskId], _previous, onCleanup) => {
    if (!element || scrolledPlanId === planId) return
    if (!taskId) {
      scrolledPlanId = planId
      return
    }
    let cancelled = false
    let frame = 0
    onCleanup(() => {
      cancelled = true
      cancelAnimationFrame(frame)
    })
    await nextTick()
    if (cancelled) return
    frame = requestAnimationFrame(() => {
      const card = element.querySelector<HTMLElement>(`[id="plan-task-${taskId}"]`)
      if (cancelled || !card) return
      scrolledPlanId = planId
      card.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
        block: 'start',
      })
    })
  },
  { flush: 'post' },
)
function taskLink(task: PlanTaskSummary) {
  return {
    path: '/app/tasks/' + task.id,
    query: ['NEEDS_EVIDENCE', 'NEEDS_REVISION', 'VERIFYING'].includes(task.state)
      ? { tab: 'feedback' }
      : {},
  }
}
function action(task: PlanTaskSummary) {
  switch (task.state) {
    case 'READY':
      return '查看任务'
    case 'NEEDS_EVIDENCE':
      return '查看反馈与追问'
    case 'NEEDS_REVISION':
      return '查看修改建议'
    case 'VERIFYING':
      return '查看验收进度'
    case 'IN_PROGRESS':
      return '继续学习'
    default:
      return '查看任务详情'
  }
}
</script>
<template>
  <section ref="root" aria-labelledby="plan-preview-title">
    <header class="border-b border-hairline pb-6">
      <p class="text-base text-muted">
        {{ plan.status === 'DRAFT' ? '计划预览 · 待确认' : '学习计划' }}
      </p>
      <h1
        id="plan-preview-title"
        class="mt-3 text-2xl font-medium leading-snug md:text-workspace-title"
      >
        {{ plan.goal.title }}
      </h1>
      <p class="mt-4 text-base text-body">
        截止 {{ plan.goal.deadline }} · 每周 {{ plan.goal.weeklyMinutes }} 分钟 · 已完成
        {{ completed }} / {{ tasks.length }} 个任务
      </p>
      <div v-if="plan.status === 'DRAFT'" class="mt-5">
        <p class="text-base text-muted">先查看各阶段的安排和验收标准，确认后即可开始学习。</p>
        <button class="action-button mt-4 border-ink" :disabled="busy" @click="$emit('confirm')">
          {{ busy ? '确认中…' : '确认并开始' }}
        </button>
      </div>
    </header>
    <h2 class="mt-8 text-section-title font-medium">完整学习路线</h2>
    <p v-if="tasks.length && completed === tasks.length" class="mt-3 text-base text-body">
      全部任务已通过，可以展开任务回顾学习成果。
    </p>
    <ol class="mt-2">
      <li v-for="({ task, stage, startsStage }, index) in entries" :key="task.id">
        <div
          v-if="startsStage"
          class="relative py-5 pl-11 sm:pl-16"
        >
          <span
            v-if="index > 0"
            aria-hidden="true"
            class="absolute inset-y-0 left-3 border-l border-hairline-strong"
          />
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h3 class="min-w-0 break-words text-xl font-medium">
              <span class="mr-3 text-muted">{{ String(stage.position + 1).padStart(2, '0') }}</span>
              {{ stage.title }}
            </h3>
            <span class="shrink-0 text-base text-muted">{{ stage.tasks.length }} 个任务</span>
          </div>
        </div>
        <div class="relative pl-11 sm:pl-16" :class="index < entries.length - 1 ? 'pb-5' : ''">
          <span
            v-if="entries.length > 1"
            aria-hidden="true"
            class="absolute left-3 border-l border-hairline-strong"
            :class="[
              index === 0 ? 'top-8' : 'top-0',
              index === entries.length - 1 ? 'h-8' : 'bottom-0',
            ]"
          />
          <span
            aria-hidden="true"
            class="absolute top-8 left-0 flex size-6 -translate-y-1/2 items-center justify-center rounded-full border bg-canvas"
            :class="task.state === 'PASSED' || task.id === currentTaskId ? 'border-ink' : 'border-muted'"
          >
            <svg v-if="task.state === 'PASSED'" class="size-4 text-ink" viewBox="0 0 20 20" fill="none">
              <path d="m5 10 3 3 7-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <article
            :id="`plan-task-${task.id}`"
            :aria-labelledby="`plan-task-title-${task.id}`"
            :aria-current="task.id === currentTaskId ? 'step' : undefined"
            class="scroll-mt-6 rounded-lg border p-4 transition-colors motion-reduce:transition-none sm:p-6"
            :class="task.id === currentTaskId ? 'border-muted bg-surface-elevated' : 'border-hairline-strong bg-surface-soft'"
          >
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <p v-if="task.id === currentTaskId" class="mb-2 text-base text-body">当前任务</p>
                <h4 :id="`plan-task-title-${task.id}`" class="break-words text-xl font-medium">{{ task.title }}</h4>
              </div>
              <div class="shrink-0"><TaskStateLabel :state="task.state" /></div>
            </div>
            <p class="mt-3 text-base text-muted">
              预计 {{ task.estimatedMinutes }} 分钟 ·
              {{ task.prerequisiteTaskIds.length }} 项前置任务
            </p>
            <p
              v-show="isExpanded(task)"
              :id="`plan-task-description-${task.id}`"
              class="mt-4 whitespace-pre-line break-words text-reading text-body"
            >{{ task.description }}</p>
            <p v-if="task.state === 'VERIFYING'" class="mt-3 text-base text-body">
              正在验收你的提交，结果会自动更新。
            </p>
            <div class="mt-5 flex flex-wrap gap-3">
              <button
                v-if="task.id !== currentTaskId"
                type="button"
                class="action-button"
                :aria-expanded="isExpanded(task)"
                :aria-controls="`plan-task-description-${task.id}`"
                @click="toggleDescription(task)"
              >{{ isExpanded(task) ? '收起描述' : '展开描述' }}</button>
              <NuxtLink
                v-if="plan.status !== 'DRAFT'"
                :to="taskLink(task)"
                class="action-button"
                :class="task.id === currentTaskId ? 'border-ink' : ''"
              >{{ action(task) }}</NuxtLink>
            </div>
            <details v-if="plan.status === 'DRAFT'" class="mt-3">
              <summary
                class="min-h-11 cursor-pointer py-3 text-base text-link focus-visible:outline-2 focus-visible:outline-link"
              >
                查看步骤与验收标准
              </summary>
              <div class="grid gap-6 py-3 text-reading sm:grid-cols-2">
                <div>
                  <h5 class="font-medium">建议步骤</h5>
                  <ol class="mt-3 list-decimal space-y-2 pl-5 text-body">
                    <li v-for="step in task.suggestedSteps" :key="step">{{ step }}</li>
                  </ol>
                </div>
                <div>
                  <h5 class="font-medium">验收标准</h5>
                  <ul class="mt-3 space-y-3 text-body">
                    <li v-for="criterion in task.criteria" :key="criterion.id">
                      {{ criterion.description
                      }}<span class="ml-2 text-base text-muted">{{
                        criterion.required ? '必需' : '可选'
                      }}</span>
                    </li>
                  </ul>
                </div>
              </div>
            </details>
          </article>
        </div>
      </li>
    </ol>
  </section>
</template>
