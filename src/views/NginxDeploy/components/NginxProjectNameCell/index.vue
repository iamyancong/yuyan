<script setup lang="ts">
import type { DeployRecord, DeployTarget } from '@/api/deploy';
import { openExternal } from '@/utils/open';
import { getProjectDescription } from './constant';
import ProjectTypeIcon from '../ProjectTypeIcon/index.vue';

defineOptions({ name: 'NginxProjectNameCell' });

const props = defineProps<{
  record: DeployTarget | DeployRecord;
}>();
</script>

<template>
  <div class="nginx-project-name-cell">
    <ProjectTypeIcon :type="props.record.projectType" />
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
