import { defineNuxtPlugin } from '#app'
import { watch } from 'vue'
import { useSessionUser } from '../composables/use-session-user'
import { reconcileAnswerCommandSession } from '../lib/answer-command-session'

export default defineNuxtPlugin(() => {
  const user = useSessionUser()
  watch(
    () => user.value?.id,
    (id) => reconcileAnswerCommandSession(id ?? null),
    { flush: 'sync' },
  )
  // 不在启动时按初始 null 清理：先等 API 确认身份，保留同账号刷新恢复的原命令。
})
