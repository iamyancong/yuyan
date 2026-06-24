<script setup lang="ts">
import { reactive, watch } from 'vue';
import { YButton } from '@yss-ui/components/lite';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons-vue';
import type { ProjectSearchParams } from '@/api/gitlab';

defineOptions({ name: 'ProjectSearchForm' });

const props = defineProps<{ modelValue: ProjectSearchParams; loading?: boolean }>();
const emit = defineEmits<{
  (e: 'update:modelValue', v: ProjectSearchParams): void;
  (e: 'submit'): void;
  (e: 'reset'): void;
  (e: 'refresh'): void;
}>();

const localForm = reactive<ProjectSearchParams>({ ...(props.modelValue || {}) });

watch(
  () => props.modelValue,
  (val) => {
    if (!val) return;
    Object.assign(localForm, val);
  },
  { deep: true }
);

const onSubmit = () => {
  emit('update:modelValue', { ...localForm });
  emit('submit');
};

const onReset = () => {
  emit('reset');
};

const onRefresh = () => emit('refresh');
</script>

<template>
  <div class="search-form">
    <a-form :model="localForm" layout="inline" @submit.prevent="onSubmit">
      <a-form-item label="项目名称">
        <a-input v-model:value="localForm.search" placeholder="搜索项目名称或描述" class="search-input" allow-clear />
      </a-form-item>

      <!-- <a-form-item label="项目ID">
        <a-input v-model:value="localForm.id" placeholder="项目ID" style="width: 120px"  />
      </a-form-item> -->

      <a-form-item label="可见性">
        <a-select v-model:value="localForm.visibility" placeholder="选择可见性" class="visibility-select" allow-clear>
          <a-select-option value="public">公开</a-select-option>
          <a-select-option value="internal">内部</a-select-option>
          <a-select-option value="private">私有</a-select-option>
        </a-select>
      </a-form-item>

      <!-- <a-form-item label="创建者">
        <a-input v-model:value="(localForm as any).creator" placeholder="创建者用户名" style="width: 150px" allow-clear />
      </a-form-item> -->

      <a-form-item>
        <a-space>
          <YButton type="primary" html-type="submit" :loading="props.loading">
            <template #icon><SearchOutlined /></template>
            搜索
          </YButton>
          <YButton @click="onReset">重置</YButton>
          <YButton @click="onRefresh">
            <template #icon><ReloadOutlined /></template>
            刷新
          </YButton>
        </a-space>
      </a-form-item>
    </a-form>
  </div>
</template>

<style scoped lang="less">
@import './search-form.less';
</style>
