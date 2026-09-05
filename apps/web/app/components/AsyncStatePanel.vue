<script setup lang="ts">
withDefaults(
  defineProps<{
    description: string
    eyebrow?: string
    title: string
    tone?: 'default' | 'warning'
  }>(),
  {
    eyebrow: 'System status',
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
      class="font-mono text-caption tracking-label uppercase"
      :class="tone === 'warning' ? 'text-warning' : 'text-muted'"
    >
      {{ eyebrow }}
    </p>
    <h2 class="mt-5 font-display text-3xl font-normal tracking-display uppercase md:text-4xl">
      {{ title }}
    </h2>
    <p class="mt-4 max-w-2xl leading-7 text-body">{{ description }}</p>
    <div v-if="$slots.actions" class="mt-8 flex flex-wrap gap-3">
      <slot name="actions" />
    </div>
  </section>
</template>
