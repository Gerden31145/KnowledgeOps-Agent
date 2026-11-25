<script setup lang="ts">
import { useHead } from '#imports'
import { ref } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import { useSessionApi } from '../composables/use-session-api'
import { useSessionUser } from '../composables/use-session-user'
import { goalDraftKey } from '../lib/workspace-entry'

const user = useSessionUser()
const api = useSessionApi()
const queryClient = useQueryClient()
const loggingOut = ref(false)
const logoutError = ref('')

async function logout() {
  if (loggingOut.value) return
  loggingOut.value = true
  logoutError.value = ''
  try {
    await api.logout()
    try {
      window.sessionStorage.removeItem(goalDraftKey)
    } catch {
      /* 会话仍会退出 */
    }
    queryClient.clear()
    user.value = null
    window.location.assign('/login')
  } catch {
    logoutError.value = '退出未完成，请检查网络后重试。'
    loggingOut.value = false
  }
}

useHead({
  meta: [{ name: 'robots', content: 'noindex,nofollow' }],
})

const navigation = [{ label: '学习计划', to: '/app/plan' }]
</script>

<template>
  <div class="min-h-screen bg-canvas text-ink">
    <a
      class="fixed top-3 left-3 z-50 min-h-11 -translate-y-24 rounded-full border border-ink bg-canvas px-6 py-3 font-mono text-caption tracking-label uppercase transition-transform focus:translate-y-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
      href="#workspace-content"
    >
      跳到主要内容
    </a>

    <header class="border-b border-hairline">
      <div
        class="mx-auto flex min-h-16 max-w-7xl flex-col justify-center gap-3 px-4 py-3 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-10"
      >
        <NuxtLink
          class="inline-flex min-h-11 items-center font-display text-sm font-normal tracking-display uppercase focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
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
        <div class="flex flex-wrap items-center gap-3">
          <span class="max-w-48 truncate text-sm text-muted">{{ user?.githubLogin }}</span>
          <NuxtLink v-if="!user" class="action-button" to="/login">登录</NuxtLink>
          <button
            v-else
            type="button"
            :disabled="loggingOut"
            class="min-h-11 rounded-full border border-ink px-5 font-mono text-caption tracking-label disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
            @click="logout"
          >
            {{ loggingOut ? '正在退出…' : '退出登录' }}
          </button>
        </div>
      </div>
      <p
        v-if="logoutError"
        role="alert"
        class="mx-auto max-w-7xl px-4 pb-4 text-warning sm:px-6 lg:px-10"
      >
        {{ logoutError }}
      </p>
    </header>

    <main
      id="workspace-content"
      class="mx-auto min-h-[calc(100svh-8rem)] max-w-7xl px-4 py-8 sm:px-6 md:py-10 lg:px-10"
    >
      <slot />
    </main>
  </div>
</template>
