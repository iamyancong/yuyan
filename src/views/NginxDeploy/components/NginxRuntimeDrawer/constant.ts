import type {
  DeployProgressEvent,
  DeployServer,
  NginxInstance,
  NginxInstancePayload,
  NginxArchiveDownloadType,
  NginxArchiveSiteOption,
  NginxRuntimeAction,
  NginxRuntimePayload,
  NginxRuntimeStatus,
} from '@/api/deploy';
import { formatDeployDateTime } from '../../constant';

/** Nginx 初始化进度状态 */
export interface RuntimeProgressState {
  percent: number;
  title: string;
  detail: string;
  logs: DeployProgressEvent[];
  running: boolean;
}

/** Nginx 运行时抽屉属性 */
export interface NginxRuntimeDrawerProps {
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
  archiveSelectionOpen: boolean;
  archiveSelectionLoading: boolean;
  archiveSelectionType: NginxArchiveDownloadType;
  archiveConfigPath: string;
  archiveSites: NginxArchiveSiteOption[];
  instanceFormOpen: boolean;
  instanceSaving: boolean;
  instanceForm: NginxInstancePayload;
  progress: RuntimeProgressState;
}

/** Nginx 运行时抽屉事件 */
export type NginxRuntimeDrawerEmits = {
  (e: 'update:open', value: boolean): void;
  (e: 'update:form', value: Partial<NginxRuntimePayload>): void;
  (e: 'update:instanceFormOpen', value: boolean): void;
  (e: 'update:instanceForm', value: Partial<NginxInstancePayload>): void;
  (e: 'changeServer', value: number): void;
  (e: 'selectInstance', value: number): void;
  (e: 'createInstance', value: NginxInstance['instanceType']): void;
  (e: 'editInstance'): void;
  (e: 'saveInstance', value: NginxInstancePayload): void;
  (e: 'deleteInstance'): void;
  (e: 'init'): void;
  (e: 'action', value: NginxRuntimeAction): void;
  (e: 'downloadArchive', type: 'all' | 'html' | 'conf'): void;
  (e: 'update:archiveSelectionOpen', value: boolean): void;
  (e: 'refreshArchiveSites'): void;
  (e: 'confirmArchiveDownload', value: { type: NginxArchiveDownloadType; siteIds: string[] }): void;
  (e: 'refresh'): void;
};

/** Nginx 运行时路径展示行 */
export interface RuntimePathRow {
  label: string;
  value?: string;
}

/** Nginx 运行时状态文案 */
export const NGINX_RUNTIME_STATUS_LABEL: Record<string, string> = {
  uninitialized: '未初始化',
  unknown: '未知',
  running: '运行中',
  stopped: '已停止',
  error: '异常',
};

/** Nginx 运行时状态颜色 */
export const NGINX_RUNTIME_STATUS_COLOR: Record<string, string> = {
  uninitialized: 'default',
  unknown: 'default',
  running: 'success',
  stopped: 'warning',
  error: 'error',
};

/** Nginx 初始化表单 Schema */
export const nginxRuntimeFormSchema = {
  type: 'object',
  properties: {
    layout: {
      type: 'void',
      'x-component': 'FormLayout',
      'x-component-props': {
        layout: 'horizontal',
        labelAlign: 'right',
        labelWidth: 130,
      },
      properties: {
        grid: {
          type: 'void',
          'x-component': 'FormGrid',
          'x-component-props': {
            maxColumns: 2,
            minColumns: 1,
            minWidth: 260,
            columnGap: 16,
            rowGap: 0,
          },
          properties: {
            baseRoot: {
              type: 'string',
              title: '根目录',
              required: true,
              'x-decorator': 'FormItem',
              'x-decorator-props': { gridSpan: 2 },
              'x-component': 'Input',
              'x-component-props': { placeholder: '/opt/yuyan' },
            },
            portStart: {
              type: 'number',
              title: '默认监听端口',
              required: true,
              'x-decorator': 'FormItem',
              'x-component': 'InputNumber',
              'x-component-props': { min: 1, max: 65535, precision: 0, controls: false },
            },
            useSudo: {
              type: 'boolean',
              title: '使用 sudo',
              'x-decorator': 'FormItem',
              'x-component': 'Switch',
              'x-component-props': { checkedChildren: '开', unCheckedChildren: '关' },
            },
          },
        },
      },
    },
  },
};

/** Nginx 实例编辑表单 Schema */
export const nginxInstanceFormSchema = {
  type: 'object',
  properties: {
    layout: {
      type: 'void',
      'x-component': 'FormLayout',
      'x-component-props': {
        layout: 'horizontal',
        labelAlign: 'right',
        labelWidth: 132,
      },
      properties: {
        basicGrid: {
          type: 'void',
          'x-component': 'FormGrid',
          'x-component-props': {
            maxColumns: 2,
            minColumns: 1,
            minWidth: 300,
            columnGap: 18,
            rowGap: 0,
          },
          properties: {
            name: {
              type: 'string',
              title: '实例名称',
              required: true,
              'x-validator': [{ required: true, whitespace: true, message: '请输入实例名称' }],
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': { placeholder: '例如：生产环境 Nginx' },
            },
            instanceType: {
              type: 'string',
              title: '实例类型',
              required: true,
              enum: [
                { label: '接入已有 Nginx（不安装）', value: 'external' },
                { label: '平台托管 Nginx（需初始化）', value: 'managed' },
              ],
              'x-decorator': 'FormItem',
              'x-component': 'Select',
            },
            defaultDeployRoot: {
              type: 'string',
              title: '默认部署根目录',
              required: true,
              'x-validator': [
                { required: true, whitespace: true, message: '请输入默认部署根目录' },
                { pattern: /^\//, message: '默认部署根目录必须是绝对路径' },
              ],
              'x-decorator': 'FormItem',
              'x-decorator-props': { gridSpan: 2 },
              'x-component': 'Input',
              'x-component-props': { placeholder: '例如：/home/app/frontend/html' },
            },
            defaultNginxConfPath: {
              type: 'string',
              title: '默认配置文件',
              required: true,
              'x-validator': [
                { required: true, whitespace: true, message: '请输入 Nginx 配置文件路径' },
                { pattern: /^\//, message: 'Nginx 配置文件必须是绝对路径' },
              ],
              'x-decorator': 'FormItem',
              'x-decorator-props': { gridSpan: 2 },
              'x-component': 'Input',
              'x-component-props': { placeholder: '例如：/home/nginx/conf/nginx.conf' },
            },
            nginxWorkDir: {
              type: 'string',
              title: 'Nginx 工作目录',
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': { placeholder: '例如：/usr/local/nginx，可留空' },
            },
            useSudo: {
              type: 'boolean',
              title: '使用 sudo',
              'x-decorator': 'FormItem',
              'x-component': 'Switch',
              'x-component-props': { checkedChildren: '开', unCheckedChildren: '关' },
            },
            nginxTestCommand: {
              type: 'string',
              title: '校验命令',
              'x-decorator': 'FormItem',
              'x-decorator-props': { gridSpan: 2 },
              'x-component': 'Input',
              'x-component-props': { placeholder: 'nginx -t 或 /opt/yuyan/nginx/yuyan-nginx.sh test' },
            },
            nginxReloadCommand: {
              type: 'string',
              title: '重载命令',
              'x-decorator': 'FormItem',
              'x-decorator-props': { gridSpan: 2 },
              'x-component': 'Input',
              'x-component-props': { placeholder: 'nginx -s reload 或 /opt/yuyan/nginx/yuyan-nginx.sh reload' },
            },
            baseRoot: {
              type: 'string',
              title: '托管根目录',
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': { placeholder: '/opt/yuyan，仅托管实例使用' },
              'x-reactions': {
                dependencies: ['instanceType'],
                fulfill: { state: { visible: '{{$deps[0] === "managed"}}' } },
              },
            },
            portStart: {
              type: 'number',
              title: '默认监听端口',
              'x-decorator': 'FormItem',
              'x-component': 'InputNumber',
              'x-component-props': { min: 1, max: 65535 },
              'x-reactions': {
                dependencies: ['instanceType'],
                fulfill: { state: { visible: '{{$deps[0] === "managed"}}' } },
              },
            },
          },
        },
      },
    },
  },
};

/**
 * 创建 Nginx 实例编辑表单默认值。
 * @returns Nginx 实例表单默认值
 */
export const createDefaultNginxInstanceForm = (): NginxInstancePayload => ({
  name: '',
  instanceType: 'managed',
  defaultDeployRoot: '/opt/yuyan/html',
  defaultNginxConfPath: '/opt/yuyan/nginx/conf/nginx.conf',
  nginxWorkDir: '',
  nginxTestCommand: '/opt/yuyan/nginx/yuyan-nginx.sh test',
  nginxReloadCommand: '/opt/yuyan/nginx/yuyan-nginx.sh reload',
  baseRoot: '/opt/yuyan',
  portStart: 8082,
  useSudo: false,
});

/**
 * 获取抽屉标题。
 * @param status 运行时状态
 * @param initializing 是否初始化中
 * @returns 抽屉标题
 */
export const getRuntimeDrawerTitle = (status: NginxRuntimeStatus | null, initializing: boolean) => {
  if (initializing) return 'Nginx 初始化中';
  return status?.initialized ? 'Nginx 管理' : '初始化 Nginx';
};

/**
 * 派生路径预览。
 * @param form 初始化表单
 * @returns 路径预览
 */
export const getRuntimePreviewRows = (form: NginxRuntimePayload): RuntimePathRow[] => {
  const baseRoot = String(form.baseRoot || '/opt/yuyan').replace(/\/+$/, '');
  return [
    { label: '运行时变体', value: '初始化时自动选择' },
    { label: 'Nginx 目录', value: `${baseRoot}/nginx` },
    { label: 'HTML 根目录', value: `${baseRoot}/html` },
    { label: '站点配置目录', value: `${baseRoot}/nginx/conf/conf.d` },
    { label: '日志目录', value: `${baseRoot}/nginx/logs` },
    { label: '管理脚本', value: `${baseRoot}/nginx/yuyan-nginx.sh` },
  ];
};

/** 运行时变体标签映射 */
const VARIANT_LABELS: Record<string, string> = {
  'linux-x64': '动态链接 (glibc ≥ 2.28)',
  'linux-x64-static': '静态链接 (通用)',
};

/**
 * 获取运行时路径摘要。
 * @param status 运行时状态
 * @param form 初始化表单
 * @returns 路径摘要
 */
export const getRuntimePathRows = (status: NginxRuntimeStatus | null, form: NginxRuntimePayload): RuntimePathRow[] => {
  if (!status?.initialized) return getRuntimePreviewRows(form);
  const variantId = status.packageVariant || status.runtime?.packageVariant || '';
  const variantLabel = VARIANT_LABELS[variantId] || variantId || '未知';
  return [
    { label: '运行时变体', value: variantLabel },
    { label: 'Nginx 目录', value: status.installRoot },
    { label: 'HTML 根目录', value: status.webRoot },
    { label: '站点配置目录', value: status.sitesDir },
    { label: '主配置', value: status.mainConfPath },
    { label: '管理脚本', value: status.scriptPath },
  ];
};

/**
 * 格式化单条进度日志事件为可读文本行。
 * 与 ProgressPanel getLogText 保持一致的输出格式，
 * 同时适配 YMonaco log 语言的关键字高亮规则。
 * @param item 进度事件
 * @returns 格式化后的日志文本行
 */
export const formatProgressLogItem = (item: DeployProgressEvent): string => {
  const time = formatDeployDateTime(item.timestamp);
  if (item.type === 'stage') return `${time} [INFO] [阶段] ${item.message}${item.detail ? ` - ${item.detail}` : ''}`;
  if (item.type === 'log') return `${time} [${(item.level || 'info').toUpperCase()}] ${item.message}`;
  if (item.type === 'result') return `${time} [INFO] [完成] 操作成功`;
  return `${time} [ERROR] ${item.message}`;
};

/**
 * 将进度日志事件数组格式化为 YMonaco 展示的纯文本内容。
 * @param logs 进度事件数组
 * @returns 多行日志文本
 */
export const formatProgressLogContent = (logs: DeployProgressEvent[]): string => {
  if (!logs.length) return '';
  return logs.map(formatProgressLogItem).join('\n');
};
