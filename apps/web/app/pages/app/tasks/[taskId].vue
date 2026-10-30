<script setup lang="ts">
import { markdownTargetPathSchema } from '@knowledgeops/contracts'
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { definePageMeta, useHead, useRoute } from '#imports'

import { useKnowledgeOpsApi } from '../../../composables/use-knowledge-ops-api'
import { useTaskQuery } from '../../../composables/use-workspace-queries'
import { knowledgeOpsQueryKeys } from '../../../lib/query-keys'
import { isTransientReadError } from '../../../lib/verification-polling'

definePageMeta({ layout: 'workspace' })
useHead({ title: '任务详情 · KnowledgeOps Agent' })

const route = useRoute()
const api = useKnowledgeOpsApi()
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
  if (requested === undefined) return noteRuns.value[0]?.id ?? null
  return typeof requested === 'string' && noteRuns.value.some((run) => run.id === requested)
    ? requested
    : null
})
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
      to="/app/today"
    >
      ← 返回今日学习
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
      :description="task.error.value?.message ?? '请检查网络或 API 服务。'"
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

    <article v-else-if="task.data.value" class="mt-8">
      <p
        v-if="task.isPaused.value || task.isError.value"
        class="mb-8 border border-warning/60 bg-surface-soft p-6 leading-7 text-body"
        role="status"
      >
        {{
          task.isPaused.value
            ? '网络离线，任务同步已暂停。当前展示上次读取的内容，联网后会重新同步。'
            : '任务更新失败，当前展示上次读取的内容。可点击「更新运行记录」重试；后台验收不受影响。'
        }}
      </p>
      <header
        class="grid gap-8 border-b border-hairline pb-10 lg:grid-cols-[1fr_auto] lg:items-end"
      >
        <div>
          <p class="font-mono text-caption tracking-label text-muted uppercase">
            {{ task.data.value.stage.title }} / Task
          </p>
          <h1
            class="mt-5 max-w-4xl font-display text-display-sm font-normal tracking-display uppercase md:text-display-lg"
          >
            {{ task.data.value.title }}
          </h1>
          <p class="mt-5 max-w-3xl leading-7 text-body">{{ task.data.value.description }}</p>
        </div>
        <TaskStateLabel :state="task.data.value.state" />
      </header>

      <div class="grid gap-12 py-12 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div class="min-w-0 space-y-12">
          <section aria-labelledby="steps-title">
            <h2
              id="steps-title"
              class="font-display text-3xl font-normal tracking-display uppercase"
            >
              建议步骤
            </h2>
            <ol class="mt-6 border-t border-hairline">
              <li
                v-for="(step, index) in task.data.value.suggestedSteps"
                :key="step"
                class="grid grid-cols-[3rem_1fr] gap-4 border-b border-hairline py-5 text-body"
              >
                <span class="font-mono text-caption tracking-label text-muted uppercase">
                  {{ String(index + 1).padStart(2, '0') }}
                </span>
                <span>{{ step }}</span>
              </li>
            </ol>
          </section>

          <section aria-labelledby="criteria-title">
            <h2
              id="criteria-title"
              class="font-display text-3xl font-normal tracking-display uppercase"
            >
              验收标准
            </h2>
            <ul class="mt-6 border-t border-hairline">
              <li
                v-for="criterion in task.data.value.criteria"
                :key="criterion.id"
                class="border-b border-hairline py-5"
              >
                <p class="font-mono text-caption tracking-label text-muted uppercase">
                  {{ criterion.type }} · {{ criterion.required ? '必需' : '可选' }}
                </p>
                <p class="mt-3 leading-7 text-body">{{ criterion.description }}</p>
                <p
                  v-if="criterion.parameterDescription"
                  class="mt-2 text-sm leading-6 text-body-strong [overflow-wrap:anywhere]"
                >
                  {{ criterion.parameterDescription }}
                </p>
              </li>
            </ul>
          </section>

          <section aria-labelledby="runs-title">
            <div class="flex flex-wrap items-center justify-between gap-4">
              <h2
                id="runs-title"
                class="font-display text-3xl font-normal tracking-display uppercase"
              >
                历次运行
              </h2>
              <button
                type="button"
                class="min-h-11 px-3 text-sm text-link underline disabled:text-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
                :disabled="task.isFetching.value || task.isPaused.value"
                @click="task.refetch()"
              >
                更新运行记录
              </button>
            </div>
            <NuxtLink
              v-if="route.query.runId !== undefined"
              class="mt-3 inline-flex min-h-11 items-center text-sm text-link underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
              :to="{
                path: route.path,
                query: {
                  ...route.query,
                  runId: undefined,
                  answerId: undefined,
                  answerRunId: undefined,
                },
                hash: '#note-report',
              }"
              >跟随最新笔记运行</NuxtLink
            >
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
                  class="inline-flex min-h-11 items-center text-link underline underline-offset-4 aria-[current=true]:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
                  :to="{
                    path: route.path,
                    query: {
                      ...route.query,
                      runId: run.id,
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
                <span class="font-mono text-caption tracking-label uppercase">{{
                  run.status
                }}</span>
              </li>
            </ul>
          </section>

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
        </div>

        <aside class="border-t border-hairline pt-8 lg:border-t-0 lg:border-l lg:pl-8 lg:pt-0">
          <p class="font-mono text-caption tracking-label text-muted uppercase">Task setup</p>
          <dl class="mt-6 space-y-5 text-sm">
            <div>
              <dt class="text-muted">预计耗时</dt>
              <dd class="mt-1 text-body-strong">{{ task.data.value.estimatedMinutes }} 分钟</dd>
            </div>
            <div>
              <dt class="text-muted">前置任务</dt>
              <dd class="mt-1 text-body-strong">
                {{ task.data.value.prerequisiteTaskIds.length }} 项
              </dd>
            </div>
          </dl>

          <form
            v-if="task.data.value.state === 'READY'"
            class="mt-10 border-t border-hairline pt-8"
            novalidate
            @submit.prevent="startTask"
          >
            <label class="block">
              <span class="font-mono text-caption tracking-label text-muted uppercase">
                Markdown 目标路径
              </span>
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
              class="mt-6 min-h-11 w-full rounded-full border border-ink px-6 font-mono text-caption tracking-label uppercase disabled:border-muted-soft disabled:text-muted-soft"
              type="submit"
              :disabled="start.isPending.value"
            >
              {{ start.isPending.value ? '启动中' : '开始任务' }}
            </button>
          </form>

          <div v-else-if="task.data.value.targetPath" class="mt-10 border-t border-hairline pt-8">
            <p class="font-mono text-caption tracking-label text-muted uppercase">当前目标路径</p>
            <p class="mt-3 break-all text-body">{{ task.data.value.targetPath }}</p>
            <p class="mt-5 text-sm leading-6 text-muted">
              {{
                task.data.value.state === 'IN_PROGRESS'
                  ? '修改此文件并推送到绑定仓库后，系统会取证并自动验收。可在历次运行中查看报告。'
                  : '历次验收关联各次提交的笔记内容，当前仓库文件可能已经不同。'
              }}
            </p>
          </div>
        </aside>
      </div>
    </article>
  </div>
</template>
