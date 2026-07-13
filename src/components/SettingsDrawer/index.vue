<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { BulbOutlined, CheckOutlined, CloseOutlined, EyeInvisibleOutlined } from '@ant-design/icons-vue';
import { YButton } from '@ycwang-dev/components/lite';
import { useTheme } from '@/hooks/useTheme';
import {
  BORDER_RADIUS_RANGE,
  DENSITY_OPTIONS,
  PRESET_COLORS,
  SETTINGS_DRAWER_WIDTH,
  SPACING_RANGE,
  THEME_MODE_OPTIONS,
  isActiveThemeColor,
} from './constant';

defineOptions({ name: 'SettingsDrawer' });

/**
 * 平台设置抽屉属性。
 */
interface SettingsDrawerProps {
  /** 抽屉是否打开 */
  open: boolean;
}

const props = defineProps<SettingsDrawerProps>();

const emit = defineEmits<{
  /** 更新抽屉打开状态 */
  (e: 'update:open', value: boolean): void;
}>();

const { isDark, isCompact, borderRadius, spacing, primaryColor, setDarkMode, setCompact, setBorderRadius, setSpacing, setPrimaryColor, resetTheme } =
  useTheme();

const colorInputVal = ref(primaryColor.value);

watch(primaryColor, (newVal) => {
  colorInputVal.value = newVal;
}, { immediate: true });

/**
 * 处理用户手动输入色值
 * @param event 输入事件
 */
const handleInputColor = (event: Event) => {
  let val = (event.target as HTMLInputElement).value.trim();
  if (/^[0-9A-Fa-f]{6}$/.test(val)) {
    val = `#${val}`;
    colorInputVal.value = val;
  }
  if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
    setPrimaryColor(val);
  }
};

/**
 * 输入框失去焦点时，进行格式化和重置
 */
const handleInputBlur = () => {
  let val = colorInputVal.value.trim();
  if (/^[0-9A-Fa-f]{6}$/.test(val)) {
    val = `#${val}`;
    colorInputVal.value = val;
  }
  if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
    setPrimaryColor(val);
  } else {
    colorInputVal.value = primaryColor.value;
  }
};

const colorValue = computed({
  get: () => primaryColor.value,
  set: (value: string) => setPrimaryColor(value),
});

const borderRadiusValue = computed({
  get: () => borderRadius.value,
  set: (value: number) => setBorderRadius(value),
});

const spacingValue = computed({
  get: () => spacing.value,
  set: (value: number) => setSpacing(value),
});

const drawerOpen = computed(() => props.open);

const drawerRootClass = computed(() => {
  return `settings-drawer-root settings-drawer-root--${isDark.value ? 'dark' : 'light'}`;
});

/**
 * 关闭设置抽屉。
 */
const closeDrawer = () => {
  emit('update:open', false);
};

/**
 * 处理自定义颜色选择。
 * @param event 原生颜色输入事件
 */
const handlePickColor = (event: Event) => {
  const input = event.target as HTMLInputElement;
  if (input?.value) {
    setPrimaryColor(input.value);
  }
};
</script>

<template>
  <a-drawer
    :open="drawerOpen"
    :width="SETTINGS_DRAWER_WIDTH"
    placement="right"
    :root-class-name="drawerRootClass"
    :closable="false"
    :body-style="{ padding: 0 }"
    @close="closeDrawer"
  >
    <template #title>
      <div class="settings-header">
        <div>
          <div class="settings-header__eyebrow">Yuyan Preferences</div>
          <h2 class="settings-header__title">平台设置</h2>
        </div>
        <button class="settings-header__close" type="button" aria-label="关闭平台设置" @click="closeDrawer">
          <CloseOutlined />
        </button>
      </div>
    </template>

    <div class="settings-shell" :class="{ 'settings-shell--dark': isDark }">
      <section class="theme-preview" :class="{ 'theme-preview--dark': isDark }" :style="{ '--preview-radius': `${borderRadiusValue + 10}px` }">
        <div class="theme-preview__glow" :style="{ background: colorValue }" />
        <div class="theme-preview__content">
          <div class="theme-preview__meta">
            <span class="theme-preview__badge">{{ isDark ? 'Dark Mode' : 'Light Mode' }}</span>
            <strong>实时主题预览</strong>
            <p>{{ isCompact ? '紧凑密度已启用，适合高频操作。' : '默认密度已启用，保持舒展阅读。' }}</p>
          </div>
          <div class="theme-preview__mock">
            <span class="theme-preview__mock-dot" />
            <span />
            <span />
          </div>
        </div>
      </section>

      <section class="setting-panel">
        <div class="setting-panel__head">
          <div>
            <h3>主题模式</h3>
            <p>切换平台整体明暗氛围</p>
          </div>
        </div>
        <div class="option-grid option-grid--mode">
          <button
            v-for="option in THEME_MODE_OPTIONS"
            :key="option.label"
            class="choice-card"
            :class="{ 'choice-card--active': isDark === option.value }"
            type="button"
            @click="setDarkMode(option.value)"
          >
            <span class="choice-card__icon">
              <BulbOutlined v-if="option.icon === 'light'" />
              <EyeInvisibleOutlined v-else />
            </span>
            <span class="choice-card__text">
              <strong>{{ option.label }}</strong>
              <small>{{ option.description }}</small>
            </span>
          </button>
        </div>
      </section>

      <section class="setting-panel">
        <div class="setting-panel__head">
          <div>
            <h3>主题主色</h3>
            <p>当前主题色会同步到按钮、表格和状态高亮</p>
          </div>
          <div class="current-color">
            <span class="current-color__chip" :style="{ backgroundColor: colorValue }" />
            <input
              v-model="colorInputVal"
              class="current-color__input"
              maxlength="7"
              @input="handleInputColor"
              @blur="handleInputBlur"
              @keydown.enter="handleInputBlur"
            />
          </div>
        </div>

        <div class="field-group">
          <div class="field-label">预设颜色</div>
          <div class="swatches">
            <button
              v-for="color in PRESET_COLORS"
              :key="color.value"
              class="swatch"
              :class="{ 'swatch--active': isActiveThemeColor(color.value, colorValue) }"
              :title="color.label"
              :style="{ '--swatch-color': color.value, '--swatch-glow': color.glow }"
              type="button"
              @click="setPrimaryColor(color.value)"
            >
              <CheckOutlined v-if="isActiveThemeColor(color.value, colorValue)" />
            </button>
          </div>
        </div>

        <div class="field-group">
          <div class="field-label">自定义颜色</div>
          <label class="custom-color" :style="{ '--custom-color': colorValue }">
            <input class="custom-color__input" type="color" :value="colorValue" @input="handlePickColor" />
            <span class="custom-color__bar">
              <span class="custom-color__shine" />
            </span>
          </label>
        </div>
      </section>

      <section class="setting-panel">
        <div class="setting-panel__head">
          <div>
            <h3>密度与设计</h3>
            <p>调整信息密度、圆角和布局节奏</p>
          </div>
        </div>

        <div class="option-grid">
          <button
            v-for="option in DENSITY_OPTIONS"
            :key="option.label"
            class="choice-card"
            :class="{ 'choice-card--active': isCompact === option.value }"
            type="button"
            @click="setCompact(option.value)"
          >
            <span class="choice-card__meter" :class="{ 'choice-card__meter--compact': option.value }">
              <i />
              <i />
              <i />
            </span>
            <span class="choice-card__text">
              <strong>{{ option.label }}</strong>
              <small>{{ option.description }}</small>
            </span>
          </button>
        </div>

        <div class="slider-list">
          <div class="slider-item">
            <div class="slider-item__head">
              <span>圆角大小</span>
              <strong>{{ borderRadiusValue }}px</strong>
            </div>
            <a-slider v-model:value="borderRadiusValue" :min="BORDER_RADIUS_RANGE.min" :max="BORDER_RADIUS_RANGE.max" />
          </div>
          <div class="slider-item">
            <div class="slider-item__head">
              <span>布局间距</span>
              <strong>{{ spacingValue }}px</strong>
            </div>
            <a-slider v-model:value="spacingValue" :min="SPACING_RANGE.min" :max="SPACING_RANGE.max" />
          </div>
        </div>
      </section>
    </div>

    <template #footer>
      <div class="settings-footer">
        <YButton @click="resetTheme">重置</YButton>
        <YButton type="primary" @click="closeDrawer">完成</YButton>
      </div>
    </template>
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
