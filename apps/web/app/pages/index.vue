<script setup lang="ts">
import { navigateTo, useRoute } from '#imports'
const route = useRoute()
await navigateTo({ path: '/app/plan', query: route.query, hash: route.hash }, { replace: true })
</script>
<template><div /></template>
