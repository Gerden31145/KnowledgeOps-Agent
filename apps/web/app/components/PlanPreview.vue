<script setup lang="ts">
import type { PlanDetailResponse } from '@knowledgeops/contracts'

defineProps<{
  busy?: boolean
  plan: PlanDetailResponse
}>()

defineEmits<{
  confirm: []
}>()
</script>

<template>
  <section aria-labelledby="plan-preview-title">
    <div class="grid gap-8 border-b border-hairline pb-10 lg:grid-cols-[1fr_auto] lg:items-end">
      <div>
        <p class="font-mono text-caption tracking-label text-muted uppercase">
          Plan / Version {{ plan.version }}
        </p>
        <h2
          id="plan-preview-title"
          class="mt-5 font-display text-display-sm font-normal tracking-display uppercase md:text-display-lg"
        >
          {{ plan.goal.title }}
        </h2>
        <p class="mt-5 text-body">
          截止 {{ plan.goal.deadline }} · 每周 {{ plan.goal.weeklyMinutes }} 分钟 ·
          {{ plan.stages.length }} 个阶段
        </p>
      </div>

      <button
        v-if="plan.status === 'DRAFT'"
        class="min-h-11 rounded-full border border-ink px-8 font-mono text-sm tracking-label uppercase disabled:cursor-not-allowed disabled:border-muted-soft disabled:text-muted-soft"
        type="button"
        :disabled="busy"
        @click="$emit('confirm')"
      >
        {{ busy ? '确认中' : '确认并激活计划' }}
      </button>
      <NuxtLink
        v-else-if="plan.status === 'ACTIVE'"
        class="inline-flex min-h-11 items-center justify-center rounded-full border border-ink px-8 font-mono text-sm tracking-label uppercase"
        to="/app/today"
      >
        查看今日任务
      </NuxtLink>
    </div>

    <ol class="mt-12 space-y-16">
      <li v-for="stage in plan.stages" :key="stage.id">
        <div class="flex items-end justify-between gap-4 border-b border-hairline pb-4">
          <div>
            <p class="font-mono text-caption tracking-label text-muted uppercase">
              Stage {{ String(stage.position + 1).padStart(2, '0') }}
            </p>
            <h3 class="mt-3 font-display text-3xl font-normal tracking-display uppercase">
              {{ stage.title }}
            </h3>
          </div>
          <span class="font-mono text-caption tracking-label text-muted uppercase">
            {{ stage.tasks.length }} Tasks
          </span>
        </div>

        <ol class="border-l border-hairline">
          <li
            v-for="task in stage.tasks"
            :key="task.id"
            class="grid gap-6 border-r border-b border-hairline p-6 md:grid-cols-[4rem_1fr] md:p-8"
          >
            <span class="font-mono text-caption tracking-label text-muted-soft uppercase">
              {{ String(task.position + 1).padStart(2, '0') }}
            </span>
            <div class="min-w-0">
              <div class="flex flex-wrap items-start justify-between gap-4">
                <h4 class="font-display text-2xl font-normal tracking-display uppercase">
                  {{ task.title }}
                </h4>
                <TaskStateLabel :state="task.state" />
              </div>
              <p class="mt-4 max-w-3xl leading-7 text-body">{{ task.description }}</p>
              <dl
                class="mt-6 grid gap-3 border-t border-hairline pt-5 text-sm text-muted sm:grid-cols-3"
              >
                <div>
                  <dt class="font-mono text-caption tracking-label uppercase">预计耗时</dt>
                  <dd class="mt-2 text-body">{{ task.estimatedMinutes }} 分钟</dd>
                </div>
                <div>
                  <dt class="font-mono text-caption tracking-label uppercase">目标文件</dt>
                  <dd class="mt-2 break-all text-body">
                    {{ task.targetPath ?? '确认开始时选择' }}
                  </dd>
                </div>
                <div>
                  <dt class="font-mono text-caption tracking-label uppercase">前置任务</dt>
                  <dd class="mt-2 text-body">{{ task.prerequisiteTaskIds.length }} 项</dd>
                </div>
              </dl>
              <details class="mt-6 border-t border-hairline pt-5">
                <summary
                  class="min-h-11 cursor-pointer font-mono text-caption tracking-label text-link uppercase"
                >
                  查看步骤与验收标准
                </summary>
                <div class="grid gap-8 pb-2 pt-5 md:grid-cols-2">
                  <div>
                    <h5 class="font-mono text-caption tracking-label text-muted uppercase">
                      建议步骤
                    </h5>
                    <ol class="mt-4 list-decimal space-y-2 pl-5 text-body">
                      <li v-for="step in task.suggestedSteps" :key="step">{{ step }}</li>
                    </ol>
                  </div>
                  <div>
                    <h5 class="font-mono text-caption tracking-label text-muted uppercase">
                      验收标准
                    </h5>
                    <ul class="mt-4 space-y-3 text-body">
                      <li v-for="criterion in task.criteria" :key="criterion.id">
                        <span class="font-mono text-caption tracking-label text-muted uppercase">
                          {{ criterion.type }}{{ criterion.required ? ' / 必需' : ' / 可选' }}
                        </span>
                        <p class="mt-1">{{ criterion.description }}</p>
                        <p
                          v-if="criterion.parameterDescription"
                          class="mt-2 text-sm leading-6 text-body-strong [overflow-wrap:anywhere]"
                        >
                          {{ criterion.parameterDescription }}
                        </p>
                      </li>
                    </ul>
                  </div>
                </div>
              </details>
            </div>
          </li>
        </ol>
      </li>
    </ol>
  </section>
</template>
