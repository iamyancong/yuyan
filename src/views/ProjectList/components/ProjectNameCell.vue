<script setup lang="ts">
import { FolderOutlined, FileTextOutlined, PlusOutlined, MinusOutlined, CopyOutlined } from '@ant-design/icons-vue';
import { copyToClipboard } from '@yss-ui/utils';
import message from 'ant-design-vue/es/message';
import type { GitLabProject, GroupTreeNode } from '@/api/gitlab';

defineOptions({ name: 'ProjectNameCell' });

const props = defineProps<{
  record: GitLabProject | GroupTreeNode;
}>();

const emit = defineEmits<{
  (e: 'toggleGroup', record: GroupTreeNode): void;
}>();

/**
 * 判断当前行是否为 GitLab 分组。
 * @param record - 当前行数据
 * @returns 是否为分组
 */
const isGroupRow = (record: GitLabProject | GroupTreeNode) => 'isGroup' in record && record.isGroup;

/**
 * 获取项目或分组的完整路径。
 * @param record - 当前行数据
 * @returns 完整路径文本
 */
const getProjectPath = (record: GitLabProject | GroupTreeNode) => {
  if ('path_with_namespace' in record) return record.path_with_namespace || record.path || record.name;
  return record.full_path || record.name;
};

/**
 * 获取项目描述。
 * @param record - 当前行数据
 * @returns 项目描述文本
 */
const getProjectDescription = (record: GitLabProject | GroupTreeNode) => {
  if ('description' in record && record.description) return record.description;
  return isGroupRow(record) ? `分组：${getProjectPath(record)}` : '-';
};

/**
 * 获取可见性标签颜色。
 * @param visibility - GitLab 可见性
 * @returns 标签颜色
 */
const getVisibilityColor = (visibility: string) => {
  const colors: Record<string, string> = { public: 'green', internal: 'blue', private: 'orange' };
  return colors[visibility] || 'default';
};

/**
 * 获取当前行头像地址。
 * @param record - 当前行数据
 * @returns 头像地址
 */
const getAvatarUrl = (record: GitLabProject | GroupTreeNode) => {
  if (isGroupRow(record)) return (record as GroupTreeNode).avatar_url;
  return (record as GitLabProject).owner?.avatar_url;
};

/**
 * 获取分组展开状态。
 * @param record - 当前行数据
 * @returns 是否展开
 */
const getGroupExpanded = (record: GitLabProject | GroupTreeNode) => {
  if (!isGroupRow(record)) return false;
  return Boolean((record as GroupTreeNode).isExpanded);
};

/**
 * 切换分组展开状态。
 */
const handleToggleGroup = () => {
  if (!isGroupRow(props.record)) return;
  emit('toggleGroup', props.record as GroupTreeNode);
};

/**
 * 复制项目名称。
 */
const copyProjectName = async () => {
  const copied = await copyToClipboard(props.record.name);

  if (copied) {
    message.success('项目名称已复制到剪贴板');
    return;
  }

  message.error('复制失败');
};
</script>

<template>
  <div :class="['project-name-cell', { 'project-name-cell--group': isGroupRow(record) }]">
    <a-button v-if="isGroupRow(record)" type="text" size="small" class="group-toggle-btn" @click="handleToggleGroup">
      <template #icon><component :is="getGroupExpanded(record) ? MinusOutlined : PlusOutlined" /></template>
    </a-button>
    <span class="project-name-icon">
      <a-avatar v-if="getAvatarUrl(record)" :src="getAvatarUrl(record)" :size="26" />
      <FolderOutlined v-else-if="isGroupRow(record)" />
      <FileTextOutlined v-else />
    </span>
    <span class="project-name-main">
      <a-tooltip :title="getProjectPath(record)">
        <a :href="record.web_url" target="_blank" rel="noopener noreferrer" class="project-name-link">{{ record.name }}</a>
      </a-tooltip>
      <a-tooltip :title="getProjectDescription(record)">
        <span class="project-name-desc">{{ getProjectDescription(record) }}</span>
      </a-tooltip>
    </span>
    <!-- <a-tag :color="getVisibilityColor(record.visibility)" class="visibility-tag">{{ record.visibility || '-' }}</a-tag> -->
    <a-tooltip title="复制项目名称">
      <a-button type="text" size="small" class="copy-btn" @click="copyProjectName">
        <template #icon><CopyOutlined /></template>
      </a-button>
    </a-tooltip>
  </div>
</template>

<style scoped lang="less">
@import './project-name-cell.less';
</style>
