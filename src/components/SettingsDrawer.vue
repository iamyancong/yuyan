<template>
  <a-drawer
    :open="open"
    :width="360"
    title="平台设置"
    placement="right"
    @close="$emit('update:open', false)"
    :body-style="{ padding: '16px 16px 72px' }"
  >
    <div class="section">
      <div class="section-title">主题模式</div>
      <a-space size="middle" direction="vertical" style="width: 100%">
        <a-switch :checked="isDark" @change="setDarkMode" checked-children="暗" un-checked-children="亮" />
        <a-segmented :options="menuThemeOptions" v-model:value="menuTheme" />
      </a-space>
    </div>

    <div class="section">
      <div class="section-title">主题主色</div>
      <div class="current-color">
        <span>当前主题色</span>
        <div class="color-chip" :style="{ backgroundColor: colorValue }" />
        <span class="hex">{{ colorValue }}</span>
      </div>
      <div class="preset-title">预设颜色</div>
      <div class="swatches">
        <button
          v-for="c in presetColors"
          :key="c"
          class="swatch"
          :class="{ active: c.toLowerCase() === colorValue.toLowerCase() }"
          :style="{ color: c }"
          @click="setPrimaryColor(c)"
        >
          <span v-if="c.toLowerCase() === colorValue.toLowerCase()" class="check">✓</span>
        </button>
      </div>
      <div class="preset-title">自定义颜色</div>
      <label class="custom-color">
        <input class="hidden-input" type="color" :value="colorValue" @input="onPickColor" />
        <div class="custom-bar" :style="{ backgroundColor: colorValue }" />
      </label>
    </div>

    <div class="section">
      <div class="section-title">密度与圆角</div>
      <a-space direction="vertical" style="width: 100%">
        <a-switch :checked="isCompact" @change="setCompact" checked-children="紧凑" un-checked-children="默认" />
        <a-slider :min="0" :max="12" v-model:value="borderRadiusValue" />
      </a-space>
    </div>

    <template #footer>
      <div class="drawer-footer">
        <a-space>
          <a-button @click="resetTheme">重置</a-button>
          <a-button type="primary" @click="$emit('update:open', false)">完成</a-button>
        </a-space>
      </div>
    </template>
  </a-drawer>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useTheme } from '@/hooks/useTheme';

defineProps<{ open: boolean }>();
defineEmits<{ (e: 'update:open', v: boolean): void }>();

const { isDark, isCompact, borderRadius, menuTheme, primaryColor, setDarkMode, setCompact, setBorderRadius, setPrimaryColor, resetTheme } =
  useTheme();

// 预设主题色（与面板色块对应）
const presetColors = ['#722ED1', '#3371ff', '#FA8C16', '#F5222D'];

const menuThemeOptions = [
  { label: '暗色菜单', value: 'dark' },
  { label: '亮色菜单', value: 'light' },
];

const colorValue = computed({
  get: () => primaryColor.value,
  set: (v: string) => setPrimaryColor(v),
});

const borderRadiusValue = computed({
  get: () => borderRadius.value,
  set: (v: number) => setBorderRadius(v),
});

function onPickColor(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input && input.value) setPrimaryColor(input.value);
}
</script>

<style scoped>
.drawer-footer {
  display: flex;
  justify-content: flex-end;
}

.section {
  margin-bottom: 16px;
  padding: 12px;
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.05);
  background: var(--bg-color-container);
}
.section-title {
  font-weight: 600;
  margin-bottom: 10px;
}

.current-color {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.current-color .color-chip {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06);
}
.current-color .hex {
  opacity: 0.85;
}

.preset-title {
  font-weight: 500;
  margin: 10px 0 8px;
}
.swatches {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.swatch {
  position: relative;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: currentColor;
  outline: none;
  cursor: pointer;
  box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.02) inset;
}
.swatch.active {
  box-shadow: 0 0 0 2px #fff, 0 0 0 4px currentColor;
}
.swatch .check {
  display: none;
}

.custom-color {
  display: block;
}
.custom-color .hidden-input {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
}
.custom-color .custom-bar {
  height: 38px;
  border-radius: 12px;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06), 0 0 0 2px rgba(0, 0, 0, 0.02);
  cursor: pointer;
}
.custom-color:focus-within .custom-bar {
  outline: 2px solid currentColor;
}
</style>
