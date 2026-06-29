<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { YCard, YTable } from '@ycwang-dev/components/lite';
import { useTableHeight } from '@ycwang-dev/hooks';
import type { YTableActionConfig } from '@ycwang-dev/components/lite';
import type { DeployServer } from '@/api/deploy';
import { serverColumns } from '../../constant';

defineOptions({ name: 'DeployServerTab' });

/** 表格默认高度 */
const TABLE_DEFAULT_HEIGHT = 420;

/** 表格最小高度 */
const TABLE_MIN_HEIGHT = 240;

/** 服务器管理 Tab 属性 */
interface DeployServerTabProps {
  loading: boolean;
  servers: DeployServer[];
  actionConfig: YTableActionConfig;
}

const props = defineProps<DeployServerTabProps>();

const tableAreaRef = ref<HTMLElement>();
const { tableHeight, recalculateHeight } = useTableHeight(tableAreaRef, {
  minHeight: TABLE_MIN_HEIGHT,
  defaultHeight: TABLE_DEFAULT_HEIGHT,
});

/** 等待视图更新后重新计算表格高度 */
const recalculateAfterRender = async () => {
  await nextTick();
  recalculateHeight();
};

watch([() => props.loading, () => props.servers.length], recalculateAfterRender, { flush: 'post' });
</script>

<template>
  <YCard class="nginx-deploy-tab-card" :padding="12">
    <div ref="tableAreaRef" class="nginx-deploy-table-area">
      <YTable
        :data="servers"
        :columns="serverColumns"
        :loading="loading"
        :action-config="actionConfig"
        :max-height="tableHeight"
        :pageable="false"
        size="small"
        id="nginx-deploy-servers"
      />
    </div>
  </YCard>
</template>

<style scoped lang="less">
@import './style.less';
</style>
