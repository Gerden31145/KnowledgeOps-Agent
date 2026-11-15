<script setup lang="ts">
import { useGlobalMessage } from '../composables/use-global-message'

const { message, dismissMessage } = useGlobalMessage()
</script>

<template>
  <div
    v-if="message"
    class="fixed top-4 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 items-center gap-4 border border-hairline-strong bg-surface-elevated px-4 py-3 text-ink"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <p class="min-w-0 flex-1 text-base">{{ message.text }}</p>
    <button
      class="min-h-11 min-w-11 shrink-0 text-xl text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
      type="button"
      aria-label="关闭消息"
      @click="dismissMessage(message.id)"
    >
      ×
    </button>
  </div>
</template>
