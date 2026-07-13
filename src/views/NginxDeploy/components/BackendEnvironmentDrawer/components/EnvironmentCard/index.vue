<script setup lang="ts">
import { computed } from 'vue';
import { ApiOutlined, CheckOutlined, DeleteOutlined, EditOutlined, SafetyCertificateOutlined } from '@ant-design/icons-vue';
import { YButton } from '@ycwang-dev/components/lite';
import type { DeployEnvironment } from '@/api/deploy';
import { formatEnvironmentCheckedAt, getEnvironmentStatusMeta } from '../../constant';

defineOptions({ name: 'BackendEnvironmentCard' });

const props = defineProps<{
  environment: DeployEnvironment;
  selected: boolean;
  editing: boolean;
}>();

const emit = defineEmits<{
  (e: 'select'): void;
  (e: 'edit'): void;
  (e: 'remove'): void;
}>();

const statusMeta = computed(() => getEnvironmentStatusMeta(props.environment.status));
</script>

<template>
  <article class="environment-card" :class="{ 'is-selected': selected, 'is-editing': editing }">
    <header class="environment-card__header">
      <div class="environment-card__identity">
        <span class="environment-card__icon"><ApiOutlined /></span>
        <div>
          <strong>{{ environment.name }}</strong>
          <span class="environment-card__status" :data-tone="statusMeta.tone">
            <i />{{ statusMeta.label }}
          </span>
        </div>
      </div>
      <span v-if="selected" class="environment-card__selected"><CheckOutlined /> 当前使用</span>
      <span v-else-if="editing" class="environment-card__editing">正在编辑</span>
    </header>

    <div class="environment-card__addresses">
      <div>
        <span>NACOS</span>
        <code :title="environment.nacosServerAddr || '未配置'">{{ environment.nacosServerAddr || '未配置' }}</code>
      </div>
      <div>
        <span>GATEWAY</span>
        <code :class="{ 'is-empty': !environment.gatewayPublicUrl }" :title="environment.gatewayPublicUrl || '未配置'">
          {{ environment.gatewayPublicUrl || '未配置' }}
        </code>
      </div>
    </div>

    <div class="environment-card__meta">
      <span>Namespace <b>{{ environment.nacosNamespace || 'public' }}</b></span>
      <span>Group <b>{{ environment.nacosGroup || 'DEFAULT_GROUP' }}</b></span>
      <span v-if="environment.hasCredential"><SafetyCertificateOutlined /> 已配置凭据</span>
    </div>

    <footer class="environment-card__footer">
      <span :title="environment.statusOutput">{{ formatEnvironmentCheckedAt(environment.lastCheckedAt) }}</span>
      <div class="environment-card__actions">
        <YButton size="small" type="primary" :disabled="selected" @click="emit('select')">
          <CheckOutlined />{{ selected ? '使用中' : '使用此环境' }}
        </YButton>
        <a-tooltip title="编辑环境">
          <YButton size="small" @click="emit('edit')"><EditOutlined /></YButton>
        </a-tooltip>
        <a-popconfirm title="确认删除该环境配置？" description="被部署目标引用的环境无法删除。" ok-text="删除" cancel-text="取消" @confirm="emit('remove')">
          <a-tooltip title="删除环境">
            <YButton size="small" danger><DeleteOutlined /></YButton>
          </a-tooltip>
        </a-popconfirm>
      </div>
    </footer>
  </article>
</template>

<style scoped lang="less">
@import './style.less';
</style>
