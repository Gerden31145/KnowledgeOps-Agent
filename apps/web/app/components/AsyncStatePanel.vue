<script setup lang="ts">
withDefaults(
  defineProps<{
    description: string
    eyebrow?: string
    title: string
    tone?: 'default' | 'warning'
  }>(),
  {
    eyebrow: '',
    tone: 'default',
  },
)
</script>

<template>
  <section
    class="border border-hairline bg-surface-soft p-6 md:p-8"
    :class="tone === 'warning' ? 'border-warning/60' : ''"
    role="status"
  >
    <p
      v-if="eyebrow"
      class="font-mono text-caption tracking-label uppercase"
      :class="tone === 'warning' ? 'text-warning' : 'text-muted'"
    >
      {{ eyebrow }}
    </p>
    <h2 class="text-section-title font-medium">
      {{ title }}
    </h2>
    <p class="mt-3 max-w-2xl text-reading text-body">{{ description }}</p>
    <div v-if="$slots.actions" class="mt-8 flex flex-wrap gap-3">
      <slot name="actions" />
    </div>
  </section>
</template>
