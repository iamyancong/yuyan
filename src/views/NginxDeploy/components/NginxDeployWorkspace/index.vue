<script setup lang="ts">
import { computed } from 'vue';
import message from 'ant-design-vue/es/message';
import { YCard } from '@yss-ui/components/lite';
import type { NginxDeployWorkspaceProps } from './constant';
import type { TargetFilterForm } from '../../types';
import CentralDataStatus from '../CentralDataStatus/index.vue';
import DeployHero from '../DeployHero/index.vue';
import DeployTargetTab from '../DeployTargetTab/index.vue';
import DeployServerTab from '../DeployServerTab/index.vue';
import DeployRecordTab from '../DeployRecordTab/index.vue';

defineOptions({ name: 'NginxDeployWorkspace' });
const props = defineProps<NginxDeployWorkspaceProps>();
/** 成功加载且无目标时才展示空态，避免把连接异常展示为空列表。 */
const showEmptyState = computed(() => !props.lifecycleState.refreshError.value && props.lifecycleState.activeTabKey.value === 'targets'
  && props.lifecycleState.tabLoadedFlags.value.targets && !props.lifecycleState.loading.value && !props.targetState.allTargets.value.length);

/**
 * 更新部署目标筛选条件。
 * @param values 最新筛选值
 */
const updateTargetFilterForm = (values: TargetFilterForm) => {
  Object.assign(props.targetState.targetFilterForm, values);
};

/** 打开 Nginx 管理抽屉，先开抽屉壳后拉取最新状态 */
const handleOpenNginxRuntime = async () => {
  let servers = props.serverState.servers.value || [];
  if (!servers.length) {
    // 若当前无服务器缓存，拉取一次以确认是否存在服务器
    await props.serverState.refreshServerList();
    servers = props.serverState.servers.value || [];
    if (!servers.length) {
      message.warning('请先新增服务器，再管理 Nginx');
      return;
    }
  } else {
    // 已有服务器列表时，后台静默刷新最新服务器，不阻塞抽屉打开
    void props.serverState.refreshServerList();
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
      :servers="serverState.servers.value"
      :targets="targetState.runtimeTargets.value"
      @create-server="serverState.openCreateServer"
      @nginx-manage="handleOpenNginxRuntime"
      @create-target="targetState.openCreateTarget"
      @select-tab="lifecycleState.handleTabChange"
    />

    <div class="deploy-tabs-wrapper">
      <YCard class="nginx-deploy-main-card" :padding="0">
        <CentralDataStatus
          :error="lifecycleState.refreshError.value"
          :warning="lifecycleState.refreshWarning.value"
          :info="lifecycleState.refreshInfo.value"
          :title="lifecycleState.refreshTitle.value"
          :description="lifecycleState.refreshDescription.value"
          @retry="lifecycleState.retryActiveTab"
        />
        <a-alert
          v-if="showEmptyState"
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
            :active="lifecycleState.activeTabKey.value === 'targets'"
            :loading="Boolean(lifecycleState.loading.value && lifecycleState.activeTabKey.value === 'targets')"
            :targets="targetState.runtimeTargets.value"
            :filter-form="targetState.targetFilterForm"
            :branch-options="targetState.targetBranchFilterOptions.value"
            :server-options="targetState.targetServerFilterOptions.value"
            :action-config="targetActionConfig"
            @update:filter-form="updateTargetFilterForm"
            @search="targetState.handleTargetFilterSearch"
            @reset="targetState.handleTargetFilterReset"
            @open-progress="progressState.openTargetProgress"
            @bind-instance="targetState.openEditTarget"
          />
        </a-tab-pane>
        <a-tab-pane key="servers" tab="服务器管理">
          <DeployServerTab
            :active="lifecycleState.activeTabKey.value === 'servers'"
            :loading="Boolean(lifecycleState.loading.value && lifecycleState.activeTabKey.value === 'servers')"
            :order-saving="serverState.serverOrderSaving.value"
            :servers="serverState.servers.value"
            :action-config="serverActionConfig"
            @reorder="serverState.reorderServerList"
            @manage-nginx="serverState.openNginxRuntime"
          />
        </a-tab-pane>
        <a-tab-pane key="records" tab="发布历史">
          <DeployRecordTab
            :active="lifecycleState.activeTabKey.value === 'records'"
            :loading="Boolean(lifecycleState.loading.value && lifecycleState.activeTabKey.value === 'records')"
            :records="recordState.records.value"
            :action-config="recordActionConfig"
            :server-filter="recordState.recordServerFilter.value"
            :project-filter="recordState.recordProjectFilter.value"
            :branch-filter="recordState.recordBranchFilter.value"
            :operator-filter="recordState.recordOperatorFilter.value"
            :server-options="recordState.recordServerOptions.value"
            :project-options="recordState.recordProjectOptions.value"
            :branch-options="recordState.recordBranchOptions.value"
            :pagination="recordState.recordPagination"
            @server-change="recordState.handleRecordServerChange"
            @project-change="recordState.handleRecordProjectChange"
            @branch-change="recordState.handleRecordBranchChange"
            @operator-change="recordState.handleRecordOperatorChange"
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
