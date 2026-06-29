<script setup lang="ts">
import { RocketOutlined, EyeOutlined, CloudUploadOutlined } from '@ant-design/icons-vue';
import type { GitLabProject, GroupTreeNode } from '@/api/gitlab';

defineOptions({ name: 'ProjectActions' });

const props = defineProps<{
  record: GitLabProject | GroupTreeNode;
}>();

const emit = defineEmits<{
  (e: 'openGitOps', record: GitLabProject): void;
  (e: 'viewCode', record: GitLabProject): void;
  (e: 'openNginxDeploy', record: GitLabProject): void;
}>();

/**
 * 判断当前行是否为 GitLab 分组。
 * @returns 是否为分组
 */
const isGroupRow = () => 'isGroup' in props.record && props.record.isGroup;
</script>

<template>
  <div v-if="!isGroupRow()" class="actions-cell">
    <a-tooltip title="配置 GitOps" placement="top">
      <a-button type="text" class="action-btn action-btn-primary" @click="emit('openGitOps', record as GitLabProject)">
        <RocketOutlined />
      </a-button>
    </a-tooltip>
    <a-tooltip title="查看代码" placement="top">
      <a-button type="text" class="action-btn action-btn-default" @click="emit('viewCode', record as GitLabProject)">
        <EyeOutlined />
      </a-button>
    </a-tooltip>
    <a-tooltip title="独立服务器部署" placement="top">
      <a-button type="text" class="action-btn action-btn-primary" @click="emit('openNginxDeploy', record as GitLabProject)">
        <CloudUploadOutlined />
      </a-button>
    </a-tooltip>
  </div>
</template>

<style scoped lang="less">
@import './project-actions.less';
</style>
