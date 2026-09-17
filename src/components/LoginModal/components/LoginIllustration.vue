<script setup lang="ts">
defineOptions({ name: 'LoginIllustration' });
</script>

<template>
  <div class="illustration-content">
    <div class="glow-effect glow-top"></div>
    <div class="glow-effect glow-bottom"></div>
    <div class="glow-effect glow-center"></div>

    <div class="building-complex">
      <div class="main-building">
        <div class="building-face building-front"></div>
        <div class="building-face building-side"></div>
        <div class="building-face building-top"></div>
        <div class="building-window"></div>
        <div class="building-window window-2"></div>
        <div class="building-window window-3"></div>
      </div>
      <div class="sub-building">
        <div class="building-face building-front-sub"></div>
        <div class="building-face building-side-sub"></div>
        <div class="building-face building-top-sub"></div>
      </div>
      <div class="small-building">
        <div class="building-face building-front-small"></div>
        <div class="building-face building-side-small"></div>
        <div class="building-face building-top-small"></div>
      </div>
    </div>

    <div class="chart-container">
      <div class="chart-3d">
        <div class="chart-bar bar-1"></div>
        <div class="chart-bar bar-2"></div>
        <div class="chart-bar bar-3"></div>
        <div class="chart-bar bar-4"></div>
        <div class="chart-base"></div>
      </div>
    </div>

    <div class="coin-stack">
      <div class="coin coin-1"></div>
      <div class="coin coin-2"></div>
      <div class="coin coin-3"></div>
      <div class="coin coin-4"></div>
      <div class="coin coin-5"></div>
    </div>

    <div class="character-3d">
      <div class="character-head"></div>
      <div class="character-body"></div>
      <div class="character-shadow"></div>
    </div>

    <div class="floating-elements">
      <div class="float-item triangle"></div>
      <div class="float-item circle"></div>
      <div class="float-item pentagon"></div>
      <div class="float-item star"></div>
    </div>

    <div class="platform-base">
      <div class="platform-top"></div>
      <div class="platform-side"></div>
      <div class="platform-front"></div>
      <div class="platform-shadow"></div>
    </div>

    <div class="hero-content">
      <span class="hero-tag">WELCOME</span>
      <h1 class="hero-title">YUYAN</h1>
      <p class="hero-subtitle">雨燕 · 更快的应用搭建与交付</p>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './LoginIllustration.less';
</style>
