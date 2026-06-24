<script setup lang="ts">
import { ExclamationCircleOutlined } from '@ant-design/icons-vue';
import type { CreateMicroAppPayload } from '@/api/scaffold';
import { SCAFFOLD_TIPS } from '../constant';
import NamespacePicker from './NamespacePicker.vue';

/** 可见性选项。 */
interface VisibilityOption {
  label: string;
  value: string;
}

/** GitLab 配置卡片属性。 */
interface GitLabConfigCardProps {
  form: CreateMicroAppPayload & { gitlabToken: string };
  isAuthenticated: boolean;
  visibilityOptions: VisibilityOption[];
  namespaceCacheKey: string;
}

defineProps<GitLabConfigCardProps>();
</script>

<template>
  <a-card class="section-card" title="GitLab">
    <template #extra>
      <div class="gitlab-extra">
        <span class="extra-label">创建并推送到 GitLab</span>
        <a-switch v-model:checked="form.createRepo" />
        <a-tooltip :title="form.createRepo ? '将在 GitLab 自动创建仓库并推送初始化代码，请确保 Token 和 Namespace 配置正确' : '当前未开启 GitLab 推送，微应用创建完成后将仅保存在本地'">
          <exclamation-circle-outlined class="warning-icon" />
        </a-tooltip>
      </div>
    </template>

    <div :class="['gitlab-body', { disabled: !form.createRepo }]">
      <a-alert
        v-if="!form.createRepo"
        message="当前为本地下载模式，项目创建完成后可直接下载到本地"
        type="info"
        show-icon
        class="download-alert"
      />
      <a-row :gutter="[16, 16]">
        <a-col :xs="24">
          <a-form-item label="GitLab Host" :tooltip="SCAFFOLD_TIPS.gitlabHost">
            <a-input :disabled="true" v-model:value="form.gitlabHost" :placeholder="isAuthenticated ? '已自动填充登录Host' : '请输入GitLab Host'" />
          </a-form-item>
        </a-col>
        <a-col :xs="24">
          <a-form-item label="Token" :tooltip="SCAFFOLD_TIPS.gitlabToken">
            <a-input-password
              v-model:value="form.gitlabToken"
              :disabled="isAuthenticated || !form.createRepo"
              :placeholder="isAuthenticated ? '已自动填充登录Token' : '请输入GitLab Token'"
            />
            <div v-if="isAuthenticated" class="auth-tip">已登录，使用认证 Token</div>
          </a-form-item>
        </a-col>
        <a-col :xs="24">
          <a-form-item label="Namespace" :tooltip="SCAFFOLD_TIPS.namespaceId">
            <NamespacePicker v-model:value="form.namespaceId" :disabled="!form.createRepo" :cache-key="namespaceCacheKey" />
          </a-form-item>
        </a-col>
        <a-col :xs="24">
          <a-form-item label="可见性" :tooltip="SCAFFOLD_TIPS.visibility">
            <a-select v-model:value="form.visibility" :options="visibilityOptions" :disabled="!form.createRepo" />
          </a-form-item>
        </a-col>
      </a-row>
    </div>
  </a-card>
</template>

<style scoped lang="less">
@import '../style.less';
</style>
