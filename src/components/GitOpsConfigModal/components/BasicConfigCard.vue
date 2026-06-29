<script setup lang="ts">
import { computed } from 'vue';
import { InfoCircleOutlined, CheckCircleOutlined } from '@ant-design/icons-vue';
import type { AutoCompleteOption } from '../constant';
import { filterDirOption } from '../constant';
import type { SimilarDirectory } from '../hooks/useDirectoryMatcher';

defineOptions({ name: 'BasicConfigCard' });

/** 属性定义 */
const props = defineProps<{
  /** 分支列表 */
  branches: string[];
  /** 当前选中的分支 */
  selectedBranch: string;
  /** 目录选项列表 */
  dirOptions: string[];
  /** 自定义目录名 */
  customDirName: string;
  /** 相似目录建议 */
  suggestedDir: SimilarDirectory | null;
  /** 是否使用 MR 提交 */
  useMergeRequest: boolean;
  /** 新分支名称 */
  newBranchName: string;
}>();

/** 事件定义 */
const emit = defineEmits<{
  'update:selectedBranch': [value: string];
  'update:customDirName': [value: string];
  'update:useMergeRequest': [value: boolean];
  'update:newBranchName': [value: string];
  'branch-change': [];
}>();

/** 计算属性 */
const vSelectedBranch = computed({
  get: () => props.selectedBranch,
  set: (v) => emit('update:selectedBranch', v),
});

const vCustomDirName = computed({
  get: () => props.customDirName,
  set: (v) => emit('update:customDirName', v),
});

const vUseMergeRequest = computed({
  get: () => props.useMergeRequest,
  set: (v) => emit('update:useMergeRequest', v),
});

const vNewBranchName = computed({
  get: () => props.newBranchName,
  set: (v) => emit('update:newBranchName', v),
});

/** 处理分支变更 */
const handleBranchChange = () => {
  emit('branch-change');
};

/** 应用建议目录 */
const applySuggestion = () => {
  if (props.suggestedDir) {
    vCustomDirName.value = props.suggestedDir.dir;
  }
};
</script>

<template>
  <a-form layout="vertical" class="compact-form">
    <a-row :gutter="[8, 4]">
      <!-- MR 提交开关 -->
      <a-col :xs="24" :sm="24" :md="12" :lg="8" :xl="8" :xxl="8">
        <a-form-item label="通过 MR 提交">
          <a-switch v-model:checked="vUseMergeRequest" />
          <span style="margin-left: 8px; color: var(--text-color-secondary)"> 关闭将直接推送到目标分支（管理员） </span>
        </a-form-item>
      </a-col>

      <!-- 目标分支 -->
      <a-col :xs="24" :sm="24" :md="12" :lg="8" :xl="8" :xxl="8">
        <a-form-item label="目标分支">
          <a-select
            v-model:value="vSelectedBranch"
            :options="branches.map((b) => ({ label: b, value: b }))"
            size="small"
            @change="handleBranchChange"
          />
        </a-form-item>
      </a-col>

      <!-- 新分支名称（仅 MR 模式） -->
      <a-col v-if="useMergeRequest" :xs="24" :sm="24" :md="12" :lg="8" :xl="8" :xxl="8">
        <a-form-item label="新分支名称">
          <a-input v-model:value="vNewBranchName" size="small" placeholder="如: feature/gitops-xxx-20250101-120000" />
        </a-form-item>
      </a-col>

      <!-- 目录名 -->
      <a-col :xs="24" :sm="24" :md="24" :lg="16" :xl="16" :xxl="16">
        <a-form-item label="目录名">
          <div class="dir-input-wrapper">
            <a-auto-complete
              v-model:value="vCustomDirName"
              :options="dirOptions.map((d) => ({ value: d }))"
              option-filter-prop="value"
              :filter-option="filterDirOption"
              allow-clear
              size="small"
              :maxlength="63"
              placeholder="可选：输入或选择已有目录名（默认自动生成）"
              :style="suggestedDir ? { paddingRight: '90px' } : {}"
            />

            <!-- 智能匹配提示 - 紧凑版 -->
            <a-tooltip v-if="suggestedDir" placement="topRight">
              <template #title>
                <div>
                  检测到相似目录: <strong>{{ suggestedDir.dir }}</strong>
                  <div style="margin-top: 4px; font-size: 12px">
                    {{ customDirName === suggestedDir.dir ? '✓ 已应用' : '点击应用建议' }}
                  </div>
                </div>
              </template>
              <div class="smart-suggestion-badge" @click="applySuggestion">
                <check-circle-outlined v-if="customDirName === suggestedDir.dir" style="color: #52c41a" />
                <info-circle-outlined v-else />
                <span>{{ customDirName === suggestedDir.dir ? '已应用' : '建议' }}</span>
              </div>
            </a-tooltip>
          </div>
        </a-form-item>
      </a-col>
    </a-row>
  </a-form>
</template>
<style scoped lang="less">
@import '../style.less';
</style>
