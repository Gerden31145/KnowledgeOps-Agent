<script setup lang="ts">
import {
  createLearningGoalInputSchema,
  isPlanGenerationRunTerminalState,
  type LearningGoalInput,
  type PlanGenerationAcceptedResponse,
} from '@knowledgeops/contracts'
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'
import { definePageMeta, useHead, useRoute, useRouter } from '#imports'

import { useKnowledgeOpsApi } from '../../composables/use-knowledge-ops-api'
import { usePlanRunRecovery } from '../../composables/use-plan-run-recovery'
import { useModelCatalogQuery, usePlanQuery } from '../../composables/use-workspace-queries'
import { KnowledgeOpsApiError } from '../../lib/knowledge-ops-api'
import { knowledgeOpsQueryKeys } from '../../lib/query-keys'

definePageMeta({ layout: 'workspace' })
useHead({ title: '学习计划 · KnowledgeOps Agent' })

const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const api = useKnowledgeOpsApi()
const modelCatalog = useModelCatalogQuery()

const runId = computed(() => readQueryValue(route.query.run))
const persistedGoalId = computed(() => readQueryValue(route.query.goal))
const routePlanId = computed(() => readQueryValue(route.query.plan))
const generationRun = usePlanRunRecovery(runId)
const planId = computed(() => {
  const run = generationRun.data.value
  if (runId.value) return run?.status === 'SUCCEEDED' ? (run.plan?.id ?? null) : null
  return routePlanId.value
})
const plan = usePlanQuery(planId)
const syncLabel = computed(() => {
  switch (generationRun.mode.value) {
    case 'connecting':
      return '正在连接实时状态'
    case 'streaming':
      return '实时状态已连接'
    case 'polling':
      return '正在使用 HTTP 轮询同步'
    case 'stopped':
      return generationRun.error.value ? '状态同步已停止' : '运行已结束，已停止同步'
    default:
      return ''
  }
})

const form = reactive({
  title: '',
  currentLevel: '',
  deadline: '',
  weeklyMinutes: 600,
  modelId: '',
})
const fieldErrors = ref<Record<string, string>>({})
const submissionError = ref<string | null>(null)
const confirmationError = ref<string | null>(null)

watch(
  () => modelCatalog.data.value?.models,
  (models) => {
    if (!form.modelId && models?.[0]) form.modelId = models[0].id
  },
  { immediate: true },
)

const creation = useMutation({
  mutationFn: async (input: { goal: LearningGoalInput; modelId: string }) => {
    const goal = await api.createLearningGoal(input.goal)
    await router.replace({ query: { goal: goal.id } })

    const accepted = await acceptOrRecoverRun(goal.id, { modelId: input.modelId })
    return { accepted, goalId: goal.id }
  },
  onSuccess: async ({ accepted, goalId }) => {
    await router.replace({ query: { goal: goalId, run: accepted.generationRunId } })
  },
})

const generationRetry = useMutation({
  mutationFn: async (input: { goalId: string; retryOfRunId?: string }) =>
    acceptOrRecoverRun(input.goalId, {
      modelId: form.modelId,
      ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
    }),
  onSuccess: async (accepted) => {
    await router.replace({
      query: { goal: persistedGoalId.value, run: accepted.generationRunId },
    })
  },
})

const confirmation = useMutation({
  mutationFn: async () => {
    if (!planId.value) throw new Error('Plan is not available for confirmation')
    return api.confirmPlan(planId.value)
  },
  onSuccess: async (confirmed) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: knowledgeOpsQueryKeys.plan(confirmed.planId) }),
      queryClient.invalidateQueries({ queryKey: knowledgeOpsQueryKeys.todayTasks() }),
    ])
  },
})

const runIsActive = computed(() => {
  const status = generationRun.data.value?.status
  return status ? !isPlanGenerationRunTerminalState(status) : false
})

async function submitGoal() {
  fieldErrors.value = {}
  submissionError.value = null

  const parsed = createLearningGoalInputSchema(localToday()).safeParse({
    title: form.title,
    currentLevel: form.currentLevel,
    deadline: form.deadline,
    weeklyMinutes: form.weeklyMinutes,
  })

  if (!parsed.success) {
    fieldErrors.value = Object.fromEntries(
      parsed.error.issues.map((issue) => [String(issue.path[0] ?? 'form'), issue.message]),
    )
    return
  }

  if (!form.modelId) {
    fieldErrors.value = { modelId: '请选择一个可用模型' }
    return
  }

  try {
    await creation.mutateAsync({ goal: parsed.data, modelId: form.modelId })
  } catch (error: unknown) {
    submissionError.value = errorMessage(error)
  }
}

async function resumeGeneration(retryOfRunId?: string) {
  submissionError.value = null
  const goalId = persistedGoalId.value ?? generationRun.data.value?.goalId

  if (!goalId || !form.modelId) {
    submissionError.value = '缺少目标或模型信息，请返回表单重新创建。'
    return
  }

  try {
    await generationRetry.mutateAsync({
      goalId,
      ...(retryOfRunId ? { retryOfRunId } : {}),
    })
  } catch (error: unknown) {
    submissionError.value = errorMessage(error)
  }
}

async function confirmPlan() {
  confirmationError.value = null
  try {
    await confirmation.mutateAsync()
  } catch (error: unknown) {
    confirmationError.value = errorMessage(error)
  }
}

async function acceptOrRecoverRun(
  goalId: string,
  input: { modelId: string; retryOfRunId?: string },
): Promise<PlanGenerationAcceptedResponse> {
  try {
    return await api.startPlanGeneration(goalId, input)
  } catch (error: unknown) {
    const recoverableRunId = getConflictRunId(error)
    if (recoverableRunId) return { generationRunId: recoverableRunId, status: 'QUEUED' }
    throw error
  }
}

function getConflictRunId(error: unknown): string | null {
  if (!(error instanceof KnowledgeOpsApiError) || error.status !== 409) return null
  if (!error.details || typeof error.details !== 'object') return null
  const value = Reflect.get(error.details, 'generationRunId')
  return typeof value === 'string' ? value : null
}

function readQueryValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function localToday(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。'
}
</script>

<template>
  <div>
    <header class="mb-12 border-b border-hairline pb-8 md:mb-16">
      <p class="font-mono text-caption tracking-label text-muted uppercase">Workspace / Plan</p>
      <h1
        class="mt-5 max-w-4xl font-display text-display-sm font-normal tracking-display uppercase md:text-display-lg"
      >
        从目标到可执行计划
      </h1>
      <p class="mt-5 max-w-2xl leading-7 text-body">
        目标先持久化，生成任务在后台继续。运行 ID 保存在地址中，刷新页面不会丢失进度。
      </p>
    </header>

    <div
      v-if="runId && syncLabel"
      class="mb-8 border-l border-hairline-strong pl-4 text-sm leading-6 text-body"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <p>{{ syncLabel }}</p>
      <p v-if="generationRun.data.value && generationRun.error.value" class="mt-2 text-warning">
        {{ generationRun.error.value.message }} 已保留上次读取的进度；连接问题不代表生成失败。
      </p>
    </div>

    <section v-if="!runId && !routePlanId && !persistedGoalId" aria-labelledby="goal-form-title">
      <div class="grid gap-12 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <form class="space-y-8" novalidate @submit.prevent="submitGoal">
          <div>
            <p class="font-mono text-caption tracking-label text-muted uppercase">01 / Goal</p>
            <h2
              id="goal-form-title"
              class="mt-4 font-display text-3xl font-normal tracking-display uppercase"
            >
              定义学习目标
            </h2>
          </div>

          <label class="block">
            <span class="font-mono text-caption tracking-label text-muted uppercase">目标</span>
            <input
              v-model="form.title"
              class="mt-2 min-h-11 w-full border-0 border-b border-hairline-strong bg-transparent px-0 py-3 text-ink outline-none focus:border-ink"
              name="title"
              autocomplete="off"
              placeholder="例如：准备 9 月前端实习面试"
              :aria-invalid="Boolean(fieldErrors.title)"
              :aria-describedby="fieldErrors.title ? 'title-error' : undefined"
            />
            <span v-if="fieldErrors.title" id="title-error" class="mt-2 block text-sm text-warning">
              {{ fieldErrors.title }}
            </span>
          </label>

          <label class="block">
            <span class="font-mono text-caption tracking-label text-muted uppercase">当前基础</span>
            <textarea
              v-model="form.currentLevel"
              class="mt-2 min-h-28 w-full resize-y border-0 border-b border-hairline-strong bg-transparent px-0 py-3 text-ink outline-none focus:border-ink"
              name="currentLevel"
              placeholder="说明已经掌握和希望补足的内容"
              :aria-invalid="Boolean(fieldErrors.currentLevel)"
              :aria-describedby="fieldErrors.currentLevel ? 'level-error' : undefined"
            />
            <span
              v-if="fieldErrors.currentLevel"
              id="level-error"
              class="mt-2 block text-sm text-warning"
            >
              {{ fieldErrors.currentLevel }}
            </span>
          </label>

          <div class="grid gap-8 sm:grid-cols-2">
            <label class="block">
              <span class="font-mono text-caption tracking-label text-muted uppercase"
                >截止日期</span
              >
              <input
                v-model="form.deadline"
                class="mt-2 min-h-11 w-full border-0 border-b border-hairline-strong bg-transparent px-0 py-3 text-ink outline-none focus:border-ink"
                name="deadline"
                type="date"
                :aria-invalid="Boolean(fieldErrors.deadline)"
              />
              <span v-if="fieldErrors.deadline" class="mt-2 block text-sm text-warning">
                {{ fieldErrors.deadline }}
              </span>
            </label>

            <label class="block">
              <span class="font-mono text-caption tracking-label text-muted uppercase"
                >每周分钟</span
              >
              <input
                v-model.number="form.weeklyMinutes"
                class="mt-2 min-h-11 w-full border-0 border-b border-hairline-strong bg-transparent px-0 py-3 text-ink outline-none focus:border-ink"
                name="weeklyMinutes"
                type="number"
                min="60"
                max="2400"
                step="30"
                :aria-invalid="Boolean(fieldErrors.weeklyMinutes)"
              />
              <span v-if="fieldErrors.weeklyMinutes" class="mt-2 block text-sm text-warning">
                {{ fieldErrors.weeklyMinutes }}
              </span>
            </label>
          </div>

          <fieldset class="border-t border-hairline pt-8">
            <legend class="font-mono text-caption tracking-label text-muted uppercase">
              02 / Model
            </legend>
            <p class="mt-3 text-sm leading-6 text-muted">
              浏览器只接收服务端允许的模型 ID 与标签，不接触供应商密钥或真实连接配置。
            </p>
            <p v-if="modelCatalog.isPending.value" class="mt-5 text-body">正在读取模型目录…</p>
            <div v-else-if="modelCatalog.isError.value" class="mt-5 text-warning">
              模型目录加载失败，请检查 API 服务。
            </div>
            <div v-else class="mt-5 grid gap-3">
              <label
                v-for="model in modelCatalog.data.value?.models"
                :key="model.id"
                class="flex min-h-14 cursor-pointer items-center gap-4 border border-hairline px-4 py-3 has-checked:border-ink"
              >
                <input v-model="form.modelId" type="radio" name="modelId" :value="model.id" />
                <span>
                  <span class="block text-body-strong">{{ model.label }}</span>
                  <span
                    class="mt-1 block font-mono text-caption tracking-label text-muted uppercase"
                  >
                    {{ model.id }}
                  </span>
                </span>
              </label>
            </div>
            <span v-if="fieldErrors.modelId" class="mt-2 block text-sm text-warning">
              {{ fieldErrors.modelId }}
            </span>
          </fieldset>

          <p v-if="submissionError" class="border-l border-warning pl-4 text-warning" role="alert">
            {{ submissionError }}
          </p>

          <button
            class="min-h-11 rounded-full border border-ink px-8 font-mono text-sm tracking-label uppercase disabled:cursor-not-allowed disabled:border-muted-soft disabled:text-muted-soft"
            type="submit"
            :disabled="creation.isPending.value || modelCatalog.isPending.value"
          >
            {{ creation.isPending.value ? '正在提交' : '创建目标并生成计划' }}
          </button>
        </form>

        <aside class="border-t border-hairline pt-6 lg:border-t-0 lg:border-l lg:pl-8">
          <p class="font-mono text-caption tracking-label text-muted uppercase">Execution facts</p>
          <ol class="mt-6 space-y-6 text-sm leading-6 text-body">
            <li>01. 目标单独写入 PostgreSQL。</li>
            <li>02. API 返回运行 ID，不等待模型。</li>
            <li>03. Worker 只在完整校验后落库计划。</li>
            <li>04. 用户确认前，计划保持草稿。</li>
          </ol>
        </aside>
      </div>
    </section>

    <AsyncStatePanel
      v-else-if="persistedGoalId && !runId && !routePlanId"
      title="目标已保存"
      description="生成响应可能在网络中断时丢失。再次提交会恢复服务端已存在的运行，而不是创建并行运行。"
    >
      <template #actions>
        <button
          class="min-h-11 rounded-full border border-ink px-8 font-mono text-sm tracking-label uppercase disabled:border-muted-soft disabled:text-muted-soft"
          type="button"
          :disabled="generationRetry.isPending.value || !form.modelId"
          @click="resumeGeneration()"
        >
          恢复生成
        </button>
      </template>
    </AsyncStatePanel>

    <AsyncStatePanel
      v-else-if="runId && generationRun.isPending.value"
      title="正在恢复生成记录"
      description="页面正在从 PostgreSQL 读取运行快照；刷新不会重新创建模型任务。"
    />

    <AsyncStatePanel
      v-else-if="runId && generationRun.isError.value"
      :title="generationRun.mode.value === 'stopped' ? '无法访问该运行' : '暂时无法读取运行'"
      :description="generationRun.error.value?.message ?? '请检查网络或 API 服务后重试。'"
      tone="warning"
    >
      <template #actions>
        <button
          v-if="generationRun.canRefresh.value"
          class="min-h-11 rounded-full border border-ink px-8 font-mono text-sm tracking-label uppercase focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
          type="button"
          @click="generationRun.refetch()"
        >
          重新读取
        </button>
        <NuxtLink
          v-else
          class="inline-flex min-h-11 items-center rounded-full border border-ink px-8 font-mono text-sm tracking-label uppercase focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
          to="/app/plan"
        >
          返回表单
        </NuxtLink>
      </template>
    </AsyncStatePanel>

    <AsyncStatePanel
      v-else-if="runIsActive"
      :eyebrow="`Run / ${generationRun.data.value?.status ?? 'QUEUED'}`"
      title="后台正在生成计划"
      description="你可以离开或刷新此页面。队列与 Worker 会继续执行，页面只读取持久化状态。"
    >
      <template #actions>
        <button
          class="min-h-11 rounded-full border border-ink px-8 font-mono text-sm tracking-label uppercase focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
          type="button"
          @click="generationRun.refetch()"
        >
          立即刷新
        </button>
      </template>
    </AsyncStatePanel>

    <AsyncStatePanel
      v-else-if="generationRun.terminalFailure.value"
      :eyebrow="`Run / ${generationRun.terminalFailure.value.status}`"
      title="本次生成未完成"
      :description="generationRun.terminalFailure.value.message"
      tone="warning"
    >
      <template #actions>
        <button
          class="min-h-11 rounded-full border border-ink px-8 font-mono text-sm tracking-label uppercase disabled:border-muted-soft disabled:text-muted-soft"
          type="button"
          :disabled="generationRetry.isPending.value || !form.modelId"
          @click="resumeGeneration(runId ?? undefined)"
        >
          创建关联重试
        </button>
      </template>
    </AsyncStatePanel>

    <AsyncStatePanel
      v-else-if="generationRun.data.value?.status === 'SUCCEEDED' && !generationRun.data.value.plan"
      title="成功记录缺少计划"
      description="服务端返回了不一致状态；页面不会尝试展示半份计划。"
      tone="warning"
    />

    <AsyncStatePanel
      v-else-if="planId && plan.isPending.value"
      title="正在读取完整计划"
      description="只有生成运行成功且完整计划可读取后，预览才会出现。"
    />

    <AsyncStatePanel
      v-else-if="planId && plan.isError.value"
      title="计划读取失败"
      :description="plan.error.value?.message ?? '请稍后重试。'"
      tone="warning"
    >
      <template #actions>
        <button
          class="min-h-11 rounded-full border border-ink px-8 font-mono text-sm tracking-label uppercase"
          type="button"
          @click="plan.refetch()"
        >
          重新读取
        </button>
      </template>
    </AsyncStatePanel>

    <section v-else-if="plan.data.value">
      <p
        v-if="confirmationError"
        class="mb-8 border-l border-warning pl-4 text-warning"
        role="alert"
      >
        {{ confirmationError }}
      </p>
      <PlanPreview
        :plan="plan.data.value"
        :busy="confirmation.isPending.value"
        @confirm="confirmPlan"
      />
    </section>

    <AsyncStatePanel
      v-else
      title="还没有可展示的计划"
      description="从目标表单开始创建一份短期学习计划。"
    >
      <template #actions>
        <NuxtLink
          class="inline-flex min-h-11 items-center rounded-full border border-ink px-8 font-mono text-sm tracking-label uppercase"
          to="/app/plan"
        >
          返回表单
        </NuxtLink>
      </template>
    </AsyncStatePanel>
  </div>
</template>
