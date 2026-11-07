<script setup lang="ts">
import type { VerificationRunRevision } from '../lib/verification-polling'
import { useCancelVerificationRun } from '../composables/use-cancel-verification-run'

const props = defineProps<{ run: VerificationRunRevision & { taskId: string } }>()
const { busy, issue, message, waiting, canCancel, cancel } = useCancelVerificationRun(
  () => props.run,
)
</script>

<template>
  <div v-if="canCancel || waiting || message || issue" class="space-y-3">
    <button
      v-if="canCancel || waiting || busy"
      type="button"
      class="min-h-11 rounded-full border border-ink px-6 text-base disabled:border-muted-soft disabled:text-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
      :disabled="busy || waiting"
      @click="cancel"
    >
      {{ busy ? '正在提交取消' : waiting ? '正在取消' : '取消本次验收' }}
    </button>
    <p v-if="message" class="text-base leading-6 text-muted" role="status">{{ message }}</p>
    <p v-if="issue" class="text-base leading-6 text-warning" role="alert">{{ issue }}</p>
  </div>
</template>
