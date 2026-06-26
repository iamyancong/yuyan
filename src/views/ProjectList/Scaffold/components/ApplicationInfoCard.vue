<script setup lang="ts">
import type { CreateMicroAppPayload } from '@/api/scaffold';
import { SCAFFOLD_TIPS } from '../constant';

/** 框架下拉选项。 */
interface FrameworkOption {
  label: string;
  value: string;
  disabled?: boolean;
}

/** 应用信息卡片属性。 */
interface ApplicationInfoCardProps {
  form: CreateMicroAppPayload & { gitlabToken: string };
  frameworkOptions: FrameworkOption[];
}

defineProps<ApplicationInfoCardProps>();
</script>

<template>
  <a-card
    class="section-card"
    title="应用信息"
    :head-style="{ background: 'transparent' }"
    :body-style="{ background: 'transparent' }"
  >
    <a-row :gutter="[16, 16]">
      <a-col :xs="24" :sm="24" :md="12" :lg="12" :xl="12" :xxl="12">
        <a-form-item name="framework" label="框架" :tooltip="SCAFFOLD_TIPS.framework">
          <a-select v-model:value="form.framework" :options="frameworkOptions" popup-class-name="project-select-dropdown" />
        </a-form-item>
      </a-col>
      <a-col :xs="24" :sm="24" :md="12" :lg="12" :xl="12" :xxl="12">
        <a-form-item name="appName" label="微应用英文名称" required :tooltip="SCAFFOLD_TIPS.appName">
          <a-input v-model:value="form.appName" placeholder="如: yss-datamiddle-data-service" />
        </a-form-item>
      </a-col>
      <a-col :xs="24" :sm="24" :md="12" :lg="12" :xl="12" :xxl="12">
        <a-form-item name="appNameZh" label="微应用中文名称" required :tooltip="SCAFFOLD_TIPS.appNameZh">
          <a-input v-model:value="form.appNameZh" placeholder="如: 新一代数据服务管理系统" />
        </a-form-item>
      </a-col>
      <a-col :xs="24" :sm="24" :md="12" :lg="12" :xl="12" :xxl="12">
        <a-form-item label="项目描述" :tooltip="SCAFFOLD_TIPS.description">
          <a-textarea v-model:value="form.description" placeholder="项目描述信息（可选）" :rows="2" />
        </a-form-item>
      </a-col>
      <a-col :xs="24" :sm="24" :md="12" :lg="12" :xl="12" :xxl="12">
        <a-form-item label="端口" :tooltip="SCAFFOLD_TIPS.port">
          <a-input-number v-model:value="form.port" :min="1" :max="65535" style="width: 100%" />
        </a-form-item>
      </a-col>
      <a-col :xs="24" :sm="24" :md="12" :lg="12" :xl="12" :xxl="12">
        <a-form-item name="activeRule" label="激活路由前缀" :tooltip="SCAFFOLD_TIPS.activeRule">
          <a-input v-model:value="form.activeRule" placeholder="如: /dataService（以 / 开头，且仅一段路径；允许驼峰或短横线）" />
        </a-form-item>
      </a-col>
      <a-col :xs="24" :sm="24" :md="12" :lg="12" :xl="12" :xxl="12">
        <a-form-item label="接口 Base" :tooltip="SCAFFOLD_TIPS.apiBase">
          <a-input v-model:value="form.apiBase" placeholder="如: /api" />
        </a-form-item>
      </a-col>
      <a-col :xs="24" :sm="24" :md="12" :lg="12" :xl="12" :xxl="12">
        <a-form-item label="代理目标" :tooltip="SCAFFOLD_TIPS.proxyTarget">
          <a-input v-model:value="form.proxyTarget" placeholder="如: http://127.0.0.1:3000" />
        </a-form-item>
      </a-col>
    </a-row>
  </a-card>
</template>

<style scoped lang="less">
@import '../style.less';
</style>
