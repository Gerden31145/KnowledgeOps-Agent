<template>
  <div class="min-h-screen bg-canvas text-ink">
    <a
      class="fixed top-3 left-3 z-50 -translate-y-24 rounded-full border border-ink bg-canvas px-6 py-3 font-mono text-caption tracking-label uppercase transition-transform focus:translate-y-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
      href="#main-content"
    >
      跳到主要内容
    </a>

    <header
      class="mx-auto grid h-14 max-w-7xl grid-cols-[1fr_auto_1fr] items-center border-b border-hairline px-4 sm:px-6 lg:px-10"
    >
      <span class="font-mono text-caption tracking-label text-muted uppercase">System</span>
      <NuxtLink
        class="font-display text-sm font-normal tracking-display uppercase focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-link"
        to="/"
      >
        KnowledgeOps
      </NuxtLink>
      <span class="text-right font-mono text-caption tracking-label text-muted uppercase"
        >Phase 02</span
      >
    </header>

    <slot />

    <footer
      class="mx-auto flex max-w-7xl flex-col gap-4 border-t border-hairline px-4 py-16 font-mono text-caption tracking-label text-muted uppercase sm:px-6 md:flex-row md:items-center md:justify-between lg:px-10"
    >
      <span>KnowledgeOps Agent / 2026</span>
      <span>Only verified capabilities are presented</span>
    </footer>
  </div>
</template>
