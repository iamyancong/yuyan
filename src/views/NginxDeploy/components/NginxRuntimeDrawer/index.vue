<script setup lang="ts">
import { computed } from 'vue';
import { YButton, YMonaco, YssFormily } from '@yss-ui/components/lite';
import type {
  DeployProgressEvent,
  DeployServer,
  NginxInstance,
  NginxInstancePayload,
  NginxRuntimeAction,
  NginxRuntimePayload,
  NginxRuntimeStatus,
} from '@/api/deploy';
import {
  NGINX_RUNTIME_STATUS_COLOR,
  NGINX_RUNTIME_STATUS_LABEL,
  formatProgressLogContent,
  getRuntimeDrawerTitle,
  getRuntimePathRows,
  nginxInstanceFormSchema,
  nginxRuntimeFormSchema,
} from './constant';
import { formatServerLabel } from '../../utils';

defineOptions({ name: 'NginxRuntimeDrawer' });

/** Nginx 初始化进度状态 */
interface RuntimeProgressState {
  percent: number;
  title: string;
  detail: string;
  logs: DeployProgressEvent[];
  running: boolean;
}

/** Nginx 运行时抽屉属性 */
interface NginxRuntimeDrawerProps {
  open: boolean;
  servers: DeployServer[];
  server: DeployServer | null;
  instances: NginxInstance[];
  activeInstanceId: number | null;
  status: NginxRuntimeStatus | null;
  form: NginxRuntimePayload;
  loading: boolean;
  initializing: boolean;
  actionLoading: NginxRuntimeAction | '';
  archiveDownloading: boolean;
  instanceFormOpen: boolean;
  instanceFormKey: number;
  instanceSaving: boolean;
  instanceForm: NginxInstancePayload;
  progress: RuntimeProgressState;
}

const props = defineProps<NginxRuntimeDrawerProps>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'update:form', value: Partial<NginxRuntimePayload>): void;
  (e: 'update:instanceFormOpen', value: boolean): void;
  (e: 'update:instanceForm', value: Partial<NginxInstancePayload>): void;
  (e: 'changeServer', value: number): void;
  (e: 'selectInstance', value: number): void;
  (e: 'createInstance', value: NginxInstance['instanceType']): void;
  (e: 'editInstance'): void;
  (e: 'saveInstance'): void;
  (e: 'deleteInstance'): void;
  (e: 'init'): void;
  (e: 'action', value: NginxRuntimeAction): void;
  (e: 'downloadArchive'): void;
  (e: 'refresh'): void;
}>();

const visible = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
});

const formModel = computed({
  get: () => ({ ...props.form }),
  set: (value: Partial<NginxRuntimePayload>) => {
    emit('update:form', value || {});
  },
});

const instanceFormVisible = computed({
  get: () => props.instanceFormOpen,
  set: (value: boolean) => emit('update:instanceFormOpen', value),
});

const instanceFormModel = computed({
  get: () => ({ ...props.instanceForm }),
  set: (value: Partial<NginxInstancePayload>) => {
    emit('update:instanceForm', value || {});
  },
});

const title = computed(() => {
  if (props.initializing) return 'Nginx 初始化中';
  if (!props.server) return 'Nginx 管理';
  return getRuntimeDrawerTitle(props.status, props.initializing);
});
const activeInstance = computed(() => props.instances.find((item) => item.id === props.activeInstanceId) || null);
const isManagedInstance = computed(() => activeInstance.value?.instanceType === 'managed');
const activeInstanceTypeLabel = computed(() => (activeInstance.value?.instanceType === 'managed' ? '托管' : '已有'));
const statusKey = computed(() => props.status?.status || 'uninitialized');
const statusLabel = computed(() => NGINX_RUNTIME_STATUS_LABEL[statusKey.value] || '未知');
const statusColor = computed(() => NGINX_RUNTIME_STATUS_COLOR[statusKey.value] || 'default');
const pathRows = computed(() => {
  if (!activeInstance.value || activeInstance.value.instanceType === 'managed') {
    return getRuntimePathRows(props.status, props.form);
  }
  return [
    { label: '默认部署根目录', value: activeInstance.value.defaultDeployRoot },
    { label: '默认配置文件', value: activeInstance.value.defaultNginxConfPath },
    { label: 'Nginx 工作目录', value: activeInstance.value.nginxWorkDir },
    { label: '校验命令', value: activeInstance.value.nginxTestCommand || 'nginx -t' },
    { label: '重载命令', value: activeInstance.value.nginxReloadCommand || 'nginx -s reload' },
  ];
});
const initialized = computed(() => Boolean(props.status?.initialized));
const canOperate = computed(() => initialized.value && !props.initializing && !props.loading);
const canManagedOperate = computed(() => canOperate.value && isManagedInstance.value);
/** 当前托管实例是否允许下载运行包 */
const canDownloadArchive = computed(() => isManagedInstance.value && initialized.value && !props.initializing && !props.loading && !props.archiveDownloading);
/** 路径预览区域说明 */
const pathPreviewTip = computed(() => {
  if (!isManagedInstance.value) return '保存部署目标和重载时使用当前实例的路径模板与命令';
  if (!initialized.value) return '请先完成初始化，再下载可迁移运行包';
  return '下载包用于迁移当前托管实例，目标机需解压到原路径';
});
const hasProgress = computed(() => props.progress.running || props.progress.logs.length > 0);
const hasServer = computed(() => Boolean(props.server));
const hasManagedInstance = computed(() => props.instances.some((instance) => instance.instanceType === 'managed'));
const serverOptions = computed(() =>
  props.servers.map((s) => ({
    label: formatServerLabel(s.name, s.host),
    value: s.id,
  }))
);
const instanceOptions = computed(() =>
  props.instances.map((instance) => ({
    label: `${instance.name}（${instance.instanceType === 'managed' ? '托管' : '已有'}）`,
    value: instance.id,
  }))
);

/** 进度日志转为 YMonaco 纯文本 */
const progressLogContent = computed(() => formatProgressLogContent(props.progress.logs));

/** YMonaco 通用只读配置 */
const monacoReadonlyOptions = { minimap: { enabled: false }, fontSize: 13, wordWrap: 'on' as const, readOnly: true };

/**
 * 获取实例状态文案。
 * @param instance Nginx 实例
 * @returns 状态文案
 */
const getInstanceStatusLabel = (instance: NginxInstance) => NGINX_RUNTIME_STATUS_LABEL[instance.status || 'unknown'] || '未知';

/**
 * 获取实例状态颜色。
 * @param instance Nginx 实例
 * @returns 标签颜色
 */
const getInstanceStatusColor = (instance: NginxInstance) => NGINX_RUNTIME_STATUS_COLOR[instance.status || 'unknown'] || 'default';

/** 动态计算的实例编辑表单 Schema，如果是系统 Nginx 则禁用关键字段修改 */
const computedInstanceFormSchema = computed(() => {
  const schema = JSON.parse(JSON.stringify(nginxInstanceFormSchema));
  const properties = schema.properties?.layout?.properties?.basicGrid?.properties;
  if (properties && props.instanceForm.name === '系统 Nginx') {
    if (properties.name) {
      properties.name['x-disabled'] = true;
      properties.name['x-component-props'] = {
        ...properties.name['x-component-props'],
        disabled: true,
      };
    }
    if (properties.instanceType) {
      properties.instanceType['x-disabled'] = true;
      properties.instanceType['x-component-props'] = {
        ...properties.instanceType['x-component-props'],
        disabled: true,
      };
    }
  }
  return schema;
});
</script>

<template>
  <a-drawer v-model:open="visible" :bodyStyle="{ padding: '12px' }" :title="title" width="min(1120px, 94vw)" class="nginx-runtime-drawer" :destroy-on-close="false">
    <a-spin :spinning="loading">
      <div class="nginx-runtime-shell">
        <!-- ====== 顶部概览条 ====== -->
        <section class="nginx-runtime-summary">
          <div class="nginx-runtime-summary__item nginx-runtime-summary__item--grow">
            <span class="nginx-runtime-summary__label">服务器</span>
            <a-select
              :value="server?.id || undefined"
              :options="serverOptions"
              style="min-width: 270px"
              placeholder="请选择服务器"
              @change="(value: unknown) => emit('changeServer', Number(value))"
            />
          </div>
          <template v-if="hasServer">
            <div class="nginx-runtime-summary__item">
              <span class="nginx-runtime-summary__label">Nginx 实例</span>
              <a-select
                :value="activeInstanceId || undefined"
                :options="instanceOptions"
                style="min-width: 220px"
                placeholder="请选择 Nginx 实例"
                @change="(value: unknown) => emit('selectInstance', Number(value))"
              />
            </div>
            <div class="nginx-runtime-summary__item">
              <span class="nginx-runtime-summary__label">类型</span>
              <a-tag>{{ activeInstance ? activeInstanceTypeLabel : '-' }}</a-tag>
            </div>
            <div class="nginx-runtime-summary__item">
              <span class="nginx-runtime-summary__label">状态</span>
              <a-tag :color="statusColor">{{ statusLabel }}</a-tag>
            </div>
            <div class="nginx-runtime-summary__item">
              <span class="nginx-runtime-summary__label">版本</span>
              <span class="nginx-runtime-summary__value">{{ status?.version || status?.runtime?.runtimeVersion || '-' }}</span>
            </div>
          </template>
        </section>

        <!-- ====== 未选服务器空态 ====== -->
        <a-empty v-if="!hasServer" description="请在上方选择一台服务器" style="padding: 60px 0" />

        <!-- ====== 双栏主体区域 ====== -->
        <div v-else class="nginx-runtime-body">
          <!-- 左栏：实例管理 -->
          <div class="nginx-runtime-body__left">
            <section class="nginx-runtime-card">
              <div class="nginx-runtime-section-title">
                <div class="nginx-runtime-section-title__left">
                  <strong>实例管理</strong>
                  <span>部署目标会绑定到这里选中的具体 Nginx 实例</span>
                </div>
                <a-tooltip :title="hasManagedInstance ? '同一服务器只能新增一个托管 Nginx；多个 yuyan 主应用请在 nginx.conf 中新增 server' : ''">
                  <YButton size="small" :disabled="hasManagedInstance" @click="emit('createInstance', 'managed')">+ 新增托管</YButton>
                </a-tooltip>
              </div>
              <div class="nginx-instance-list">
                <div
                  v-for="instance in instances"
                  :key="instance.id"
                  class="nginx-instance-list__item"
                  :class="{ 'nginx-instance-list__item--active': instance.id === activeInstanceId }"
                  @click="emit('selectInstance', instance.id)"
                >
                  <div class="nginx-instance-list__main">
                    <strong>{{ instance.name }}</strong>
                    <a-tag>{{ instance.instanceType === 'managed' ? '托管' : '已有' }}</a-tag>
                    <a-tag :color="getInstanceStatusColor(instance)">{{ getInstanceStatusLabel(instance) }}</a-tag>
                    <span>绑定 {{ instance.targetCount || 0 }} 个目标</span>
                  </div>
                  <div class="nginx-instance-list__bottom">
                    <code>{{ instance.defaultNginxConfPath || instance.nginxRoot || '-' }}</code>
                    <div v-if="instance.id === activeInstanceId" class="nginx-instance-list__actions" @click.stop>
                      <YButton size="small" @click="emit('editInstance')">编辑</YButton>
                      <a-popconfirm v-if="instance.name !== '系统 Nginx'" title="确认删除该 Nginx 实例？" ok-text="删除" cancel-text="取消" @confirm="emit('deleteInstance')">
                        <YButton size="small" danger :disabled="Boolean(instance.targetCount)">删除</YButton>
                      </a-popconfirm>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <!-- 右栏：运行时配置 + 路径预览 -->
          <div class="nginx-runtime-body__right">
            <section v-if="isManagedInstance" class="nginx-runtime-card">
              <div class="nginx-runtime-section-title">
                <strong>{{ initialized ? '运行时配置' : '初始化配置' }}</strong>
                <span>{{ initialized ? '当前服务器已记录的 yuyan 托管 Nginx 路径' : '默认写入 /opt/yuyan；权限不足时请开启 sudo 或改目录' }}</span>
              </div>
              <YssFormily v-model:modelValue="formModel" :schema="nginxRuntimeFormSchema" :disabled="initializing" />
            </section>

            <section class="nginx-runtime-card">
              <div class="nginx-runtime-section-title">
                <div class="nginx-runtime-section-title__left">
                  <strong>{{ isManagedInstance ? '路径预览' : '实例路径与命令' }}</strong>
                  <span>{{ pathPreviewTip }}</span>
                </div>
                <YButton v-if="isManagedInstance" size="small" :disabled="!canDownloadArchive" :loading="archiveDownloading" @click="emit('downloadArchive')">
                  下载运行包
                </YButton>
              </div>
              <div class="nginx-runtime-paths">
                <div v-for="item in pathRows" :key="item.label" class="nginx-runtime-path-row">
                  <span>{{ item.label }}</span>
                  <code>{{ item.value || '-' }}</code>
                </div>
              </div>
            </section>
          </div>
        </div>

        <!-- ====== 进度 & 日志 (YMonaco log-mode) ====== -->
        <section v-if="hasProgress" class="nginx-runtime-card">
          <div class="nginx-runtime-progress-header">
            <a-progress :percent="progress.percent" :status="progress.running ? 'active' : progress.percent >= 100 ? 'success' : 'normal'" />
            <div class="nginx-runtime-progress-title">{{ progress.title || '等待执行' }}</div>
          </div>
          <div class="nginx-runtime-progress-monaco">
            <YMonaco
              :model-value="progressLogContent"
              language="log"
              theme="vs-dark"
              height="360px"
              :readonly="true"
              log-mode
              :max-lines="20000"
              :auto-scroll="true"
              :show-border="false"
              :options="monacoReadonlyOptions"
            />
          </div>
        </section>
      </div>
    </a-spin>

    <template #footer>
      <div class="nginx-runtime-footer">
        <a-space>
          <YButton :disabled="initializing" @click="emit('refresh')">刷新状态</YButton>
          <YButton :disabled="!canOperate" :loading="actionLoading === 'test'" @click="emit('action', 'test')">校验</YButton>
          <YButton :disabled="!canManagedOperate" :loading="actionLoading === 'start'" @click="emit('action', 'start')">启动</YButton>
          <YButton :disabled="!canOperate" :loading="actionLoading === 'reload'" @click="emit('action', 'reload')">重载</YButton>
          <YButton :disabled="!canManagedOperate" :loading="actionLoading === 'stop'" danger @click="emit('action', 'stop')">停止</YButton>
        </a-space>
        <a-space>
          <YButton :disabled="initializing" @click="visible = false">关闭</YButton>
          <YButton type="primary" :disabled="activeInstance?.instanceType !== 'managed'" :loading="initializing" @click="emit('init')">
            {{ initialized ? '重新初始化' : '开始初始化' }}
          </YButton>
        </a-space>
      </div>
    </template>
  </a-drawer>

  <a-modal
    v-model:open="instanceFormVisible"
    title="编辑 Nginx 实例"
    width="min(900px, 94vw)"
    :confirmLoading="instanceSaving"
    :maskClosable="!instanceSaving"
    :closable="!instanceSaving"
    :bodyStyle="{ maxHeight: 'calc(100vh - 220px)', overflowY: 'auto', padding: '18px 18px 2px 0' }"
    @ok="emit('saveInstance')"
  >
    <YssFormily :key="instanceFormKey" v-model:modelValue="instanceFormModel" :schema="computedInstanceFormSchema" />
  </a-modal>
</template>

<style scoped lang="less">
@import './style.less';
</style>
