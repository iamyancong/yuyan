<script setup lang="ts">
defineOptions({ name: 'AiControlIcon' });
</script>

<template>
  <svg
    class="ai-control-icon"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M6.8 8.35C8.2 6.55 10.1 5.65 12.25 5.7C14.05 5.75 15.7 6.45 17.05 7.75" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" opacity="0.72" />
    <path d="M18.05 9.3C18.75 11.25 18.5 13.25 17.45 15C16.5 16.6 15.05 17.75 13.25 18.3" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" opacity="0.72" />
    <path d="M10.9 18.25C8.8 17.85 7.15 16.7 6.15 14.95C5.25 13.35 5 11.55 5.45 9.8" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" opacity="0.72" />
    <circle cx="5.85" cy="8.55" r="1.45" fill="currentColor" />
    <circle cx="18" cy="8.25" r="1.45" fill="currentColor" />
    <circle cx="12" cy="18.35" r="1.45" fill="currentColor" />
    <path d="M12 8.15L13.05 10.95L15.85 12L13.05 13.05L12 15.85L10.95 13.05L8.15 12L10.95 10.95L12 8.15Z" fill="currentColor" />
  </svg>
</template>

<style scoped lang="less">
.ai-control-icon {
  display: block;
  width: 1em;
  height: 1em;
}
</style>
