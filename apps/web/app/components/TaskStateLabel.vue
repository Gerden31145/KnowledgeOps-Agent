<script setup lang="ts">
import type { TaskState } from '@knowledgeops/contracts'
import { computed } from 'vue'

const props = defineProps<{ state: TaskState }>()

const stateMeta: Record<TaskState, { label: string; className: string }> = {
  BLOCKED: { label: '等待解锁', className: 'text-muted' },
  READY: { label: '可开始', className: 'text-link' },
  IN_PROGRESS: { label: '进行中', className: 'text-body-strong' },
  VERIFYING: { label: '验收中', className: 'text-body-strong' },
  NEEDS_REVISION: { label: '需要修订', className: 'text-warning' },
  NEEDS_EVIDENCE: { label: '等待回答', className: 'text-warning' },
  PASSED: { label: '已通过', className: 'text-success' },
}

const meta = computed(() => stateMeta[props.state])
</script>

<template>
  <span
    class="font-mono text-caption tracking-label uppercase"
    :class="meta.className"
    :aria-label="`任务状态：${meta.label}`"
  >
    {{ meta.label }}
  </span>
</template>
