<script setup lang="ts">
import { definePageMeta, useHead } from '#imports'

import { useTodayTasksQuery } from '../../composables/use-workspace-queries'

definePageMeta({ layout: 'workspace' })
useHead({ title: '今日学习 · KnowledgeOps Agent' })

const today = useTodayTasksQuery()
</script>

<template>
  <div>
    <header class="mb-12 border-b border-hairline pb-8 md:mb-16">
      <p class="font-mono text-caption tracking-label text-muted uppercase">Workspace / Today</p>
      <h1
        class="mt-5 font-display text-display-sm font-normal tracking-display uppercase md:text-display-lg"
      >
        今日学习
      </h1>
      <p class="mt-5 max-w-2xl leading-7 text-body">
        这里展示可开始、进行中、验收中、需要修订或等待回答的任务。
      </p>
    </header>

    <AsyncStatePanel
      v-if="today.isPending.value"
      title="正在读取今日任务"
      description="从当前活动计划读取任务及验收状态。"
    />

    <AsyncStatePanel
      v-else-if="today.isError.value"
      title="今日任务读取失败"
      :description="today.error.value?.message ?? '请检查网络或 API 服务。'"
      tone="warning"
    >
      <template #actions>
        <button
          class="min-h-11 rounded-full border border-ink px-8 font-mono text-sm tracking-label uppercase"
          type="button"
          @click="today.refetch()"
        >
          重新读取
        </button>
      </template>
    </AsyncStatePanel>

    <AsyncStatePanel
      v-else-if="!today.data.value?.plan"
      title="还没有活动计划"
      description="创建并确认计划后，根任务会解锁并出现在这里。"
    >
      <template #actions>
        <NuxtLink
          class="inline-flex min-h-11 items-center rounded-full border border-ink px-8 font-mono text-sm tracking-label uppercase"
          to="/app/plan"
        >
          创建学习计划
        </NuxtLink>
      </template>
    </AsyncStatePanel>

    <AsyncStatePanel
      v-else-if="today.data.value.tasks.length === 0"
      title="当前没有待处理任务"
      description="活动计划存在，但暂时没有可开始、进行中、验收中或需要反馈的任务。"
    />

    <section v-else aria-labelledby="today-list-title">
      <div class="flex items-end justify-between gap-6 border-b border-hairline pb-4">
        <h2
          id="today-list-title"
          class="font-display text-3xl font-normal tracking-display uppercase"
        >
          当前任务
        </h2>
        <span class="font-mono text-caption tracking-label text-muted uppercase">
          {{ today.data.value.tasks.length }} Items
        </span>
      </div>

      <ol class="border-l border-hairline">
        <li
          v-for="(task, index) in today.data.value.tasks"
          :key="task.id"
          class="grid gap-6 border-r border-b border-hairline p-6 md:grid-cols-[4rem_1fr_auto] md:items-center md:p-8"
        >
          <span class="font-mono text-caption tracking-label text-muted-soft uppercase">
            {{ String(index + 1).padStart(2, '0') }}
          </span>
          <div>
            <div class="flex flex-wrap items-center gap-4">
              <h3 class="font-display text-2xl font-normal tracking-display uppercase">
                {{ task.title }}
              </h3>
              <TaskStateLabel :state="task.state" />
            </div>
            <p class="mt-3 max-w-2xl leading-7 text-body">{{ task.description }}</p>
            <p class="mt-4 font-mono text-caption tracking-label text-muted uppercase">
              {{ task.stage.title }} · {{ task.estimatedMinutes }} 分钟
            </p>
          </div>
          <NuxtLink
            class="inline-flex min-h-11 items-center justify-center rounded-full border border-ink px-6 font-mono text-caption tracking-label uppercase"
            :to="`/app/tasks/${task.id}`"
          >
            查看任务
          </NuxtLink>
        </li>
      </ol>
    </section>
  </div>
</template>
