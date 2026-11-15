<script setup lang="ts">
import type { CourseSection } from '@knowledgeops/contracts'
import { ref } from 'vue'

const props = defineProps<{
  sections: CourseSection[]
  desktopOffset: number
}>()

const open = ref(false)

function scrollToSection(sectionId: string) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  document.getElementById(`course-section-${sectionId}`)?.scrollIntoView({
    behavior: reducedMotion ? 'instant' : 'smooth',
    block: 'start',
  })
}
</script>

<template>
  <div class="lg:absolute lg:right-full lg:top-0 lg:z-10 lg:mr-2 lg:h-full lg:w-11">
    <nav
      class="lg:sticky lg:top-[var(--course-toc-offset)]"
      :style="{ '--course-toc-offset': `${props.desktopOffset}px` }"
      aria-label="课程章节目录"
    >
      <button
        class="flex min-h-11 w-full items-center justify-between gap-3 px-0 py-2 text-left text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link lg:justify-center"
        type="button"
        :aria-label="open ? '收起章节目录' : '展开章节目录'"
        :aria-expanded="open"
        aria-controls="course-toc-sections"
        @click="open = !open"
      >
        <span class="lg:sr-only">章节目录</span>
        <svg
          class="size-5 shrink-0 transition-transform motion-reduce:transition-none"
          :class="open ? 'rotate-90' : ''"
          viewBox="0 0 20 20"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m7 4 6 6-6 6"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <ol
        v-show="open"
        id="course-toc-sections"
        class="mt-2 space-y-1 lg:absolute lg:right-0 lg:max-h-[calc(100dvh-var(--course-toc-offset)-4rem)] lg:w-56 lg:overflow-y-auto lg:bg-canvas lg:pr-4"
      >
        <li v-for="section in props.sections" :key="section.id">
          <a
            class="flex min-h-11 items-center break-words py-2 text-base leading-6 text-muted no-underline hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
            :href="`#course-section-${section.id}`"
            @click.prevent="scrollToSection(section.id)"
          >
            {{ section.title }}
          </a>
        </li>
      </ol>
    </nav>
  </div>
</template>
