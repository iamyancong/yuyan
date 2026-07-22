<script setup lang="ts">
defineOptions({ name: 'AiControlIcon' });
</script>

<template>
  <svg
    class="ai-control-icon"
    viewBox="4 4 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <!-- AI Spark Core High-Contrast Gradient -->
      <linearGradient id="aiSparkGrad" x1="6" y1="6" x2="26" y2="26" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#FFFFFF" />
        <stop offset="45%" stop-color="#00F2FE" />
        <stop offset="100%" stop-color="#7B3FE4" />
      </linearGradient>

      <!-- Outer Orbit Ring High-Contrast Gradient -->
      <linearGradient id="aiOrbitGrad" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.95" />
        <stop offset="50%" stop-color="#00F2FE" stop-opacity="0.9" />
        <stop offset="100%" stop-color="#38EF7D" stop-opacity="0.8" />
      </linearGradient>

      <!-- Glow Filter -->
      <filter id="aiIconGlow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="0.8" result="blur" />
        <feComposite in="SourceGraphic" in2="blur" operator="over" />
      </filter>
    </defs>

    <!-- Outer Orbital Ring Arc -->
    <path
      d="M16 4.5A11.5 11.5 0 0 1 27.5 16A11.5 11.5 0 0 1 16 27.5A11.5 11.5 0 0 1 4.5 16"
      stroke="url(#aiOrbitGrad)"
      stroke-width="2.3"
      stroke-linecap="round"
      stroke-dasharray="52 14"
      class="ai-orbit-path"
    />

    <!-- Orbiting Pearl Node 1 (Top) -->
    <circle cx="16" cy="4.5" r="2.2" fill="#FFFFFF" filter="url(#aiIconGlow)" class="ai-node-dot dot-1" />

    <!-- Orbiting Pearl Node 2 (Bottom Left) -->
    <circle cx="6" cy="21.5" r="2.2" fill="#00F2FE" filter="url(#aiIconGlow)" class="ai-node-dot dot-2" />

    <!-- Orbiting Pearl Node 3 (Bottom Right) -->
    <circle cx="26" cy="21.5" r="2.2" fill="#38EF7D" filter="url(#aiIconGlow)" class="ai-node-dot dot-3" />

    <!-- Core 4-Point AI Spark Diamond -->
    <path
      d="M16 8C16 12.4 12.4 16 8 16C12.4 16 16 19.6 16 24C16 19.6 19.6 16 24 16C19.6 16 16 12.4 16 8Z"
      fill="url(#aiSparkGrad)"
      filter="url(#aiIconGlow)"
      class="ai-spark-core"
    />
  </svg>
</template>

<style scoped lang="less">
.ai-control-icon {
  display: inline-block;
  width: 1em;
  height: 1em;
  vertical-align: -0.125em;
  overflow: visible;

  .ai-spark-core {
    transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), filter 0.3s ease;
    transform-origin: 16px 16px;
  }

  .ai-orbit-path {
    transition: stroke-dashoffset 0.5s ease;
  }
}

:global(.header-action-btn.btn-ai-control:hover) .ai-control-icon {
  .ai-spark-core {
    transform: scale(1.05);
    filter: drop-shadow(0 0 4px rgba(0, 242, 254, 0.7));
  }

  .ai-node-dot {
    animation: pulse-dot 1.2s infinite ease-in-out alternate;
  }
}

:global(.ai-drawer-header__mark) .ai-control-icon {
  width: 24px;
  height: 24px;
}

@keyframes pulse-dot {
  from {
    transform: scale(1);
    opacity: 0.85;
  }

  to {
    transform: scale(1.12);
    opacity: 1;
  }
}
</style>

