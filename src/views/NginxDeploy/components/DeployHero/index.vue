<script setup lang="ts">
import { computed } from 'vue';
import { CloudServerOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons-vue';
import { YButton } from '@yss-ui/components/lite';
import type { DeployServer } from '@/api/deploy';
import type { RuntimeAwareDeployTarget } from '../../types';
import { useNginxDeployContext } from '../../hooks/useNginxDeployContext';
import { calcStep2Diagnostic } from './constant';

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
  /** 服务器列表（用于流程诊断） */
  servers?: DeployServer[];
  /** 部署目标列表（用于流程诊断） */
  targets?: RuntimeAwareDeployTarget[];
}

const props = withDefaults(defineProps<DeployHeroProps>(), {
  servers: () => [],
  targets: () => [],
});

const emit = defineEmits<{
  /** 触发新增服务器 */
  (e: 'createServer'): void;
  /** 触发 Nginx 管理 */
  (e: 'nginxManage'): void;
  /** 触发新增部署目标 */
  (e: 'createTarget'): void;
  /** 切换激活 Tab */
  (e: 'selectTab', tabKey: 'targets' | 'servers' | 'records'): void;
}>();

/** 流程第二步诊断结果 */
const step2Diag = computed(() => calcStep2Diagnostic(props.servers, props.targets));

/** 步骤 1 点击处理 */
const handleStep1Click = () => {
  if (props.targets.length === 0) {
    emit('createTarget');
  } else {
    emit('selectTab', 'targets');
  }
};

/** 步骤 2 点击处理：按诊断状态智能跳转 */
const handleStep2Click = () => {
  if (step2Diag.value.state === 'no_server') {
    emit('createServer');
  } else if (step2Diag.value.state === 'unlinked_targets') {
    emit('selectTab', 'targets');
  } else {
    emit('nginxManage');
  }
};

/** 步骤 3 点击处理 */
const handleStep3Click = () => {
  emit('selectTab', 'records');
};
</script>

<template>
  <div class="deploy-hero">
    <div class="deploy-hero__content">
      <div class="deploy-hero__left">
        <div class="deploy-hero__kicker">Deploy Center</div>
        <h1 class="deploy-hero__title">
          部署中心
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
          <a-tooltip title="点击查看部署目标或新建目标">
            <span class="flow-step is-clickable" @click="handleStep1Click">
              1. 创建部署目标
              <span v-if="targets.length > 0" class="flow-step__badge">({{ targets.length }})</span>
            </span>
          </a-tooltip>
          <i class="flow-line" />
          <a-tooltip :title="step2Diag.tooltip">
            <span
              :class="['flow-step', 'is-clickable', `is-${step2Diag.tagColor}`]"
              @click="handleStep2Click"
            >
              2. Nginx 关联配置
              <a-tag :color="step2Diag.tagColor" class="flow-step__tag">
                {{ step2Diag.tagText }}
              </a-tag>
            </span>
          </a-tooltip>
          <i class="flow-line" />
          <a-tooltip title="点击查看发布历史与版本管理">
            <span class="flow-step is-clickable" @click="handleStep3Click">
              3. 发布与版本管理
            </span>
          </a-tooltip>
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
