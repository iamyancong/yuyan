<script setup lang="ts">
import { computed } from 'vue';
import { SearchOutlined } from '@ant-design/icons-vue';
import { YButton } from '@yss-ui/components/lite';
import type { TargetFilterForm } from '../../../types';

defineOptions({ name: 'DeployTargetFilterBar' });

/**
 * 下拉选项接口
 */
interface SelectOption {
  label: any;
  value: string | number;
  /** 悬浮显示的全文，文字过长被省略时可看到 */
  title?: string;
  searchKey?: string;
}

/**
 * 部署目标筛选栏属性
 */
interface DeployTargetFilterBarProps {
  /** 查询加载状态 */
  loading: boolean;
  /** 筛选表单数据 */
  filterForm: TargetFilterForm;
  /** 分支下拉选项 */
  branchOptions: SelectOption[];
  /** 服务器下拉选项 */
  serverOptions: SelectOption[];
  /** Nginx 实例下拉选项（跟随所选服务器） */
  instanceOptions?: SelectOption[];
  /** 是否展示实例筛选（后端项目隐藏） */
  showInstanceFilter?: boolean;
}

const props = defineProps<DeployTargetFilterBarProps>();

const emit = defineEmits<{
  /** 更新筛选表单值 */
  (e: 'update:filterForm', value: TargetFilterForm): void;
  /** 触发搜索查询 */
  (e: 'search'): void;
  /** 触发重置筛选 */
  (e: 'reset'): void;
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
  set: (value?: number) => emit('update:filterForm', { ...props.filterForm, serverId: value, branch: undefined, nginxInstanceId: undefined }),
});

/** Nginx 实例计算属性 */
const nginxInstanceId = computed({
  get: () => props.filterForm.nginxInstanceId,
  set: (value?: number) => emit('update:filterForm', { ...props.filterForm, nginxInstanceId: value }),
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
              @pressEnter="emit('search')"
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
              :list-height="280"
              :list-item-height="56"
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
              :list-height="280"
              :list-item-height="56"
              popup-class-name="project-select-dropdown"
              @change="emit('search')"
            />
          </a-form-item>
        </a-col>
        <a-col v-if="showInstanceFilter" :xs="24" :sm="12" :md="12" :xl="4">
          <a-form-item label="实例" class="target-filter-item">
            <a-select
              v-model:value="nginxInstanceId"
              class="target-filter-bar__instance project-select"
              :options="instanceOptions || []"
              placeholder="全部 Nginx 实例"
              allow-clear
              show-search
              option-filter-prop="searchKey"
              option-label-prop="title"
              :dropdown-match-select-width="300"
              :list-height="280"
              :list-item-height="56"
              popup-class-name="project-select-dropdown"
              :not-found-content="'该服务器暂无 Nginx 实例'"
              @change="emit('search')"
            />
          </a-form-item>
        </a-col>
        <a-col :xs="24" :sm="12" :md="12" :xl="showInstanceFilter ? 4 : 8" class="target-filter-bar__actions">
          <a-space class="action-space">
            <YButton type="primary" html-type="submit" :loading="loading" @click="emit('search')">
              <template #icon><SearchOutlined /></template>
              查询
            </YButton>
            <YButton @click="emit('reset')">重置</YButton>
          </a-space>
        </a-col>
      </a-row>
    </a-form>
  </div>
</template>
