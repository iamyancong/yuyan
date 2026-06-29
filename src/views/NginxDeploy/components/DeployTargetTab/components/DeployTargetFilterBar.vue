<script setup lang="ts">
import { computed } from 'vue';
import { SearchOutlined } from '@ant-design/icons-vue';
import { YButton } from '@ycwang-dev/components/lite';
import type { TargetFilterForm } from '../../../types';

defineOptions({ name: 'DeployTargetFilterBar' });

/**
 * 下拉选项接口
 */
interface SelectOption {
  label: string;
  value: string | number;
}

/**
 * 部署目标筛选栏属性
 */
interface DeployTargetFilterBarProps {
  /** 查询加载状态 */
  loading: boolean;
  /** 修复 Nginx 绑定加载状态 */
  repairLoading: boolean;
  /** 筛选表单数据 */
  filterForm: TargetFilterForm;
  /** 分支下拉选项 */
  branchOptions: SelectOption[];
  /** 服务器下拉选项 */
  serverOptions: SelectOption[];
}

const props = defineProps<DeployTargetFilterBarProps>();

const emit = defineEmits<{
  /** 更新筛选表单值 */
  (e: 'update:filterForm', value: TargetFilterForm): void;
  /** 触发搜索查询 */
  (e: 'search'): void;
  /** 触发重置筛选 */
  (e: 'reset'): void;
  /** 触发修复 Nginx 关联 */
  (e: 'repairNginxBindings'): void;
}>();

/** 项目关键字计算属性 */
const projectKeyword = computed({
  get: () => props.filterForm.projectKeyword,
  set: (value: string) => emit('update:filterForm', { ...props.filterForm, projectKeyword: value }),
});

/** 分支计算属性 */
const branch = computed({
  get: () => props.filterForm.branch,
  set: (value?: string) => emit('update:filterForm', { ...props.filterForm, branch: value }),
});

/** 服务器计算属性 */
const serverId = computed({
  get: () => props.filterForm.serverId,
  set: (value?: number) => emit('update:filterForm', { ...props.filterForm, serverId: value, branch: undefined }),
});
</script>

<template>
  <div class="target-filter-bar">
    <a-form
      layout="horizontal"
      :label-col="{ style: { width: '60px' } }"
      :wrapper-col="{ style: { flex: 1 } }"
      @submit.prevent="emit('search')"
    >
      <a-row :gutter="[16, 12]" class="filter-row">
        <a-col :xs="24" :sm="12" :md="12" :xl="6">
          <a-form-item label="项目" class="target-filter-item">
            <a-input
              v-model:value="projectKeyword"
              class="target-filter-bar__project"
              placeholder="搜索项目名称、路径或备注"
              allow-clear
            />
          </a-form-item>
        </a-col>
        <a-col :xs="24" :sm="12" :md="12" :xl="5">
          <a-form-item label="分支" class="target-filter-item">
            <a-select
              v-model:value="branch"
              class="target-filter-bar__branch project-select"
              :options="branchOptions"
              placeholder="全部分支"
              allow-clear
              show-search
              :dropdown-match-select-width="300"
              option-filter-prop="searchKey"
              option-label-prop="title"
              popup-class-name="project-select-dropdown"
              @change="emit('search')"
            />
          </a-form-item>
        </a-col>
        <a-col :xs="24" :sm="12" :md="12" :xl="5">
          <a-form-item label="服务器" class="target-filter-item">
            <a-select
              v-model:value="serverId"
              class="target-filter-bar__server project-select"
              :options="serverOptions"
              placeholder="请选择服务器"
              show-search
              option-filter-prop="searchKey"
              option-label-prop="title"
              :dropdown-match-select-width="300"
              popup-class-name="project-select-dropdown"
              @change="emit('search')"
            />
          </a-form-item>
        </a-col>
        <a-col :xs="24" :sm="12" :md="12" :xl="8" class="target-filter-bar__actions">
          <a-space class="action-space">
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
</template>
