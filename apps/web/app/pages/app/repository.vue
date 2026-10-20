<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { definePageMeta, useHead, useRuntimeConfig } from '#imports'
import type { RepositoryBindingResponse } from '@knowledgeops/contracts'
import { useKnowledgeOpsApi } from '../../composables/use-knowledge-ops-api'
import { useSessionUser } from '../../composables/use-session-user'
import { apiUrl, KnowledgeOpsApiError } from '../../lib/knowledge-ops-api'
import RepositoryEvidenceStatus from '../../components/RepositoryEvidenceStatus.vue'

definePageMeta({ layout: 'workspace' })
useHead({ title: '仓库接入 · KnowledgeOps Agent' })
const api = useKnowledgeOpsApi()
const user = useSessionUser()
const client = useQueryClient()
const loginUrl = apiUrl(
  String(useRuntimeConfig().public.apiBaseUrl),
  '/auth/github/login',
).toString()
const bindingKey = computed(() => ['knowledgeops', 'repository-binding', user.value?.id])
const binding = useQuery({
  queryKey: bindingKey,
  queryFn: ({ signal }) => api.getRepositoryBinding(signal),
  staleTime: 0,
  retry: false,
})
const discover = ref(false)
const installationId = ref('')
const repositoryId = ref('')
const branch = ref('')
const consent = ref(false)
const confirmingUnbind = ref(false)
const message = ref('')
function startDiscovery() {
  discover.value = true
  message.value = ''
}
const installations = useQuery({
  queryKey: computed(() => ['knowledgeops', 'github-installations', user.value?.id]),
  queryFn: ({ signal }) => api.getGitHubInstallations(signal),
  enabled: computed(() => discover.value && !!binding.data.value && !binding.data.value.repository),
  staleTime: 0,
  retry: false,
})
watch(
  () => installations.data.value,
  (data) => {
    if (!data?.installations.some((item) => item.id === installationId.value))
      installationId.value = data?.installations[0]?.id ?? ''
  },
)
const options = useQuery({
  queryKey: computed(() => [
    'knowledgeops',
    'github-repositories',
    user.value?.id,
    installationId.value,
  ]),
  queryFn: ({ signal }) => api.getRepositoryOptions(installationId.value, signal),
  enabled: computed(
    () => discover.value && !!installationId.value && !binding.data.value?.repository,
  ),
  staleTime: 0,
  retry: false,
})
watch(
  installationId,
  () => {
    repositoryId.value = ''
    branch.value = ''
    consent.value = false
  },
  { flush: 'sync' },
)
watch(
  () => options.data.value,
  (data) => {
    repositoryId.value = data?.repositories[0]?.githubRepositoryId ?? ''
  },
)
watch(repositoryId, () => {
  branch.value = ''
  consent.value = false
})

async function saved(result: RepositoryBindingResponse) {
  // 取消旧快照读取再写缓存；不让 mutation 之前的响应覆盖已提交结果。
  await client.cancelQueries({ queryKey: bindingKey.value })
  client.setQueryData(bindingKey.value, result)
  discover.value = false
  confirmingUnbind.value = false
  consent.value = false
  message.value = result.repository
    ? '绑定已保存；刷新后仍可恢复。'
    : '已解除绑定；历史数据保留，GitHub App 未卸载。'
}
const bind = useMutation({
  mutationFn: () =>
    api.bindRepository({
      installationId: installationId.value,
      githubRepositoryId: repositoryId.value,
      expectedVersion: binding.data.value!.version,
      ...(branch.value.trim() ? { branch: branch.value.trim() } : {}),
    }),
  onSuccess: saved,
})
const unbind = useMutation({
  mutationFn: () =>
    api.unbindRepository({
      repositoryId: binding.data.value!.repository!.id,
      expectedVersion: binding.data.value!.version,
    }),
  onSuccess: saved,
})
const busy = computed(() => bind.isPending.value || unbind.isPending.value)
const selection = computed(() =>
  options.data.value?.repositories.find((item) => item.githubRepositoryId === repositoryId.value),
)
const error = computed(
  () =>
    binding.error.value ??
    bind.error.value ??
    unbind.error.value ??
    installations.error.value ??
    options.error.value,
)
const errorText = computed(() =>
  error.value instanceof KnowledgeOpsApiError
    ? error.value.message
    : error.value
      ? '请求未完成，请检查网络并刷新状态后重试。'
      : '',
)
const needsAuthorization = computed(() => {
  if (error.value instanceof KnowledgeOpsApiError && error.value.status === 401) return true
  const details = error.value instanceof KnowledgeOpsApiError ? error.value.details : null
  return (
    !!details &&
    typeof details === 'object' &&
    Reflect.get(details, 'reason') === 'GITHUB_AUTH_REQUIRED'
  )
})
async function refresh() {
  if (busy.value) return
  bind.reset()
  unbind.reset()
  message.value = ''
  await binding.refetch()
  if (discover.value) {
    await installations.refetch()
    if (installationId.value) await options.refetch()
  }
}
</script>

<template>
  <section class="max-w-3xl space-y-8" aria-labelledby="repository-heading">
    <header class="space-y-4">
      <p class="font-mono text-caption tracking-label text-muted uppercase">GitHub / Repository</p>
      <h1
        id="repository-heading"
        class="font-display text-3xl font-normal tracking-display sm:text-5xl"
      >
        仓库接入
      </h1>
      <p class="leading-7 text-body">
        一个账号只绑定一个活动仓库。安装授权决定可选范围，绑定决定本项目实际处理的仓库。
      </p>
    </header>
    <p v-if="binding.isPending.value" role="status" class="text-muted">正在读取已保存的绑定…</p>
    <div v-if="errorText" class="space-y-4 border-l border-warning pl-4">
      <p role="alert" class="text-warning">{{ errorText }}</p>
      <p v-if="needsAuthorization" class="text-body">
        重新核验后，从工作台导航返回“仓库接入”。这不会删除已有绑定。
      </p>
      <a
        v-if="needsAuthorization"
        :href="loginUrl"
        class="inline-flex min-h-11 items-center rounded-full border border-ink px-6 font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
        >通过 GitHub 重新核验</a
      >
    </div>
    <p v-if="message" role="status" class="text-body">{{ message }}</p>
    <template v-if="binding.data.value">
      <div v-if="binding.data.value.repository" class="space-y-5 border-y border-hairline py-6">
        <p class="font-mono text-caption tracking-label text-muted">当前已绑定</p>
        <h2 class="break-all font-display text-2xl font-normal">
          {{ binding.data.value.repository.fullName }}
        </h2>
        <p class="break-all text-body">
          分支：{{ binding.data.value.repository.branch }} ·
          {{ binding.data.value.repository.isPrivate ? '私有仓库' : '公开仓库' }}
        </p>
        <p class="text-muted">
          这里显示已保存的绑定，不代表 GitHub 当前权限仍然有效。本次绑定的 Push
          接收和取证结果见下方通知。
        </p>
        <button
          v-if="!confirmingUnbind"
          type="button"
          :disabled="busy"
          class="min-h-11 rounded-full border border-ink px-6 font-mono text-sm disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
          @click="confirmingUnbind = true"
        >
          解除绑定
        </button>
        <div v-else class="space-y-4">
          <p>
            确认解除？本项目将停用这条绑定；已有计划及历史数据不会删除，GitHub App 也不会被卸载。
          </p>
          <div class="flex flex-wrap gap-4">
            <button
              type="button"
              :disabled="busy"
              class="min-h-11 rounded-full border border-ink px-6 font-mono text-sm disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
              @click="unbind.mutate()"
            >
              {{ unbind.isPending.value ? '正在解除…' : '确认解除' }}
            </button>
            <button
              type="button"
              :disabled="busy"
              class="min-h-11 rounded-full border border-hairline-strong px-6 font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
              @click="confirmingUnbind = false"
            >
              取消
            </button>
          </div>
        </div>
      </div>
      <div v-else class="space-y-6 border-y border-hairline py-6">
        <p class="text-body">尚未绑定仓库。</p>
        <button
          v-if="!discover"
          type="button"
          class="min-h-11 rounded-full border border-ink px-6 font-mono text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
          @click="startDiscovery"
        >
          加载 GitHub 已授权仓库
        </button>
        <template v-else>
          <p
            v-if="installations.isFetching.value || options.isFetching.value"
            role="status"
            class="text-muted"
          >
            正在向 GitHub 核验授权…
          </p>
          <template v-if="installations.data.value">
            <a
              :href="installations.data.value.installUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex min-h-11 items-center text-link underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
              >安装 App / 管理仓库授权（新窗口）</a
            >
            <p v-if="installations.data.value.installations.length === 0" class="text-body">
              没有可用安装。请安装 App，选择 Only select repositories、Contents
              只读，并批准权限变更后刷新。
            </p>
            <form
              v-else
              class="space-y-6"
              @submit.prevent="
                !busy && consent && repositoryId && !options.isFetching.value && bind.mutate()
              "
            >
              <div class="space-y-2">
                <label for="installation" class="block text-body">安装账号</label>
                <select
                  id="installation"
                  v-model="installationId"
                  :disabled="busy"
                  class="min-h-11 w-full border-b border-hairline-strong bg-canvas py-3 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
                >
                  <option
                    v-for="item in installations.data.value.installations"
                    :key="item.id"
                    :value="item.id"
                  >
                    {{ item.accountLogin }}
                  </option>
                </select>
              </div>
              <div v-if="options.data.value?.repositories.length" class="space-y-2">
                <label for="repository" class="block text-body">授权仓库</label>
                <select
                  id="repository"
                  v-model="repositoryId"
                  :disabled="busy || options.isFetching.value"
                  class="min-h-11 w-full border-b border-hairline-strong bg-canvas py-3 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
                >
                  <option
                    v-for="repo in options.data.value.repositories"
                    :key="repo.githubRepositoryId"
                    :value="repo.githubRepositoryId"
                  >
                    {{ repo.fullName }}{{ repo.isPrivate ? '（私有）' : '' }}
                  </option>
                </select>
              </div>
              <p v-else-if="!options.isFetching.value && options.data.value" class="text-muted">
                该安装没有当前用户可选的仓库，请检查选定仓库与访问权限。
              </p>
              <template v-if="selection">
                <div class="space-y-2">
                  <label for="branch" class="block text-body"
                    >分支（留空使用默认分支 {{ selection.defaultBranch }}）</label
                  >
                  <input
                    id="branch"
                    v-model="branch"
                    maxlength="255"
                    :disabled="busy"
                    class="min-h-11 w-full border-b border-hairline-strong bg-transparent py-3 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
                  />
                </div>
                <label
                  class="flex min-h-11 cursor-pointer items-start gap-3 py-3 leading-7 text-body"
                >
                  <input
                    v-model="consent"
                    type="checkbox"
                    :disabled="busy"
                    class="mt-1.5 size-5 shrink-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
                  />
                  <span
                    >我了解：后续验收会读取所选仓库的任务目标文件，相关内容可能发送给配置的模型提供商。绑定信息、计划及后续报告当前不自动清理，尚无自助删除入口。解绑停用绑定，不删除历史数据。</span
                  >
                </label>
                <button
                  type="submit"
                  :disabled="busy || !consent || options.isFetching.value"
                  class="min-h-11 rounded-full border border-ink px-6 font-mono text-sm disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
                >
                  {{ bind.isPending.value ? '正在核验并绑定…' : '绑定这个仓库' }}
                </button>
              </template>
            </form>
          </template>
        </template>
      </div>
    </template>
    <RepositoryEvidenceStatus
      v-if="user && binding.data.value?.repository && !binding.isError.value"
      :key="`${user.id}:${binding.data.value.repository.id}`"
      :repository-id="binding.data.value.repository.id"
    />
    <button
      type="button"
      :disabled="
        busy ||
        binding.isFetching.value ||
        installations.isFetching.value ||
        options.isFetching.value
      "
      class="min-h-11 rounded-full border border-hairline-strong px-6 font-mono text-sm disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
      @click="refresh"
    >
      刷新状态
    </button>
  </section>
</template>
