<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { YTable } from '@yss-ui/components/lite';
import { useTableHeight } from '@yss-ui/hooks';
import type { YTableActionConfig } from '@yss-ui/components/lite';
import type { DeployTarget } from '@/api/deploy';
import type { TargetFilterForm } from '../../types';
import { targetColumns } from '../../constant';
import NginxProjectNameCell from '../NginxProjectNameCell/index.vue';
import DeployTargetRuntimeCell from '../DeployTargetRuntimeCell/index.vue';
import DeployServerCell from '../DeployServerCell/index.vue';
import DeployTargetSiteSummaryCell from '../DeployTargetSiteSummaryCell/index.vue';
import DeployTargetFilterBar from './components/DeployTargetFilterBar.vue';
import { useNginxDeployContext } from '../../hooks/useNginxDeployContext';
import { useDeployTabTableLayout } from '../../hooks/useDeployTabTableLayout';

defineOptions({ name: 'DeployTargetTab' });

/** 下拉选项 */
interface SelectOption {
  label: any;
  value: string | number;
  title?: string;
  searchKey?: string;
}

/** 部署目标 Tab 属性 */
interface DeployTargetTabProps {
  active?: boolean;
  loading: boolean;
  targets: DeployTarget[];
  filterForm: TargetFilterForm;
  branchOptions: SelectOption[];
  serverOptions: SelectOption[];
  /** Nginx 实例筛选项（#47） */
  instanceOptions?: SelectOption[];
  actionConfig: YTableActionConfig;
}

const props = defineProps<DeployTargetTabProps>();
const emit = defineEmits<{
  (e: 'update:filterForm', value: TargetFilterForm): void;
  (e: 'search'): void;
  (e: 'reset'): void;
  (e: 'openProgress', target: DeployTarget): void;
  (e: 'bindInstance', target: DeployTarget): void;
}>();

const tableAreaRef = ref<HTMLElement>();
const activeRef = computed(() => props.active !== false);
const { tableHeight: rawTableHeight, recalculateHeight } = useTableHeight(tableAreaRef, {
  minHeight: 240,
  defaultHeight: 420,
});

/** 限制表格最小高度，避免 hook 内部 availableHeight <= minHeight 时 fallback 到 0 的 Bug */
const tableHeight = computed(() => {
  return rawTableHeight.value > 240 ? rawTableHeight.value : 240;
});

useDeployTabTableLayout({
  active: activeRef,
  recalculateHeight,
});

/** 等待视图更新后重新计算表格高度（仅在当前 Tab 激活时执行，避免后台强制回流） */
const recalculateAfterRender = async () => {
  if (!activeRef.value) return;
  await nextTick();
  recalculateHeight();
};

watch([() => props.loading, () => props.targets.length], recalculateAfterRender, { flush: 'post' });

/**
 * 传递最新的筛选表单数据。
 * @param val 筛选表单最新值
 */
const handleFilterFormUpdate = (val: TargetFilterForm) => {
  emit('update:filterForm', val);
};

const { projectType } = useNginxDeployContext();

const activeColumns = computed(() => {
  const commonExcludedFields = ['nginxInstanceName', 'listenPort', 'nginxServerName'];
  if (projectType.value === 'backend') {
    const excludedFields = [...commonExcludedFields, 'siteSummary', 'nginxConfPath', 'uploadStrategy', 'preserveSubDirs', 'projectType'];
    return targetColumns.filter((col) => !excludedFields.includes(col.field || ''));
  } else if (projectType.value === 'frontend') {
    const excludedFields = [...commonExcludedFields, 'projectType'];
    return targetColumns.filter((col) => !excludedFields.includes(col.field || ''));
  }
  return targetColumns.filter((col) => !commonExcludedFields.includes(col.field || ''));
});
</script>

<template>
  <div class="nginx-deploy-tab-pane">
    <DeployTargetFilterBar
      :loading="loading"
      :filter-form="filterForm"
      :branch-options="branchOptions"
      :server-options="serverOptions"
      :instance-options="projectType === 'backend' ? [] : instanceOptions || []"
      :show-instance-filter="projectType !== 'backend'"
      @update:filter-form="handleFilterFormUpdate"
      @search="emit('search')"
      @reset="emit('reset')"
    />
    <div ref="tableAreaRef" class="nginx-deploy-table-area">
      <!-- 不强制虚拟滚动。显式 min-height 关掉 YTable 在仅有 max-height 时的反复 recalculate，否则切 Tab 会卡住数秒。 -->
      <YTable
        :data="targets"
        :columns="activeColumns"
        :loading="loading"
        :action-config="actionConfig"
        :max-height="tableHeight"
        :min-height="240"
        :cell-config="{ height: 58 }"
        :header-height="42"
        :row-config="{ keyField: 'id', useKey: true }"
        :pageable="false"
        size="small"
        id="nginx-deploy-targets"
      >
        <template #projectName="{ row }">
          <NginxProjectNameCell :record="row" show-access-status />
        </template>
        <template #serverName="{ row }">
          <DeployServerCell :server-name="row.serverName" :server-host="row.serverHost" />
        </template>
        <template #siteSummary="{ row }">
          <DeployTargetSiteSummaryCell :target="row" @bind-instance="(target) => emit('bindInstance', target)" />
        </template>
        <template #defaultBranch="{ row }">
          <a-tooltip :title="row.defaultBranch || '-'">
            <a-tag class="branch-tag">{{ row.defaultBranch || '-' }}</a-tag>
          </a-tooltip>
        </template>
        <template #runtimeStatus="{ row }">
          <DeployTargetRuntimeCell :record="row" @click="emit('openProgress', row)" />
        </template>
      </YTable>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
