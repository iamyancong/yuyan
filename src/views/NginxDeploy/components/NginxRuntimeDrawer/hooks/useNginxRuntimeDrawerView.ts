import { computed } from 'vue';
import type { NginxInstancePayload, NginxRuntimePayload } from '@/api/deploy';
import {
  NGINX_RUNTIME_STATUS_COLOR,
  NGINX_RUNTIME_STATUS_LABEL,
  formatProgressLogContent,
  getRuntimeDrawerTitle,
  getRuntimePathRows,
  nginxInstanceFormSchema,
  type NginxRuntimeDrawerEmits,
  type NginxRuntimeDrawerProps,
  type RuntimePathRow,
} from '../constant';
import { renderTwoLineSelectOption } from '../../../hooks/useDeployProjectOptions';

/**
 * 管理 Nginx 运行时抽屉展示层派生状态。
 * @param props 抽屉属性
 * @param emit 抽屉事件
 * @returns 模板渲染所需状态
 */
export function useNginxRuntimeDrawerView(props: Readonly<NginxRuntimeDrawerProps>, emit: NginxRuntimeDrawerEmits) {
  const visible = computed({
    get: () => props.open,
    set: (value: boolean) => emit('update:open', value),
  });

  const formModel = computed({
    get: () => ({ ...props.form }),
    set: (value: Partial<NginxRuntimePayload>) => emit('update:form', value || {}),
  });

  const instanceFormVisible = computed({
    get: () => props.instanceFormOpen,
    set: (value: boolean) => emit('update:instanceFormOpen', value),
  });

  const instanceFormModel = computed({
    get: () => ({ ...props.instanceForm }),
    set: (value: Partial<NginxInstancePayload>) => emit('update:instanceForm', value || {}),
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
  const versionLabel = computed(() => props.status?.version || props.status?.runtime?.runtimeVersion || '-');
  const pathRows = computed<RuntimePathRow[]>(() => {
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
  const canDownloadArchive = computed(() => isManagedInstance.value && initialized.value && !props.initializing && !props.loading && !props.archiveDownloading);
  const pathPreviewTip = computed(() => {
    if (!isManagedInstance.value) return '保存部署目标和重载时使用当前实例的路径模板与命令';
    if (!initialized.value) return '请先完成初始化，再下载可迁移运行包';
    return '下载包用于迁移当前托管实例，目标机需解压到原路径';
  });
  const hasProgress = computed(() => props.progress.running || props.progress.logs.length > 0);
  const hasServer = computed(() => Boolean(props.server));
  const hasManagedInstance = computed(() => props.instances.some((instance) => instance.instanceType === 'managed'));
  const serverOptions = computed(() =>
    props.servers.map((server) => ({
      label: renderTwoLineSelectOption({ title: server.name, description: server.host }),
      title: server.name,
      searchKey: `${server.name} ${server.host}`,
      value: server.id,
    }))
  );
  const instanceOptions = computed(() =>
    props.instances.map((instance) => {
      const typeLabel = instance.instanceType === 'managed' ? '系统托管' : '外部已有';
      const desc = `${typeLabel} · 绑定 ${instance.targetCount || 0} 个项目`;
      return {
        label: renderTwoLineSelectOption({ title: instance.name, description: desc }),
        title: instance.name,
        searchKey: `${instance.name} ${desc}`,
        value: instance.id,
      };
    })
  );
  const progressLogContent = computed(() => formatProgressLogContent(props.progress.logs));
  const monacoReadonlyOptions = { minimap: { enabled: false }, fontSize: 13, wordWrap: 'on' as const, readOnly: true };
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

  return {
    activeInstance,
    activeInstanceTypeLabel,
    canDownloadArchive,
    canManagedOperate,
    canOperate,
    computedInstanceFormSchema,
    formModel,
    hasManagedInstance,
    hasProgress,
    hasServer,
    initialized,
    instanceFormModel,
    instanceFormVisible,
    instanceOptions,
    isManagedInstance,
    monacoReadonlyOptions,
    pathPreviewTip,
    pathRows,
    progressLogContent,
    serverOptions,
    statusColor,
    statusLabel,
    title,
    versionLabel,
    visible,
  };
}
