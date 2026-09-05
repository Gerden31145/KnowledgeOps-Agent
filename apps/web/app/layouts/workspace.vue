<script setup lang="ts">
import { useHead } from '#imports'

useHead({
  meta: [{ name: 'robots', content: 'noindex,nofollow' }],
})

const navigation = [
  { label: '今日学习', to: '/app/today' },
  { label: '学习计划', to: '/app/plan' },
]
</script>

<template>
  <div class="min-h-screen bg-canvas text-ink">
    <a
      class="fixed top-3 left-3 z-50 -translate-y-24 rounded-full border border-ink bg-canvas px-6 py-3 font-mono text-caption tracking-label uppercase transition-transform focus:translate-y-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
      href="#workspace-content"
    >
      跳到主要内容
    </a>

    <header class="border-b border-hairline">
      <div
        class="mx-auto flex min-h-16 max-w-7xl flex-col justify-center gap-3 px-4 py-3 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-10"
      >
        <NuxtLink
          class="font-display text-sm font-normal tracking-display uppercase focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
          to="/"
        >
          KnowledgeOps
        </NuxtLink>
        <nav aria-label="工作台导航">
          <ul class="flex flex-wrap gap-2">
            <li v-for="item in navigation" :key="item.to">
              <NuxtLink
                class="inline-flex min-h-11 items-center rounded-full border border-transparent px-5 font-mono text-caption tracking-label text-muted uppercase aria-[current=page]:border-ink aria-[current=page]:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
                :to="item.to"
              >
                {{ item.label }}
              </NuxtLink>
            </li>
          </ul>
        </nav>
      </div>
    </header>

    <main
      id="workspace-content"
      class="mx-auto min-h-[calc(100svh-8rem)] max-w-7xl px-4 py-12 sm:px-6 md:py-16 lg:px-10"
    >
      <slot />
    </main>
  </div>
</template>
