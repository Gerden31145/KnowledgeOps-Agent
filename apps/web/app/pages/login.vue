<script setup lang="ts">
import { computed, ref } from 'vue'
import { useHead, useRoute, useRuntimeConfig } from '#imports'
import { apiUrl } from '../lib/knowledge-ops-api'
import { safeWorkspaceReturn, saveLoginReturn } from '../lib/workspace-entry'

useHead({ title: '登录 · KnowledgeOps', meta: [{ name: 'robots', content: 'noindex,nofollow' }] })
const route = useRoute()
const config = useRuntimeConfig()
const leaving = ref(false)
const returnIssue = ref('')
function beginLogin(event: MouseEvent) {
  try {
    if (route.query.next || !route.query.error)
      saveLoginReturn(window.sessionStorage, safeWorkspaceReturn(route.query.next))
    leaving.value = true
  } catch {
    event.preventDefault()
    returnIssue.value = '浏览器无法保存返回位置，请允许本站使用会话存储后重试。'
  }
}
const loginUrl = apiUrl(config.public.apiBaseUrl, '/auth/github/login').toString()
const errorMessages: Record<string, string> = {
  'invalid-state': '这次登录已过期或无法匹配发起浏览器，请重新登录。',
  'access-denied': '你未完成 GitHub 授权，可以在准备好后重新登录。',
  'github-unavailable': '暂时无法从 GitHub 确认身份，请稍后重新登录。',
  'session-unavailable': '暂时无法确认登录状态，请检查网络后重试。',
}
const errorMessage = computed(() =>
  typeof route.query.error === 'string'
    ? (errorMessages[route.query.error] ?? '登录未完成，请重新尝试。')
    : '',
)
</script>

<template>
  <main
    id="main-content"
    class="mx-auto flex min-h-[calc(100svh-14rem)] max-w-7xl flex-col justify-center px-4 py-16 sm:px-6 md:py-24 lg:px-10"
  >
    <p class="font-mono text-caption tracking-label text-muted uppercase">
      Your workspace / Sign in
    </p>
    <h1
      class="mt-6 font-display text-4xl font-normal tracking-display uppercase sm:text-display-sm md:text-display-lg"
    >
      用 GitHub 登录
    </h1>
    <p class="mt-6 max-w-2xl text-lg leading-8 text-body">
      登录后创建自己的学习计划，刷新页面仍可继续。当前登录仅确认身份，不代表已安装 App 或绑定仓库。
    </p>
    <p
      v-if="errorMessage"
      role="alert"
      class="mt-8 max-w-2xl border-l-2 border-warning pl-4 leading-7 text-warning"
    >
      {{ errorMessage }}
    </p>
    <div class="mt-10 flex flex-wrap items-center gap-4">
      <a
        :href="loginUrl"
        class="inline-flex min-h-11 items-center rounded-full border border-ink px-8 py-3 font-mono text-sm tracking-label focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
        @click="beginLogin"
        >{{ leaving ? '正在前往 GitHub…' : '继续使用 GitHub' }}</a
      >
      <NuxtLink
        v-if="route.query.error === 'session-unavailable'"
        to="/app/plan"
        class="inline-flex min-h-11 items-center px-4 text-link underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
        >重试会话读取</NuxtLink
      >
    </div>
    <p role="status" class="mt-4 min-h-6 text-muted">
      {{ returnIssue || (leaving ? '请在 GitHub 页面核对 App 并完成授权。' : '') }}
    </p>
  </main>
</template>
