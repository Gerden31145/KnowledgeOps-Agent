<template>
  <span class="animated-ellipsis" aria-hidden="true">...</span>
</template>

<style scoped>
.animated-ellipsis {
  display: inline-block;
  width: 0;
  overflow: hidden;
  vertical-align: bottom;
  white-space: nowrap;
  animation: animated-ellipsis 1.2s steps(3, end) infinite;
}

@keyframes animated-ellipsis {
  from {
    width: 0;
  }
  to {
    width: 3ch;
  }
}

@media (prefers-reduced-motion: reduce) {
  .animated-ellipsis {
    width: 3ch;
    animation: none;
  }
}
</style>
