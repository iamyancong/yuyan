<script setup lang="ts">
import { computed } from 'vue';
import { PullRequestOutlined } from '@ant-design/icons-vue';

defineOptions({ name: 'MRInfoPanel' });

/** 属性定义 */
const props = defineProps<{
  /** MR 标题 */
  mrTitle: string;
  /** MR 描述 */
  mrDescription: string;
}>();

/** 事件定义 */
const emit = defineEmits<{
  'update:mrTitle': [value: string];
  'update:mrDescription': [value: string];
}>();

/** 计算属性 */
const vMrTitle = computed({
  get: () => props.mrTitle,
  set: (v) => emit('update:mrTitle', v),
});

const vMrDescription = computed({
  get: () => props.mrDescription,
  set: (v) => emit('update:mrDescription', v),
});
</script>

<template>
  <a-collapse :bordered="false" :default-active-key="[]" style="margin-bottom: 8px">
    <a-collapse-panel key="mr-info" :style="{ borderBottom: 'none' }">
      <template #header>
        <span style="font-size: 13px; font-weight: 500">
          <pull-request-outlined style="margin-right: 4px" />
          MR 信息（可选）
        </span>
      </template>

      <a-form layout="vertical" class="compact-form">
        <a-row :gutter="[8, 4]">
          <!-- MR 标题 -->
          <a-col :xs="24" :sm="24" :md="12" :lg="12" :xl="12" :xxl="12">
            <a-form-item label="MR 标题">
              <a-input v-model:value="vMrTitle" size="small" />
            </a-form-item>
          </a-col>

          <!-- MR 描述 -->
          <a-col :xs="24" :sm="24" :md="12" :lg="12" :xl="12" :xxl="12">
            <a-form-item label="MR 描述">
              <a-textarea v-model:value="vMrDescription" :rows="1" />
            </a-form-item>
          </a-col>
        </a-row>
      </a-form>
    </a-collapse-panel>
  </a-collapse>
</template>
<style scoped lang="less">
@import '../style.less';
</style>
