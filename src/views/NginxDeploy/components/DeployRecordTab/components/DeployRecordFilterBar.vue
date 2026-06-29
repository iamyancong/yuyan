<script setup lang="ts">
import { SyncOutlined } from '@ant-design/icons-vue';
import { YButton } from '@ycwang-dev/components/lite';
import type { RecordProjectOption, RecordServerOption } from '../../../types';

defineOptions({ name: 'DeployRecordFilterBar' });

/** 下拉选项 */
interface SelectOption {
  label: string;
  value: string;
}

/** 发布历史筛选栏属性 */
interface DeployRecordFilterBarProps {
  /** 刷新加载状态 */
  loading: boolean;
  /** 服务器筛选条件 */
  serverFilter?: number;
  /** 项目筛选条件 */
  projectFilter: string;
  /** 分支筛选条件 */
  branchFilter?: string;
  /** 服务器下拉选项 */
  serverOptions: RecordServerOption[];
  /** 项目下拉选项 */
  projectOptions: RecordProjectOption[];
  /** 分支下拉选项 */
  branchOptions: SelectOption[];
}

defineProps<DeployRecordFilterBarProps>();

const emit = defineEmits<{
  /** 服务器更改 */
  (e: 'serverChange', value?: number): void;
  /** 项目更改 */
  (e: 'projectChange', value: string): void;
  /** 分支更改 */
  (e: 'branchChange', value?: string): void;
  /** 触发刷新 */
  (e: 'refresh'): void;
}>();
</script>

<template>
  <div class="record-filter-bar">
    <a-form
      layout="horizontal"
      :label-col="{ style: { width: '60px' } }"
      :wrapper-col="{ style: { flex: 1 } }"
      class="record-filter-bar__form"
    >
      <a-row :gutter="[16, 12]" class="filter-row">
        <a-col :xs="24" :sm="12" :md="12" :xl="6">
          <a-form-item label="服务器" class="record-filter-item">
            <a-select
              :value="serverFilter"
              class="record-filter-bar__server-select project-select"
              :options="serverOptions"
              :disabled="!serverOptions.length"
              show-search
              option-filter-prop="searchKey"
              option-label-prop="title"
              placeholder="请选择服务器"
              :dropdown-match-select-width="300"
              popup-class-name="project-select-dropdown"
              @change="(value?: number) => emit('serverChange', value)"
            />
          </a-form-item>
        </a-col>
        <a-col :xs="24" :sm="12" :md="12" :xl="9">
          <a-form-item label="项目" class="record-filter-item">
            <a-select
              :value="projectFilter"
              class="record-filter-bar__select project-select"
              :options="projectOptions"
              :disabled="!projectOptions.length"
              show-search
              option-filter-prop="searchKey"
              option-label-prop="title"
              :dropdown-match-select-width="500"
              popup-class-name="project-select-dropdown"
              placeholder="请选择已配置项目"
              @change="(value: string) => emit('projectChange', value)"
            />
          </a-form-item>
        </a-col>
        <a-col :xs="24" :sm="12" :md="12" :xl="5">
          <a-form-item label="分支" class="record-filter-item">
            <a-select
              :value="branchFilter"
              class="record-filter-bar__branch-select project-select"
              :options="branchOptions"
              :disabled="!branchOptions.length"
              allow-clear
              show-search
              option-filter-prop="searchKey"
              option-label-prop="title"
              placeholder="全部分支"
              popup-class-name="project-select-dropdown"
              @change="(value?: string) => emit('branchChange', value)"
            />
          </a-form-item>
        </a-col>
        <a-col :xs="24" :sm="12" :md="12" :xl="4" class="record-filter-bar__actions">
          <YButton :loading="loading" @click="emit('refresh')">
            <template #icon>
              <SyncOutlined v-if="!loading" />
            </template>
            刷新
          </YButton>
        </a-col>
      </a-row>
    </a-form>
  </div>
</template>
