<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { YTable } from '@ycwang-dev/components/lite';
import { openExternal } from '@/utils/open';
import { useTableHeight } from '@ycwang-dev/hooks';
import type { YTableActionConfig } from '@ycwang-dev/components/lite';
import type { RuntimeAwareDeployTarget, TargetFilterForm } from '../../types';
import { targetColumns } from '../../constant';
import NginxProjectNameCell from '../NginxProjectNameCell/index.vue';
import DeployTargetRuntimeCell from '../DeployTargetRuntimeCell/index.vue';
import DeployTargetFilterBar from './components/DeployTargetFilterBar.vue';
import { useNginxDeployContext } from '../../hooks/useNginxDeployContext';

defineOptions({ name: 'DeployTargetTab' });

/** 下拉选项 */
interface SelectOption {
  label: string;
  value: string | number;
}

/** 部署目标 Tab 属性 */
interface DeployTargetTabProps {
  loading: boolean;
  targets: RuntimeAwareDeployTarget[];
  filterForm: TargetFilterForm;
  branchOptions: SelectOption[];
  serverOptions: SelectOption[];
  actionConfig: YTableActionConfig;
}

const props = defineProps<DeployTargetTabProps>();
const emit = defineEmits<{
  (e: 'update:filterForm', value: TargetFilterForm): void;
  (e: 'search'): void;
  (e: 'reset'): void;
  (e: 'openProgress', target: RuntimeAwareDeployTarget): void;
}>();

const tableAreaRef = ref<HTMLElement>();
const { tableHeight: rawTableHeight, recalculateHeight } = useTableHeight(tableAreaRef, {
  minHeight: 240,
  defaultHeight: 420,
});

/** 限制表格最小高度，避免 hook 内部 availableHeight <= minHeight 时 fallback 到 0 的 Bug */
const tableHeight = computed(() => {
  return rawTableHeight.value > 240 ? rawTableHeight.value : 240;
});

/** 等待视图更新后重新计算表格高度 */
const recalculateAfterRender = async () => {
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
  if (projectType.value === 'backend') {
    const excludedFields = ['visitUrl', 'nginxInstanceName', 'listenPort', 'nginxServerName', 'nginxConfPath', 'uploadStrategy', 'preserveSubDirs', 'projectType'];
    return targetColumns.filter((col) => !excludedFields.includes(col.field || ''));
  } else if (projectType.value === 'frontend') {
    const excludedFields = ['projectType', 'serviceRole', 'serverPort', 'serviceLinks'];
    return targetColumns.filter((col) => !excludedFields.includes(col.field || ''));
  }
  return targetColumns;
});
</script>

<template>
  <div class="nginx-deploy-tab-pane">
    <DeployTargetFilterBar
      :loading="loading"
      :filter-form="filterForm"
      :branch-options="branchOptions"
      :server-options="serverOptions"
      @update:filter-form="handleFilterFormUpdate"
      @search="emit('search')"
      @reset="emit('reset')"
    />
    <div ref="tableAreaRef" class="nginx-deploy-table-area">
      <YTable
        :data="targets"
        :columns="activeColumns"
        :loading="loading"
        :action-config="actionConfig"
        :max-height="tableHeight"
        :cell-config="{ height: 58 }"
        :header-height="42"
        :pageable="false"
        size="small"
        id="nginx-deploy-targets"
      >
        <template #projectName="{ row }">
          <NginxProjectNameCell :record="row" />
        </template>
        <template #defaultBranch="{ row }">
          <a-tooltip :title="row.defaultBranch || '-'">
            <a-tag class="branch-tag">{{ row.defaultBranch || '-' }}</a-tag>
          </a-tooltip>
        </template>
        <template #runtimeStatus="{ row }">
          <DeployTargetRuntimeCell :record="row" @click="emit('openProgress', row)" />
        </template>
        <template #visitUrl="{ row }">
          <a v-if="row.visitUrl" :href="row.visitUrl" class="visit-link" @click.prevent.stop="openExternal(row.visitUrl)">
            {{ row.visitUrl }}
          </a>
          <span v-else>-</span>
        </template>
        <template #serviceLinks="{ row }">
          <div v-if="row.projectType === 'backend'" class="service-links">
            <a v-if="row.directUrl" :href="row.directUrl" @click.prevent.stop="openExternal(row.directUrl)">直连</a>
            <a v-if="row.gatewayUrl" :href="row.gatewayUrl" @click.prevent.stop="openExternal(row.gatewayUrl)">Gateway</a>
            <a v-if="row.nacosConsoleUrl" :href="row.nacosConsoleUrl" @click.prevent.stop="openExternal(row.nacosConsoleUrl)">
              Nacos{{ row.nacosStatus === 'online' ? ' · 在线' : row.nacosStatus === 'offline' ? ' · 离线' : '' }}
            </a>
            <span v-if="!row.directUrl && !row.gatewayUrl && !row.nacosConsoleUrl">-</span>
          </div>
          <span v-else>-</span>
        </template>
      </YTable>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
