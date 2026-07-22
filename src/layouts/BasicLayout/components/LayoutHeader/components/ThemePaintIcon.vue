<script setup lang="ts">
defineOptions({ name: 'ThemePaintIcon' });
</script>

<template>
  <svg
    class="theme-paint-icon"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <linearGradient id="paintBucketGrad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#FF9F43" />
        <stop offset="50%" stop-color="#FF5252" />
        <stop offset="100%" stop-color="#7B3FE4" />
      </linearGradient>
      <linearGradient id="dropGrad" x1="18" y1="12" x2="20" y2="17" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#00F2FE" />
        <stop offset="100%" stop-color="#4FACFE" />
      </linearGradient>
    </defs>
    <!-- Tilted Bucket Shape -->
    <path
      d="M19 11L13 5L4.5 13.5C3.7 14.3 3.7 15.7 4.5 16.5L7.5 19.5C8.3 20.3 9.7 20.3 10.5 19.5L19 11Z"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      fill="none"
      class="paint-bucket-body"
    />
    <!-- Paint Fluid Fill Line inside bucket -->
    <path
      d="M7 11L14 18"
      stroke="url(#paintBucketGrad)"
      stroke-width="2"
      stroke-linecap="round"
    />
    <!-- Bucket Handle Arc -->
    <path
      d="M7.5 7.5L11 4"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
    />
    <!-- Falling Drop -->
    <path
      d="M19.5 14.5C19.5 15.6 18.6 16.5 17.5 16.5C16.4 16.5 15.5 15.6 15.5 14.5C15.5 13.5 17.5 11 17.5 11C17.5 11 19.5 13.5 19.5 14.5Z"
      fill="url(#dropGrad)"
      class="paint-drop"
    />
    <!-- Surface/Base Bar -->
    <path
      d="M4 21H20"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      class="paint-surface"
    />
  </svg>
</template>

<style scoped lang="less">
.theme-paint-icon {
  display: inline-block;
  width: 1em;
  height: 1em;
  vertical-align: -0.125em;
  overflow: visible;

  .paint-drop {
    transition: transform 0.3s ease;
  }
}

:global(.header-action-btn.btn-settings:hover) .theme-paint-icon {
  .paint-bucket-body {
    transform: rotate(-12deg);
    transform-origin: 10px 10px;
    transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .paint-drop {
    transform: translateY(2px) scale(1.15);
  }
}
</style>
