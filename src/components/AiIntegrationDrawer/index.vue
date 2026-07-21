<script setup lang="ts">
import { computed } from 'vue';
import { CloseOutlined } from '@ant-design/icons-vue';
import { useTheme } from '@/hooks/useTheme';
import AiIntegrationPanel from '@/components/AiIntegrationPanel/index.vue';
import AiControlIcon from './components/AiControlIcon.vue';
import { AI_INTEGRATION_DRAWER_WIDTH } from './constant';

defineOptions({ name: 'AiIntegrationDrawer' });

/** AI 控制中心抽屉属性。 */
interface AiIntegrationDrawerProps {
  /** 抽屉是否打开 */
  open: boolean;
}

const props = defineProps<AiIntegrationDrawerProps>();

const emit = defineEmits<{
  /** 更新抽屉打开状态 */
  (event: 'update:open', value: boolean): void;
}>();

const { isDark } = useTheme();

/** 抽屉双向绑定状态。 */
const drawerOpen = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
});

/** 抽屉主题根类名。 */
const drawerRootClass = computed(() => `ai-integration-drawer-root ai-integration-drawer-root--${isDark.value ? 'dark' : 'light'}`);

/** 关闭 AI 控制中心抽屉。 */
const closeDrawer = () => {
  drawerOpen.value = false;
};
</script>

<template>
  <a-drawer
    :open="drawerOpen"
    :width="AI_INTEGRATION_DRAWER_WIDTH"
    placement="right"
    :root-class-name="drawerRootClass"
    :closable="false"
    :body-style="{ padding: 0 }"
    :destroy-on-close="true"
    @close="closeDrawer"
  >
    <template #title>
      <div class="ai-drawer-header">
        <div class="ai-drawer-header__identity">
          <span class="ai-drawer-header__mark"><AiControlIcon /></span>
          <div>
            <div class="ai-drawer-header__eyebrow">Yuyan AI Control Plane</div>
            <h2 class="ai-drawer-header__title">AI 控制中心</h2>
          </div>
        </div>
        <button class="ai-drawer-header__close" type="button" aria-label="关闭 AI 控制中心" @click="closeDrawer">
          <CloseOutlined />
        </button>
      </div>
    </template>

    <div class="ai-drawer-shell" :class="{ 'ai-drawer-shell--dark': isDark }">
      <AiIntegrationPanel />
    </div>
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
