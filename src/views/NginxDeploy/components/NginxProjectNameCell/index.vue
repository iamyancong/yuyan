<script setup lang="ts">
import { computed } from 'vue';
import { ExportOutlined } from '@ant-design/icons-vue';
import type { DeployRecord, DeployTarget } from '@/api/deploy';
import { openExternal } from '@/utils/open';
import { getProjectDescription } from './constant';
import { getSiteReadinessStatus } from '../DeployTargetSiteSummaryCell/constant';
import ProjectTypeIcon from '../ProjectTypeIcon/index.vue';

defineOptions({ name: 'NginxProjectNameCell' });

const props = defineProps<{
  record: DeployTarget | DeployRecord;
  /** 是否在项目名称列显示可访问状态 */
  showAccessStatus?: boolean;
}>();

const siteMeta = computed(() => (props.showAccessStatus ? getSiteReadinessStatus(props.record as DeployTarget) : null));

/** 名称悬浮提示第二行：仓库地址或项目路径（名称被省略时仍能看到完整名称） */
const nameTooltipSubtitle = computed(() => {
  const sub = String(props.record.repositoryUrl || props.record.projectPath || '').trim();
  return sub && sub !== props.record.projectName ? sub : '';
});

/** 打开部署目标的页面访问地址。 */
const handleOpenVisit = () => {
  if (siteMeta.value?.isAccessible && siteMeta.value.visitUrl) {
    openExternal(siteMeta.value.visitUrl);
  }
};
</script>

<template>
  <div class="nginx-project-name-cell">
    <ProjectTypeIcon :type="props.record.projectType" />
    <div class="nginx-project-name-cell__main">
      <a-tooltip>
        <template #title>
          <div>{{ props.record.projectName }}</div>
          <div v-if="nameTooltipSubtitle" class="nginx-project-name-cell__tooltip-sub">{{ nameTooltipSubtitle }}</div>
        </template>
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
      <div class="nginx-project-name-cell__meta">
        <a-tooltip v-if="siteMeta?.isAccessible" :title="siteMeta.visitUrl">
          <a-tag class="nginx-project-name-cell__access-tag" color="success" @click.stop="handleOpenVisit">
            可访问
            <ExportOutlined />
          </a-tag>
        </a-tooltip>
        <a-tooltip :title="getProjectDescription(props.record)">
          <span class="nginx-project-name-cell__description">{{ getProjectDescription(props.record) }}</span>
        </a-tooltip>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
