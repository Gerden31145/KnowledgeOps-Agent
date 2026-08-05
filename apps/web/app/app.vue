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
  <main class="page-shell">
    <section class="hero" aria-labelledby="page-title">
      <p class="eyebrow">KnowledgeOps Agent · Engineering Skeleton</p>
      <h1 id="page-title">用真实学习证据，完成可追溯的任务验收。</h1>
      <p class="summary">
        当前页面用于验证阶段 1 的工程边界。产品闭环会在后续计划日逐步接入，不使用 Mock
        冒充生产链路。
      </p>
    </section>

    <section aria-labelledby="process-boundaries">
      <h2 id="process-boundaries">三个独立进程</h2>
      <ul class="process-grid">
        <li v-for="process in processDescriptions" :key="process.name">
          <span>{{ process.name }}</span>
          <strong>{{ process.title }}</strong>
          <p>{{ process.responsibility }}</p>
        </li>
      </ul>
    </section>
  </main>
</template>
