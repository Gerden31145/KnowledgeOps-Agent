<script setup lang="ts">
import {
  createLearningGoalInputSchema,
  isPlanGenerationRunTerminalState,
  type LearningGoalInput,
  type PlanGenerationAcceptedResponse,
} from '@knowledgeops/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { definePageMeta, useHead, useRoute, useRouter, useState } from '#imports'

import { usePlanApi } from '../../composables/use-plan-api'
import { usePlanRunRecovery } from '../../composables/use-plan-run-recovery'
import { useModelCatalogQuery, usePlanQuery } from '../../composables/use-workspace-queries'
import { KnowledgeOpsApiError } from '../../lib/knowledge-ops-api'
import { knowledgeOpsQueryKeys } from '../../lib/query-keys'

import {
  useSessionUser,
  useWorkspaceSessionEpoch,
  useWorkspaceSessionStatus,
} from '../../composables/use-session-user'
import { goalDraftKey, goalDraftSchema } from '../../lib/workspace-entry'

// 由计划卡片负责定位，避免路由默认回顶覆盖 scrollIntoView。
definePageMeta({ layout: 'workspace', scrollToTop: false })
useHead({ title: '学习计划 · KnowledgeOps Agent' })

const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const api = usePlanApi()
const user = useSessionUser()
const sessionStatus = useWorkspaceSessionStatus()
const sessionEpoch = useWorkspaceSessionEpoch()
const sessionIssue = useState<string | null>('workspace-session-issue', () => null)
const modelCatalog = useModelCatalogQuery(() => Boolean(user.value))
const explicit = computed(() => Boolean(route.query.run || route.query.goal || route.query.plan))
const entry = useQuery({
  queryKey: computed(() => knowledgeOpsQueryKeys.workspaceEntry(sessionEpoch.value)),
  queryFn: ({ signal }) => api.getWorkspaceEntry(signal),
  enabled: computed(
    () =>
      !explicit.value &&
      (sessionStatus.value === 'pending' || sessionStatus.value === 'authenticated'),
  ),
  retry: false,
  staleTime: 0,
})
const recovered = computed(() =>
  !explicit.value && sessionStatus.value === 'authenticated' && user.value
    ? entry.data.value
    : undefined,
)
const sessionResolving = computed(() => sessionStatus.value === 'pending' && Boolean(user.value))
const resolving = computed(() => Boolean(user.value) && !explicit.value && entry.isPending.value)
const entryError = computed(() => !explicit.value && user.value && entry.isError.value)
const draftRestored = ref(false)
const storageIssue = ref('')

const runId = computed(() => readQueryValue(route.query.run) ?? recovered.value?.runId ?? null)
const persistedGoalId = computed(
  () => readQueryValue(route.query.goal) ?? recovered.value?.goal?.id ?? null,
)
const routePlanId = computed(
  () => readQueryValue(route.query.plan) ?? recovered.value?.planId ?? null,
)
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
      return '正在更新生成进度'
    case 'streaming':
      return '生成进度自动更新中'
    case 'polling':
      return '连接恢复中，正在定时检查进度'
    case 'stopped':
      return generationRun.error.value ? '状态同步已停止' : '本次生成已结束'
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

const showingForm = computed(() => !runId.value && !routePlanId.value && !persistedGoalId.value)
const canShowForm = computed(
  () =>
    showingForm.value &&
    !sessionResolving.value &&
    !resolving.value &&
    !entryError.value &&
    !sessionIssue.value,
)
let draftReady = false
onMounted(() => {
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  try {
    const raw = sessionStorage.getItem(goalDraftKey)
    if (raw) {
      const saved = goalDraftSchema.parse(JSON.parse(raw))
      if (
        (!saved.ownerId || saved.ownerId === user.value?.id) &&
        saved.savedAt <= Date.now() &&
        Date.now() - saved.savedAt < 86_400_000
      ) {
        Object.assign(form, saved.form)
        draftRestored.value = true
        sessionStorage.setItem(
          goalDraftKey,
          JSON.stringify({ ...saved, ownerId: user.value?.id ?? null }),
        )
      } else sessionStorage.removeItem(goalDraftKey)
    }
  } catch {
    storageIssue.value = '无法恢复本地填写内容，请检查浏览器存储设置。'
  }
  draftReady = true
})
watch(
  form,
  () => {
    if (!draftReady || !canShowForm.value) return
    try {
      sessionStorage.setItem(
        goalDraftKey,
        JSON.stringify({ ownerId: user.value?.id ?? null, savedAt: Date.now(), form: { ...form } }),
      )
      storageIssue.value = ''
    } catch {
      storageIssue.value = '浏览器无法保存填写内容，请允许本站使用会话存储后再登录。'
    }
  },
  { deep: true },
)
watch(
  recovered,
  (value) => {
    if (value?.modelId) form.modelId = value.modelId
  },
  { immediate: true },
)

watch(
  () => modelCatalog.data.value?.models,
  (models) => {
    if (!form.modelId && models?.[0]) form.modelId = models[0].id
  },
  { immediate: true },
)

const creation = useMutation({
  mutationFn: async (input: { goal: LearningGoalInput; modelId: string }) => {
    const current = await api.getWorkspaceEntry()
    if (current.planId || current.runId || current.goal) {
      queryClient.setQueryData(knowledgeOpsQueryKeys.workspaceEntry(sessionEpoch.value), current)
      throw new Error('已找到你保存的学习进度，请先继续已有计划。')
    }
    const goal = await api.createLearningGoal(input.goal)
    await router.replace({ query: { goal: goal.id } })
    try {
      sessionStorage.removeItem(goalDraftKey)
      draftRestored.value = false
    } catch {
      /* 服务端目标已经保存 */
    }

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
  if (!user.value) {
    if (storageIssue.value) return
    try {
      sessionStorage.setItem(
        goalDraftKey,
        JSON.stringify({ ownerId: null, savedAt: Date.now(), form: { ...form } }),
      )
      await router.push({ path: '/login', query: { next: '/app/plan' } })
    } catch {
      storageIssue.value = '请允许本站使用会话存储，避免登录时丢失填写内容。'
    }
    return
  }
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
    submissionError.value = '请选择一个可用模型后重试。'
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
    <header v-if="!plan.data.value" class="mb-8">
      <h1 class="text-2xl font-medium leading-snug md:text-workspace-title">
        {{ canShowForm ? '想学些什么？' : '学习计划' }}
      </h1>
      <p v-if="canShowForm" class="mt-3 text-reading text-body">
        我们将根据你的学习目标和实际情况，生成定制化的个人学习路线
      </p>
    </header>
    <p v-if="storageIssue" class="mb-5 text-warning" role="alert">{{ storageIssue }}</p>
    <p
      v-if="draftRestored"
      class="mb-5 border-l-2 border-hairline-strong pl-4 text-body"
      role="status"
    >
      {{
        showingForm
          ? '已恢复你填写的内容，请确认后生成计划。'
          : '已恢复账号原有进度。刚才填写的新目标尚未生成，内容仍保留在本标签页。'
      }}
    </p>
    <p v-if="submissionError" class="mb-5 text-warning" role="alert">{{ submissionError }}</p>
    <AsyncStatePanel
      v-if="sessionIssue"
      title="暂时无法确认登录状态"
      :description="sessionIssue"
      tone="warning"
    >
      <template #actions
        ><button class="action-button" @click="router.go(0)">重新读取</button></template
      >
    </AsyncStatePanel>
    <AsyncStatePanel
      v-else-if="sessionResolving"
      title="正在确认登录状态"
      description="请稍候，确认后会恢复你保存的学习进度。"
    />
    <AsyncStatePanel
      v-else-if="resolving"
      title="正在找回学习进度"
      description="请稍候，正在读取你保存的计划。"
    />
    <AsyncStatePanel
      v-else-if="entryError"
      title="学习进度读取失败"
      description="请检查网络后重试，已有计划仍会保留。"
      tone="warning"
    >
      <template #actions
        ><button class="action-button" @click="entry.refetch()">重新读取</button></template
      >
    </AsyncStatePanel>
    <section v-else-if="canShowForm" aria-label="创建学习计划">
      <form class="space-y-7" novalidate @submit.prevent="submitGoal">
        <label class="block">
          <span class="text-lg font-medium">学习目标</span>
          <input
            v-model="form.title"
            aria-label="学习目标"
            maxlength="160"
            class="mt-3 min-h-12 w-full border border-hairline-strong bg-surface-soft p-3 text-reading focus-visible:outline-2 focus-visible:outline-link"
            placeholder="例如：用两周补齐 JavaScript 异步机制"
            :aria-invalid="Boolean(fieldErrors.title)"
            aria-describedby="goal-hint goal-error"
          />
          <span id="goal-hint" class="mt-2 block text-base text-muted"
            >选择一个具体、短期可完成的目标，例如一个知识主题或一项技能。</span
          >
          <span id="goal-error" class="block text-warning">{{ fieldErrors.title }}</span>
        </label>
        <label class="block">
          <span class="text-lg font-medium">当前基础</span>
          <textarea
            v-model="form.currentLevel"
            aria-label="当前基础"
            maxlength="500"
            rows="3"
            class="mt-3 w-full border border-hairline-strong bg-surface-soft p-3 text-reading focus-visible:outline-2 focus-visible:outline-link"
            placeholder="已经掌握什么？哪些地方还不熟悉？"
            :aria-invalid="Boolean(fieldErrors.currentLevel)"
            aria-describedby="level-error"
          />
          <span id="level-error" class="block text-warning">{{ fieldErrors.currentLevel }}</span>
        </label>
        <div class="grid gap-6 sm:grid-cols-2">
          <label class="block"
            ><span class="text-lg font-medium">截止日期</span>
            <input
              v-model="form.deadline"
              aria-label="截止日期"
              type="date"
              class="mt-3 min-h-12 w-full min-w-0 border border-hairline-strong bg-surface-soft p-3 text-base focus-visible:outline-2 focus-visible:outline-link"
              :aria-invalid="Boolean(fieldErrors.deadline)"
              aria-describedby="deadline-error"
            />
            <span id="deadline-error" class="block text-warning">{{ fieldErrors.deadline }}</span>
          </label>
          <label class="block"
            ><span class="text-lg font-medium">每周投入（分钟）</span>
            <input
              v-model.number="form.weeklyMinutes"
              aria-label="每周投入（分钟）"
              type="number"
              min="30"
              step="30"
              class="mt-3 min-h-12 w-full border border-hairline-strong bg-surface-soft p-3 text-base focus-visible:outline-2 focus-visible:outline-link"
              :aria-invalid="Boolean(fieldErrors.weeklyMinutes)"
              aria-describedby="minutes-error"
            />
            <span id="minutes-error" class="block text-warning">{{
              fieldErrors.weeklyMinutes
            }}</span>
          </label>
        </div>
        <p class="text-base text-muted">根据截止日期和每周可投入时间，安排适合你的任务量。</p>
        <fieldset v-if="user" class="border-t border-hairline pt-5">
          <legend class="text-lg">生成模型</legend>
          <p v-if="modelCatalog.isPending.value" class="mt-3 text-muted">正在读取可用模型…</p>
          <div v-else-if="modelCatalog.isError.value" class="mt-3">
            <p class="text-warning">可用模型读取失败。</p>
            <button type="button" class="action-button mt-3" @click="modelCatalog.refetch()">
              重试
            </button>
          </div>
          <div v-else class="mt-3 flex flex-wrap gap-3">
            <label
              v-for="model in modelCatalog.data.value?.models"
              :key="model.id"
              class="flex min-h-12 cursor-pointer items-center gap-3 border border-hairline-strong px-4 py-3 has-checked:border-ink"
            >
              <input v-model="form.modelId" type="radio" name="modelId" :value="model.id" /><span>{{
                model.label
              }}</span>
            </label>
          </div>
          <p class="mt-2 text-warning">{{ fieldErrors.modelId }}</p>
        </fieldset>
        <div class="border-t border-hairline pt-6 text-base text-body">
          <p>生成课程路线 → 学习课程内容 → 完成练习并获得针对性复习</p>
          <p class="mt-2 text-muted">课程直接在站内学习，不需要绑定仓库或提交笔记。</p>
          <p v-if="!user" class="mt-2">可以先填写学习目标，登录后生成并保存计划。</p>
          <button
            class="action-button mt-5 border-ink"
            type="submit"
            :disabled="
              creation.isPending.value ||
              Boolean(user && (modelCatalog.isPending.value || modelCatalog.isError.value)) ||
              Boolean(storageIssue)
            "
          >
            {{ !user ? '登录后生成' : creation.isPending.value ? '正在提交…' : '生成计划' }}
          </button>
        </div>
      </form>
    </section>
    <template v-else>
      <fieldset
        v-if="
          user &&
          (generationRun.terminalFailure.value || (persistedGoalId && !runId && !routePlanId))
        "
        class="mb-5"
      >
        <legend class="text-lg">重新生成使用的模型</legend>
        <label
          v-for="model in modelCatalog.data.value?.models"
          :key="model.id"
          class="mr-3 mt-3 inline-flex min-h-11 items-center gap-3 border border-hairline-strong px-4 py-2"
        >
          <input v-model="form.modelId" type="radio" name="retry-model" :value="model.id" />{{
            model.label
          }}
        </label>
        <p v-if="modelCatalog.isError.value" class="mt-3 text-warning">
          模型列表读取失败。<button class="action-button ml-2" @click="modelCatalog.refetch()">
            重试
          </button>
        </p>
        <p v-if="recovered?.goal" class="mt-3 text-body">学习目标：{{ recovered.goal.title }}</p>
      </fieldset>
      <p
        v-if="runId && syncLabel && !plan.data.value"
        class="mb-5 text-base text-muted"
        role="status"
      >
        {{ syncLabel }}
      </p>
      <p
        v-if="runId && generationRun.data.value && generationRun.error.value"
        class="mb-5 text-warning"
        role="status"
      >
        更新暂未完成，已保留上次读取的进度。
      </p>
      <AsyncStatePanel
        v-if="persistedGoalId && !runId && !routePlanId"
        title="目标已保存"
        description="可以继续生成，不必重新填写目标。"
      >
        <template #actions
          ><button
            class="action-button"
            :disabled="generationRetry.isPending.value || !form.modelId"
            @click="resumeGeneration()"
          >
            继续生成
          </button></template
        >
      </AsyncStatePanel>
      <AsyncStatePanel
        v-else-if="runId && generationRun.isPending.value"
        title="正在恢复生成进度"
        description="刷新不会重复生成计划。"
      />
      <AsyncStatePanel
        v-else-if="runId && generationRun.isError.value"
        title="暂时无法读取生成进度"
        :description="generationRun.error.value?.message ?? '请稍后重试。'"
        tone="warning"
      >
        <template #actions
          ><button
            v-if="generationRun.canRefresh.value"
            class="action-button"
            @click="generationRun.refetch()"
          >
            重新读取</button
          ><NuxtLink v-else class="action-button" to="/app/plan">返回学习计划</NuxtLink></template
        >
      </AsyncStatePanel>
      <AsyncStatePanel
        v-else-if="runIsActive"
        title="正在为你生成学习计划"
        description="你可以离开或刷新页面，回来后继续查看进度。"
      >
        <template #actions
          ><button class="action-button" @click="generationRun.refetch()">
            刷新进度
          </button></template
        >
      </AsyncStatePanel>
      <AsyncStatePanel
        v-else-if="generationRun.terminalFailure.value"
        title="本次生成未完成"
        :description="generationRun.terminalFailure.value.message"
        tone="warning"
      >
        <template #actions
          ><button
            class="action-button"
            :disabled="generationRetry.isPending.value || !form.modelId"
            @click="resumeGeneration(runId ?? undefined)"
          >
            重新生成
          </button></template
        >
      </AsyncStatePanel>
      <AsyncStatePanel
        v-else-if="planId && plan.isPending.value"
        title="正在读取计划"
        description="正在找回完整学习路线。"
      />
      <AsyncStatePanel
        v-else-if="planId && plan.isError.value"
        title="计划读取失败"
        description="请检查网络后重试。"
        tone="warning"
      >
        <template #actions
          ><button class="action-button" @click="plan.refetch()">重新读取</button></template
        >
      </AsyncStatePanel>
      <section v-else-if="plan.data.value">
        <p v-if="confirmationError" class="mb-5 text-warning" role="alert">
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
        title="暂时无法展示计划"
        description="请重新读取学习进度，不必重新创建目标。"
        tone="warning"
      />
    </template>
  </div>
</template>
