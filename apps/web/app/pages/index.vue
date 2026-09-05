<script setup lang="ts">
import { SERVICE_NAMES } from '@knowledgeops/contracts'

const processDescriptions = [
  {
    name: SERVICE_NAMES[0],
    title: 'Nuxt Web',
    responsibility: '公共页面与用户工作台',
  },
  {
    name: SERVICE_NAMES[1],
    title: 'NestJS API',
    responsibility: '短请求、校验与持久化入口',
  },
  {
    name: SERVICE_NAMES[2],
    title: 'Agent Worker',
    responsibility: '长任务与可重试工作流',
  },
]
</script>

<template>
  <main id="main-content" class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-10">
    <section
      class="flex min-h-[calc(100svh-3.5rem)] flex-col justify-end py-16 md:py-24 lg:py-section"
      aria-labelledby="page-title"
    >
      <div class="mb-10 flex items-center justify-between border-b border-hairline pb-3">
        <p class="font-mono text-caption tracking-label text-muted uppercase">
          Engineering Skeleton
        </p>
        <p class="font-mono text-caption tracking-label text-muted uppercase">P0 / Architecture</p>
      </div>

      <h1
        id="page-title"
        class="max-w-6xl font-display text-display-sm font-normal tracking-display uppercase md:text-display-lg xl:text-display-xl"
      >
        用真实学习证据，完成可追溯的任务验收。
      </h1>

      <p class="mt-10 max-w-2xl text-lg leading-8 text-body md:ml-auto md:text-xl md:leading-9">
        目标、异步计划生成与任务启动已经接入真实 API。模型运行失败会保留明确状态，不使用 Mock
        冒充生产结果。
      </p>

      <div class="mt-10 flex justify-end">
        <NuxtLink
          class="inline-flex min-h-11 items-center rounded-full border border-ink px-8 font-mono text-sm tracking-label uppercase focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
          to="/app/plan"
        >
          进入学习工作台
        </NuxtLink>
      </div>
    </section>

    <section class="py-16 md:py-24 lg:py-section" aria-labelledby="process-boundaries">
      <div class="mb-10 grid gap-6 md:grid-cols-2 md:items-end">
        <p class="font-mono text-caption tracking-label text-muted uppercase">
          System Map / 03 Nodes
        </p>
        <h2
          id="process-boundaries"
          class="font-display text-4xl font-normal tracking-display uppercase md:text-right md:text-5xl"
        >
          三个独立进程
        </h2>
      </div>

      <ol class="grid border-t border-l border-hairline lg:grid-cols-3">
        <li
          v-for="(process, index) in processDescriptions"
          :key="process.name"
          class="flex min-h-64 flex-col border-r border-b border-hairline bg-surface-soft p-6 md:p-8"
        >
          <div
            class="flex items-start justify-between font-mono text-caption tracking-label uppercase"
          >
            <span class="text-body-strong">{{ process.name }}</span>
            <span class="text-muted-soft">{{ String(index + 1).padStart(2, '0') }}</span>
          </div>
          <h3 class="mt-auto font-display text-3xl font-normal tracking-display uppercase">
            {{ process.title }}
          </h3>
          <p class="mt-4 border-t border-hairline pt-4 leading-6 text-muted">
            {{ process.responsibility }}
          </p>
        </li>
      </ol>
    </section>
  </main>
</template>
