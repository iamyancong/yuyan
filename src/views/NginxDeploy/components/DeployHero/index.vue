<script setup lang="ts">
import { CloudServerOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons-vue';
import { YButton } from '@yss-ui/components/lite';
import { useNginxDeployContext } from '../../hooks/useNginxDeployContext';

defineOptions({ name: 'DeployHero' });

const { projectType, setProjectType } = useNginxDeployContext();

/**
 * 部署中心 Hero 组件属性
 */
interface DeployHeroProps {
  /** 是否存在项目上下文 */
  hasProjectContext: boolean;
  /** 项目名称 */
  projectName?: string;
  /** 项目默认分支 */
  defaultBranch?: string;
}

defineProps<DeployHeroProps>();

const emit = defineEmits<{
  /** 触发新增服务器 */
  (e: 'createServer'): void;
  /** 触发 Nginx 管理 */
  (e: 'nginxManage'): void;
  /** 触发新增部署目标 */
  (e: 'createTarget'): void;
}>();
</script>

<template>
  <div class="deploy-hero">
    <div class="deploy-hero__content">
      <div class="deploy-hero__left">
        <div class="deploy-hero__kicker">Server Deployment Center</div>
        <h1 class="deploy-hero__title">
          独立服务器部署中心
          <span class="title-split">·</span>
          <span class="glass-type-select-wrapper">
            <a-select
              :value="projectType"
              :bordered="false"
              class="glass-type-select"
              popupClassName="glass-type-select-popup"
              :popupMatchSelectWidth="false"
              :dropdownStyle="{ minWidth: '120px' }"
              @change="setProjectType"
            >
              <a-select-option value="all">全部项目</a-select-option>
              <a-select-option value="frontend">前端应用</a-select-option>
              <a-select-option value="backend">后端服务</a-select-option>
            </a-select>
          </span>
        </h1>
        <div class="deploy-hero__subtitle">
          <p v-if="hasProjectContext" class="context-desc">
            已从平台应用列表预选：<strong>{{ projectName }}</strong>
            <span class="branch-pill" v-if="defaultBranch">
              {{ defaultBranch }}
            </span>
          </p>
          <p v-else class="context-desc">
            可直接选择项目和分支新建部署目标，也可从“平台应用列表”带项目上下文进入。
          </p>
        </div>

        <div class="deploy-hero__flow">
          <span class="flow-step">1. 创建部署目标</span>
          <i class="flow-line" />
          <span class="flow-step">2. Nginx 关联配置</span>
          <i class="flow-line" />
          <span class="flow-step">3. 发布与版本管理</span>
        </div>
      </div>

      <div class="deploy-hero__right">
        <a-space :size="12" class="hero-actions">
          <YButton class="hero-btn" @click="emit('createServer')">
            <template #icon><CloudServerOutlined /></template>
            新增服务器
          </YButton>
          <YButton class="hero-btn" @click="emit('nginxManage')">
            <template #icon><ThunderboltOutlined /></template>
            Nginx 管理
          </YButton>
          <YButton class="hero-btn primary-hero-btn" type="primary" @click="emit('createTarget')">
            <template #icon><PlusOutlined /></template>
            新增部署目标
          </YButton>
        </a-space>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>

<style lang="less">
@import './popup.less';
</style>
