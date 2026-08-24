<script setup lang="ts">
import message from 'ant-design-vue/es/message';
import { YCard } from '@ycwang-dev/components/lite';
import type { YTableActionConfig } from '@ycwang-dev/components/lite';
import type { DeployProjectContext, TargetFilterForm } from '../../types';
import DeployHero from '../DeployHero/index.vue';
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
    <DeployHero
      :has-project-context="targetState.hasProjectContext.value"
      :project-name="project.projectName"
      :default-branch="project.defaultBranch"
      @create-server="serverState.openCreateServer"
      @nginx-manage="handleOpenNginxRuntime"
      @create-target="targetState.openCreateTarget"
    />

    <div class="deploy-tabs-wrapper">
      <YCard class="nginx-deploy-main-card" :padding="0">
        <a-alert
          v-if="lifecycleState.refreshError.value"
          class="central-data-status"
          type="error"
          show-icon
          message="中央部署数据不可用"
          :description="lifecycleState.refreshError.value"
        />
        <a-alert
          v-else-if="lifecycleState.activeTabKey.value === 'targets'
            && lifecycleState.tabLoadedFlags.value.targets
            && !lifecycleState.loading.value
            && !targetState.allTargets.value.length"
          class="central-data-status"
          type="info"
          show-icon
          message="暂无中央部署数据"
          description="当前共享部署工作区还没有服务器部署目标。"
        />
        <a-tabs
          v-model:activeKey="lifecycleState.activeTabKey.value"
          :animated="{ inkBar: true, tabPane: false }"
          :destroy-inactive-tab-pane="false"
          @change="lifecycleState.handleTabChange"
        >
        <a-tab-pane key="targets" tab="部署目标">
          <DeployTargetTab
            :loading="lifecycleState.loading.value"
            :targets="targetState.runtimeTargets.value"
            :filter-form="targetState.targetFilterForm"
            :branch-options="targetState.targetBranchFilterOptions.value"
            :server-options="targetState.targetServerFilterOptions.value"
            :action-config="targetActionConfig"
            @update:filter-form="updateTargetFilterForm"
            @search="targetState.handleTargetFilterSearch"
            @reset="targetState.handleTargetFilterReset"
            @open-progress="progressState.openTargetProgress"
          />
        </a-tab-pane>
        <a-tab-pane key="servers" tab="服务器管理">
          <DeployServerTab
            :loading="lifecycleState.loading.value"
            :order-saving="serverState.serverOrderSaving.value"
            :servers="serverState.servers.value"
            :action-config="serverActionConfig"
            @reorder="serverState.reorderServerList"
          />
        </a-tab-pane>
        <a-tab-pane key="records" tab="发布历史">
          <DeployRecordTab
            :active="lifecycleState.activeTabKey.value === 'records'"
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
            @refresh="() => lifecycleState.refreshActiveTab({ force: true, reloadRecordTargets: true })"
          />
        </a-tab-pane>
        </a-tabs>
      </YCard>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
