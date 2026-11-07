<script setup lang="ts">
import { markdownTargetPathSchema } from '@knowledgeops/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, ref, watch } from 'vue'
import { definePageMeta, useHead, useRoute, useRouter } from '#imports'

import { useKnowledgeOpsApi } from '../../../composables/use-knowledge-ops-api'
import { useTaskQuery } from '../../../composables/use-workspace-queries'
import { knowledgeOpsQueryKeys } from '../../../lib/query-keys'
import { useSessionUser } from '../../../composables/use-session-user'
import { isTransientReadError } from '../../../lib/verification-polling'

definePageMeta({ layout: 'workspace' })
useHead({ title: '任务详情 · KnowledgeOps Agent' })

const route = useRoute()
const api = useKnowledgeOpsApi()
const router = useRouter()
const user = useSessionUser()
const binding = useQuery({
  queryKey: computed(() => ['knowledgeops', 'repository-binding', user.value?.id]),
  queryFn: ({ signal }) => api.getRepositoryBinding(signal),
  retry: false,
  staleTime: 0,
})
const copied = ref('')
async function copyPath() {
  try {
    await navigator.clipboard.writeText(task.data.value?.targetPath ?? '')
    copied.value = '路径已复制'
  } catch {
    copied.value = '未能复制，请手动选择路径文字复制。'
  }
}
const tab = computed(() =>
  route.query.tab === 'instructions'
    ? 'instructions'
    : route.query.tab === 'feedback' || route.query.runId || route.hash === '#note-report'
      ? 'feedback'
      : 'instructions',
)
async function selectTab(value: 'instructions' | 'feedback') {
  await router.replace({ query: { ...route.query, tab: value }, hash: '' })
}
async function tabKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const next =
    event.key === 'Home'
      ? 'instructions'
      : event.key === 'End'
        ? 'feedback'
        : (event.currentTarget as HTMLElement).id === 'tab-instructions'
          ? 'feedback'
          : 'instructions'
  await selectTab(next)
  await nextTick()
  document.getElementById('tab-' + next)?.focus()
}
const pinnedRunId = ref<string | null>(null)
const queryClient = useQueryClient()
const taskId = computed(() => {
  const value = route.params.taskId
  return typeof value === 'string' ? value : null
})
const task = useTaskQuery(taskId)
const noteRuns = computed(
  () => task.data.value?.runs.filter((run) => run.kind === 'NOTE_VERIFICATION') ?? [],
)
const selectedRunId = computed(() => {
  if (task.data.value?.id !== taskId.value) return null
  const requested = route.query.runId
  if (requested === undefined) return pinnedRunId.value
  return typeof requested === 'string' && noteRuns.value.some((run) => run.id === requested)
    ? requested
    : null
})
watch(
  () => task.data.value,
  (value) => {
    if (value?.id === taskId.value && !pinnedRunId.value)
      pinnedRunId.value = value.runs.find((run) => run.kind === 'NOTE_VERIFICATION')?.id ?? null
  },
  { immediate: true },
)
watch(taskId, () => {
  pinnedRunId.value = null
  copied.value = ''
})
const newRunAvailable = computed(() =>
  Boolean(noteRuns.value[0] && selectedRunId.value !== noteRuns.value[0]?.id),
)
async function showLatest() {
  pinnedRunId.value = noteRuns.value[0]?.id ?? null
  await router.replace({
    query: {
      ...route.query,
      runId: undefined,
      answerId: undefined,
      answerRunId: undefined,
      tab: 'feedback',
    },
    hash: '',
  })
}
const targetPath = ref('')
const targetPathError = ref<string | null>(null)
const startError = ref<string | null>(null)

watch(
  () => task.data.value?.targetPath,
  (value) => {
    if (value && !targetPath.value) targetPath.value = value
  },
  { immediate: true },
)

const start = useMutation({
  mutationFn: async (path: string) => {
    if (!taskId.value) throw new Error('Task ID is missing')
    return api.startTask(taskId.value, { targetPath: path })
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

async function startTask() {
  targetPathError.value = null
  startError.value = null
  const parsed = markdownTargetPathSchema.safeParse(targetPath.value)

  if (!parsed.success) {
    targetPathError.value = '请输入仓库内的 Markdown 相对路径，例如 notes/event-loop.md。'
    return
  }

  try {
    await start.mutateAsync(parsed.data)
  } catch (error: unknown) {
    startError.value = error instanceof Error ? error.message : '任务启动失败。'
  }
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
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div class="min-w-0">
          <p class="text-base text-muted">{{ task.data.value.stage.title }}</p>
          <h1 class="mt-2 break-words text-2xl font-medium md:text-workspace-title">
            {{ task.data.value.title }}
          </h1>
        </div>
        <TaskStateLabel :state="task.data.value.state" />
      </header>
      <section
        class="my-6 border border-hairline-strong bg-surface-soft p-5"
        aria-label="笔记提交位置"
      >
        <div
          v-if="task.data.value.state !== 'READY'"
          class="flex flex-wrap items-start justify-between gap-3"
        >
          <div class="min-w-0">
            <h2 class="text-section-title font-medium">待验收笔记路径</h2>
            <p class="mt-2 select-text break-all font-mono text-lg text-ink">
              {{ task.data.value.targetPath ?? '开始任务时确认笔记路径' }}
            </p>
          </div>
          <button
            v-if="task.data.value.targetPath"
            class="action-button shrink-0"
            @click="copyPath"
          >
            复制路径
          </button>
        </div>
        <form
          v-if="task.data.value.state === 'READY'"
          class="mt-4"
          novalidate
          @submit.prevent="startTask"
        >
          <label class="block">
            <span class="text-base text-muted"> 待验收笔记路径 </span>
            <input
              v-model="targetPath"
              class="mt-2 min-h-11 w-full border-0 border-b border-hairline-strong bg-transparent px-0 py-3 text-ink outline-none focus:border-ink"
              placeholder="notes/topic.md"
              :aria-invalid="Boolean(targetPathError)"
            />
          </label>
          <p v-if="targetPathError" class="mt-3 text-sm text-warning" role="alert">
            {{ targetPathError }}
          </p>
          <p v-if="startError" class="mt-3 text-sm text-warning" role="alert">
            {{ startError }}
          </p>
          <button
            class="action-button mt-4 border-ink"
            type="submit"
            :disabled="start.isPending.value"
          >
            {{ start.isPending.value ? '启动中' : '开始任务' }}
          </button>
        </form>
        <p v-if="copied" class="mt-2 text-base" role="status">{{ copied }}</p>
        <p v-if="binding.isPending.value" class="mt-3 text-base text-muted">正在读取绑定仓库…</p>
        <div v-else-if="binding.isError.value" class="mt-3 text-base">
          <p class="text-warning">暂时无法读取绑定仓库，请核对后再提交。</p>
          <button class="action-button mt-2" @click="binding.refetch()">重试</button>
        </div>
        <template v-else-if="binding.data.value?.repository">
          <p class="mt-3 break-all text-base text-body">
            仓库：{{ binding.data.value.repository.fullName }} · 分支：{{
              binding.data.value.repository.branch
            }}
          </p>
          <p class="mt-2 text-base text-body">
            请在绑定仓库的此路径创建或更新 Markdown 笔记，提交并推送到绑定分支后，系统会自动验收。
          </p>
          <p
            v-if="
              task.data.value.state === 'BLOCKED' ||
              task.data.value.state === 'READY' ||
              task.data.value.state === 'PASSED'
            "
            class="mt-2 text-base text-muted"
          >
            {{
              task.data.value.state === 'PASSED'
                ? '此任务已通过，无需再次提交。'
                : '请先完成前置要求并开始任务，再提交笔记。'
            }}
          </p>
        </template>
        <div v-else class="mt-3 text-base">
          <p class="text-body">尚未绑定仓库，绑定后才能接收笔记提交。</p>
          <NuxtLink class="action-button mt-3" to="/app/repository">绑定仓库</NuxtLink>
        </div>
      </section>
      <p v-if="newRunAvailable" class="mb-4 text-base text-body" role="status">
        有新的验收记录，当前查看的内容保持不变。<button
          class="action-button ml-2"
          @click="showLatest"
        >
          查看最新验收
        </button>
      </p>
      <p
        v-else-if="tab === 'instructions' && selectedRunId"
        class="mb-4 text-base text-muted"
        role="status"
      >
        已有验收记录，可切换到“验收与反馈”查看。
      </p>
      <div
        role="tablist"
        aria-label="任务内容"
        class="mb-6 flex gap-2 border-b border-hairline pb-3"
      >
        <button
          id="tab-instructions"
          class="action-button aria-selected:border-ink aria-selected:bg-surface-elevated"
          role="tab"
          :aria-selected="tab === 'instructions'"
          aria-controls="panel-instructions"
          :tabindex="tab === 'instructions' ? 0 : -1"
          @click="selectTab('instructions')"
          @keydown="tabKey"
        >
          任务说明
        </button>
        <button
          id="tab-feedback"
          class="action-button aria-selected:border-ink aria-selected:bg-surface-elevated"
          role="tab"
          :aria-selected="tab === 'feedback'"
          aria-controls="panel-feedback"
          :tabindex="tab === 'feedback' ? 0 : -1"
          @click="selectTab('feedback')"
          @keydown="tabKey"
        >
          验收与反馈
        </button>
      </div>
      <div
        v-show="tab === 'instructions'"
        id="panel-instructions"
        role="tabpanel"
        aria-labelledby="tab-instructions"
        tabindex="0"
        class="space-y-7 focus-visible:outline-2 focus-visible:outline-link"
      >
        <p class="text-body">{{ task.data.value.description }}</p>
        <p class="text-base text-muted">
          预计 {{ task.data.value.estimatedMinutes }} 分钟 ·
          {{ task.data.value.prerequisiteTaskIds.length }} 项前置任务
        </p>
        <section aria-labelledby="steps-title">
          <h2 id="steps-title" class="text-section-title font-medium">建议步骤</h2>
          <ol class="mt-6 border-t border-hairline">
            <li
              v-for="(step, index) in task.data.value.suggestedSteps"
              :key="step"
              class="grid grid-cols-[3rem_1fr] gap-4 border-b border-hairline py-5 text-body"
            >
              <span class="text-base text-muted">
                {{ String(index + 1).padStart(2, '0') }}
              </span>
              <span>{{ step }}</span>
            </li>
          </ol>
        </section>

        <section aria-labelledby="criteria-title">
          <h2 id="criteria-title" class="text-section-title font-medium">验收标准</h2>
          <ul class="mt-6 border-t border-hairline">
            <li
              v-for="criterion in task.data.value.criteria"
              :key="criterion.id"
              class="border-b border-hairline py-5"
            >
              <p class="text-base text-muted">
                {{ criterion.type }} · {{ criterion.required ? '必需' : '可选' }}
              </p>
              <p class="mt-3 leading-7 text-body">{{ criterion.description }}</p>
              <p
                v-if="criterion.parameterDescription"
                class="mt-2 text-base leading-7 text-body-strong [overflow-wrap:anywhere]"
              >
                {{ criterion.parameterDescription }}
              </p>
            </li>
          </ul>
        </section>
      </div>
      <div
        v-show="tab === 'feedback'"
        id="panel-feedback"
        role="tabpanel"
        aria-labelledby="tab-feedback"
        tabindex="0"
        class="space-y-6 focus-visible:outline-2 focus-visible:outline-link"
      >
        <details class="border-b border-hairline pb-4">
          <summary
            class="min-h-11 cursor-pointer py-3 text-base focus-visible:outline-2 focus-visible:outline-link"
          >
            选择历史验收（{{ noteRuns.length }}）
          </summary>
          <section aria-labelledby="runs-title">
            <div class="flex flex-wrap items-center justify-between gap-4">
              <h2 id="runs-title" class="text-section-title font-medium">历次运行</h2>
              <button
                type="button"
                class="action-button text-base text-link disabled:text-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
                :disabled="task.isFetching.value || task.isPaused.value"
                @click="task.refetch()"
              >
                更新运行记录
              </button>
            </div>
            <button
              v-if="!newRunAvailable && route.query.runId"
              class="action-button mt-3"
              @click="showLatest"
            >
              查看最新验收
            </button>
            <p v-if="task.data.value.runs.length === 0" class="mt-6 text-muted">
              尚未产生验收运行。将目标笔记推送到绑定仓库后，可在这里查看记录。
            </p>
            <ul v-else class="mt-6 border-t border-hairline">
              <li
                v-for="run in task.data.value.runs"
                :key="run.id"
                class="flex flex-wrap justify-between gap-4 border-b border-hairline py-5"
              >
                <NuxtLink
                  v-if="run.kind === 'NOTE_VERIFICATION'"
                  class="action-button text-link aria-[current=true]:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
                  :to="{
                    path: route.path,
                    query: {
                      ...route.query,
                      runId: run.id,
                      tab: 'feedback',
                      answerId: undefined,
                      answerRunId: undefined,
                    },
                    hash: '#note-report',
                  }"
                  :aria-current="selectedRunId === run.id ? 'true' : undefined"
                  >笔记验收 · {{ new Date(run.queuedAt).toLocaleString('zh-CN')
                  }}<span v-if="selectedRunId === run.id"> · 当前查看</span></NuxtLink
                >
                <span v-else class="inline-flex min-h-11 items-center text-sm text-muted"
                  >回答验收 · {{ new Date(run.queuedAt).toLocaleString('zh-CN') }}</span
                >
                <span class="text-base text-muted">{{ run.status }}</span>
              </li>
            </ul>
          </section>
        </details>
        <NoteVerificationPanel
          v-if="selectedRunId && taskId"
          :key="`${taskId}:${selectedRunId}`"
          :task-id="taskId"
          :run-id="selectedRunId"
          :criteria="task.data.value.criteria"
          :task="task.data.value"
        />
        <AsyncStatePanel
          v-else-if="route.query.runId !== undefined"
          title="无法选择此笔记运行"
          description="这条运行不在当前任务的笔记验收列表中，请从上方记录重新选择。"
          tone="warning"
        />

        <p v-if="!selectedRunId && route.query.runId === undefined" class="text-body">
          尚未收到笔记验收结果。开始任务后，将笔记推送到上方仓库和路径。
        </p>
      </div>
    </article>
  </div>
</template>
