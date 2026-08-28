<script setup lang="ts">
import type { DeployRecord } from '@/api/deploy';
import { openExternal } from '@/utils/open';
import { getCommitMessageText, getShortCommitSha } from './constant';

defineOptions({ name: 'DeployCommitMessageCell' });

/** 提交信息单元格属性 */
interface DeployCommitMessageCellProps {
  /** 发布记录 */
  record: DeployRecord;
  /** GitLab 提交详情链接 */
  commitUrl?: string;
}

const props = defineProps<DeployCommitMessageCellProps>();
</script>

<template>
  <div class="deploy-commit-message-cell">
    <!-- 第一行：提交信息 -->
    <a-tooltip :title="getCommitMessageText(props.record)">
      <a
        v-if="props.commitUrl"
        class="deploy-commit-message-cell__message"
        :href="props.commitUrl"
        @click.prevent.stop="openExternal(props.commitUrl)"
      >
        {{ getCommitMessageText(props.record) }}
      </a>
      <span v-else class="deploy-commit-message-cell__message deploy-commit-message-cell__message--text">
        {{ getCommitMessageText(props.record) }}
      </span>
    </a-tooltip>

    <!-- 第二行：短 Commit 与当前版本标签 -->
    <div class="deploy-commit-message-cell__meta">
      <a
        v-if="props.commitUrl"
        class="deploy-commit-message-cell__sha deploy-commit-message-cell__sha--link"
        :href="props.commitUrl"
        @click.prevent.stop="openExternal(props.commitUrl)"
      >
        {{ getShortCommitSha(props.record) }}
      </a>
      <span v-else class="deploy-commit-message-cell__sha">
        {{ getShortCommitSha(props.record) }}
      </span>
      <a-tag v-if="props.record.isCurrentVersion" color="processing" class="deploy-commit-message-cell__tag">
        当前
      </a-tag>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
