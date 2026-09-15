<script setup lang="ts">
import { CloudServerOutlined, RocketOutlined, SearchOutlined } from '@ant-design/icons-vue';
import { YButton } from '@yss-ui/components/lite';
import type { DeployServer } from '@/api/deploy';
import { EXTERNAL_CARD_INFO, MANAGED_CARD_INFO } from './constant';

defineOptions({ name: 'NginxRuntimeEmptyState' });

/**
 * Nginx 管理抽屉空态组件属性
 */
interface NginxRuntimeEmptyStateProps {
  /** 是否已选择服务器 */
  hasServer: boolean;
  /** 当前服务器 */
  server?: DeployServer | null;
}

defineProps<NginxRuntimeEmptyStateProps>();

const emit = defineEmits<{
  /** 触发创建托管 Nginx 实例 */
  (e: 'createManaged'): void;
  /** 触发智能发现已有 Nginx 实例 */
  (e: 'createExternal'): void;
}>();
</script>

<template>
  <div class="nginx-runtime-empty-state">
    <!-- 空态 A：未选服务器 -->
    <div v-if="!hasServer" class="nginx-runtime-empty-state__no-server">
      <CloudServerOutlined class="empty-icon" />
      <div class="empty-title">请选择一台服务器后再管理 Nginx 实例</div>
      <div class="empty-desc">
        请在抽屉顶部下拉栏中切换需要维护的目标服务器，或关闭抽屉前往服务器管理 Tab 进行维护。
      </div>
    </div>

    <!-- 空态 B：服务器无实例（对标 NPM 双卡片模式） -->
    <div v-else class="nginx-runtime-empty-state__no-instance">
      <div class="header-box">
        <div class="title">当前服务器暂无 Nginx 实例</div>
        <div class="desc">
          服务器「{{ server?.name }} ({{ server?.host }})」尚未初始化或纳管 Nginx，请选择接入方式：
        </div>
      </div>

      <div class="card-grid">
        <!-- 平台托管卡片 -->
        <div class="choice-card">
          <div>
            <div class="choice-card__header">
              <div class="card-icon managed">
                <RocketOutlined />
              </div>
              <div class="card-titles">
                <div class="main-title">{{ MANAGED_CARD_INFO.title }}</div>
                <div class="sub-title">{{ MANAGED_CARD_INFO.subtitle }}</div>
              </div>
            </div>
            <div class="choice-card__body">
              {{ MANAGED_CARD_INFO.description }}
            </div>
          </div>
          <div class="choice-card__action">
            <YButton type="primary" class="action-btn" @click="emit('createManaged')">
              <template #icon><RocketOutlined /></template>
              {{ MANAGED_CARD_INFO.buttonText }}
            </YButton>
          </div>
        </div>

        <!-- 智能发现已有卡片 -->
        <div class="choice-card">
          <div>
            <div class="choice-card__header">
              <div class="card-icon external">
                <SearchOutlined />
              </div>
              <div class="card-titles">
                <div class="main-title">{{ EXTERNAL_CARD_INFO.title }}</div>
                <div class="sub-title">{{ EXTERNAL_CARD_INFO.subtitle }}</div>
              </div>
            </div>
            <div class="choice-card__body">
              {{ EXTERNAL_CARD_INFO.description }}
            </div>
          </div>
          <div class="choice-card__action">
            <YButton class="action-btn" @click="emit('createExternal')">
              <template #icon><SearchOutlined /></template>
              {{ EXTERNAL_CARD_INFO.buttonText }}
            </YButton>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
