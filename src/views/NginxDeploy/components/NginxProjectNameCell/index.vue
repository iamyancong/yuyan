<script setup lang="ts">
import { FileTextOutlined } from '@ant-design/icons-vue';
import type { DeployTarget } from '@/api/deploy';
import { openExternal } from '@/utils/open';
import { getProjectDescription } from './constant';

defineOptions({ name: 'NginxProjectNameCell' });

const props = defineProps<{
  record: DeployTarget;
}>();
</script>

<template>
  <div class="nginx-project-name-cell">
    <span class="nginx-project-name-cell__icon">
      <FileTextOutlined />
    </span>
    <span class="nginx-project-name-cell__main">
      <a-tooltip :title="props.record.repositoryUrl || props.record.projectPath || props.record.projectName">
        <a
          v-if="props.record.repositoryUrl"
          class="nginx-project-name-cell__link"
          :href="props.record.repositoryUrl"
          @click.prevent.stop="openExternal(props.record.repositoryUrl)"
        >
          <span class="nginx-project-name-cell__name">{{ props.record.projectName }}</span>
        </a>
        <span v-else class="nginx-project-name-cell__name">{{ props.record.projectName }}</span>
      </a-tooltip>
      <a-tooltip :title="getProjectDescription(props.record)">
        <span class="nginx-project-name-cell__description">{{ getProjectDescription(props.record) }}</span>
      </a-tooltip>
    </span>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
