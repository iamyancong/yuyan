<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { SearchOutlined } from '@ant-design/icons-vue';
import { YButton, YCard, YTable } from '@ycwang-dev/components/lite';
import { openExternal } from '@/utils/open';
import { useTableHeight } from '@ycwang-dev/hooks';
import type { YTableActionConfig } from '@ycwang-dev/components/lite';
import type { RuntimeAwareDeployTarget, TargetFilterForm } from '../../types';
import { targetColumns } from '../../constant';
import NginxProjectNameCell from '../NginxProjectNameCell/index.vue';
import DeployTargetRuntimeCell from '../DeployTargetRuntimeCell/index.vue';

defineOptions({ name: 'DeployTargetTab' });

/** 下拉选项 */
interface SelectOption {
  label: string;
  value: string | number;
}

/** 部署目标 Tab 属性 */
interface DeployTargetTabProps {
  loading: boolean;
  repairLoading: boolean;
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
  (e: 'repairNginxBindings'): void;
}>();

const tableAreaRef = ref<HTMLElement>();
const { tableHeight, recalculateHeight } = useTableHeight(tableAreaRef, {
  minHeight: 240,
  defaultHeight: 420,
});

/** 项目关键字双向绑定 */
const projectKeyword = computed({
  get: () => props.filterForm.projectKeyword,
  set: (value: string) => emit('update:filterForm', { ...props.filterForm, projectKeyword: value }),
});

/** 分支筛选双向绑定 */
const branch = computed({
  get: () => props.filterForm.branch,
  set: (value?: string) => emit('update:filterForm', { ...props.filterForm, branch: value }),
});

/** 服务器筛选双向绑定 */
const serverId = computed({
  get: () => props.filterForm.serverId,
  set: (value?: number) => emit('update:filterForm', { ...props.filterForm, serverId: value, branch: undefined }),
});

/** 等待视图更新后重新计算表格高度 */
const recalculateAfterRender = async () => {
  await nextTick();
  recalculateHeight();
};

watch([() => props.loading, () => props.targets.length], recalculateAfterRender, { flush: 'post' });
</script>

<template>
  <YCard class="nginx-deploy-tab-card" :padding="12">
    <div class="target-filter-bar">
      <a-form
        layout="horizontal"
        :label-col="{ style: { width: '60px' } }"
        :wrapper-col="{ style: { flex: 1 } }"
        @submit.prevent="emit('search')"
      >
        <a-row :gutter="[16, 12]">
          <a-col :xs="24" :sm="24" :md="12" :xl="6">
            <a-form-item label="项目" class="target-filter-item">
              <a-input
                v-model:value="projectKeyword"
                class="target-filter-bar__project"
                placeholder="搜索项目名称、路径或备注"
                allow-clear
              />
            </a-form-item>
          </a-col>
          <a-col :xs="24" :sm="24" :md="12" :xl="5">
            <a-form-item label="分支" class="target-filter-item">
              <a-select
                v-model:value="branch"
                class="target-filter-bar__branch"
                :options="branchOptions"
                placeholder="全部分支"
                allow-clear
                show-search
                option-filter-prop="label"
                @change="emit('search')"
              />
            </a-form-item>
          </a-col>
          <a-col :xs="24" :sm="24" :md="12" :xl="5">
            <a-form-item label="服务器" class="target-filter-item">
              <a-select
                v-model:value="serverId"
                class="target-filter-bar__server"
                :options="serverOptions"
                placeholder="请选择服务器"
                show-search
                option-filter-prop="label"
                @change="emit('search')"
              />
            </a-form-item>
          </a-col>
          <a-col :xs="24" :sm="24" :md="12" :xl="8" class="target-filter-bar__actions">
            <a-space>
              <YButton type="primary" html-type="submit" :loading="loading">
                <template #icon><SearchOutlined /></template>
                查询
              </YButton>
              <YButton @click="emit('reset')">重置</YButton>
              <YButton :loading="repairLoading" @click="emit('repairNginxBindings')">修复 Nginx 关联</YButton>
            </a-space>
          </a-col>
        </a-row>
      </a-form>
    </div>
    <div ref="tableAreaRef" class="nginx-deploy-table-area">
      <YTable
        :data="targets"
        :columns="targetColumns"
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
          <DeployTargetRuntimeCell :record="row" />
        </template>
        <template #visitUrl="{ row }">
          <a v-if="row.visitUrl" :href="row.visitUrl" class="visit-link" @click.prevent.stop="openExternal(row.visitUrl)">
            {{ row.visitUrl }}
          </a>
          <span v-else>-</span>
        </template>
      </YTable>
    </div>
  </YCard>
</template>

<style scoped lang="less">
@import './style.less';
</style>
