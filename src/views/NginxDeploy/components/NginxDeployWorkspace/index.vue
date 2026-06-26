<script setup lang="ts">
import { CloudServerOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons-vue';
import message from 'ant-design-vue/es/message';
import { YButton } from '@ycwang-dev/components/lite';
import type { YTableActionConfig } from '@ycwang-dev/components/lite';
import type { DeployProjectContext, TargetFilterForm } from '../../types';
import DeployTargetTab from '../DeployTargetTab/index.vue';
import DeployServerTab from '../DeployServerTab/index.vue';
import DeployRecordTab from '../DeployRecordTab/index.vue';

defineOptions({ name: 'NginxDeployWorkspace' });

/** 部署中心主工作区属性 */
interface NginxDeployWorkspaceProps {
  project: DeployProjectContext;
  lifecycleState: Record<string, any>;
  serverState: Record<string, any>;
  targetState: Record<string, any>;
  recordState: Record<string, any>;
  progressState: Record<string, any>;
  serverActionConfig: YTableActionConfig;
  targetActionConfig: YTableActionConfig;
  recordActionConfig: YTableActionConfig;
}

const props = defineProps<NginxDeployWorkspaceProps>();

/**
 * 更新部署目标筛选条件。
 * @param values 最新筛选值
 */
const updateTargetFilterForm = (values: TargetFilterForm) => {
  Object.assign(props.targetState.targetFilterForm, values);
};

/** 打开 Nginx 管理抽屉，内部可切换服务器 */
const handleOpenNginxRuntime = async () => {
  await props.serverState.refreshServerList();
  const servers = props.serverState.servers.value || [];
  if (!servers.length) {
    message.warning('请先新增服务器，再管理 Nginx');
    return;
  }
  void props.serverState.openNginxRuntimeDrawer(servers);
};
</script>

<template>
  <div class="nginx-deploy-page">
    <div class="nginx-deploy-header">
      <div>
        <h2>独立服务器部署中心</h2>
        <p v-if="targetState.hasProjectContext.value">已从平台应用列表预选：{{ project.projectName }}（{{ project.defaultBranch || 'dev' }}）</p>
        <p v-else>可直接选择项目和分支新建部署目标，也可从“平台应用列表”带项目上下文进入。</p>
      </div>
      <a-space>
        <YButton @click="serverState.openCreateServer">
          <template #icon><CloudServerOutlined /></template>
          新增服务器
        </YButton>
        <YButton @click="handleOpenNginxRuntime">
          <template #icon><ThunderboltOutlined /></template>
          Nginx 管理
        </YButton>
        <YButton type="primary" @click="targetState.openCreateTarget">
          <template #icon><PlusOutlined /></template>
          新增部署目标
        </YButton>
      </a-space>
    </div>

    <a-tabs v-model:activeKey="lifecycleState.activeTabKey.value" @change="lifecycleState.handleTabChange">
      <a-tab-pane key="targets" tab="部署目标">
        <DeployTargetTab
          :loading="lifecycleState.loading.value"
          :repair-loading="targetState.targetBindingRepairing.value"
          :targets="targetState.runtimeTargets.value"
          :filter-form="targetState.targetFilterForm"
          :branch-options="targetState.targetBranchFilterOptions.value"
          :server-options="targetState.targetServerFilterOptions.value"
          :action-config="targetActionConfig"
          @update:filter-form="updateTargetFilterForm"
          @search="targetState.handleTargetFilterSearch"
          @reset="targetState.handleTargetFilterReset"
          @repair-nginx-bindings="targetState.repairManagedNginxBindings"
          @open-progress="progressState.openTargetProgress"
        />
      </a-tab-pane>
      <a-tab-pane key="servers" tab="服务器管理">
        <DeployServerTab
          :loading="lifecycleState.loading.value"
          :servers="serverState.servers.value"
          :action-config="serverActionConfig"
        />
      </a-tab-pane>
      <a-tab-pane key="records" tab="发布历史">
        <DeployRecordTab
          :loading="lifecycleState.loading.value"
          :records="recordState.records.value"
          :action-config="recordActionConfig"
          :server-filter="recordState.recordServerFilter.value"
          :project-filter="recordState.recordProjectFilter.value"
          :branch-filter="recordState.recordBranchFilter.value"
          :server-options="recordState.recordServerOptions.value"
          :project-options="recordState.recordProjectOptions.value"
          :branch-options="recordState.recordBranchOptions.value"
          :pagination="recordState.recordPagination"
          @server-change="recordState.handleRecordServerChange"
          @project-change="recordState.handleRecordProjectChange"
          @branch-change="recordState.handleRecordBranchChange"
          @page-change="recordState.handleRecordPageChange"
          @refresh="lifecycleState.refreshActiveTab"
        />
      </a-tab-pane>
    </a-tabs>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
