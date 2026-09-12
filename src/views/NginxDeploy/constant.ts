import type { YTableColumn } from '@yss-ui/components/lite';
import type { DeployProgressEvent, DeployProgressSnapshot, DeployProjectSource, DeployRecord, DeployRecordAction, DeployUploadStrategy } from '@/api/deploy';
import { formatServerLabel } from './utils';

/** 测试环境名称 */
export const TEST_ENV_NAME = '测试';

/** 默认部署项目来源 */
export const DEFAULT_PROJECT_SOURCE: DeployProjectSource = 'gitlab';

/** 部署项目来源选项 */
export const PROJECT_SOURCE_OPTIONS: Array<{ label: string; value: DeployProjectSource }> = [
  { label: 'yuyan 平台微应用', value: 'ops' },
  { label: 'GitLab 仓库', value: 'gitlab' },
];

/** 默认安装命令 */
export const DEFAULT_INSTALL_COMMAND = 'pnpm install';

/** 默认构建命令 */
export const DEFAULT_BUILD_COMMAND = 'pnpm build';

/** 默认后端安装命令 */
export const DEFAULT_BACKEND_INSTALL_COMMAND = '';

/** 默认后端构建命令（通用 Spring Boot 单模块默认值） */
export const DEFAULT_BACKEND_BUILD_COMMAND = './mvnw -nsu clean package -DskipTests';

/** 默认后端 Jar 匹配规则（通用 Spring Boot 单模块默认值） */
export const DEFAULT_BACKEND_ARTIFACT_PATTERN = 'target/*.jar';

/** 默认 OpenAPI 生成命令 */
export const DEFAULT_BACKEND_OPENAPI_COMMAND = '';

/** 默认 OpenAPI 输出路径 */
export const DEFAULT_BACKEND_OPENAPI_OUTPUT_PATH = '';

import {
  BACKEND_TEMPLATES,
  BACKEND_TEMPLATE_OPTIONS,
  deriveStarterModuleName,
  resolveBackendTemplateValues,
  recommendTemplateForProject,
  detectBackendTemplateKey,
  type BackendTemplateKey,
  type BackendProjectTemplate,
} from './templates/backendTemplates';

export {
  BACKEND_TEMPLATES,
  BACKEND_TEMPLATE_OPTIONS,
  deriveStarterModuleName,
  resolveBackendTemplateValues,
  recommendTemplateForProject,
  detectBackendTemplateKey,
};
export type { BackendTemplateKey, BackendProjectTemplate };

import { formatDeployDuration } from './hooks/runtimeLockPolicy';
export { formatDeployDuration };

/** 默认产物目录，空值表示自动识别 */
export const DEFAULT_ARTIFACT_DIR = '';

/** 默认保留子目录，空值表示仅自动识别 */
export const DEFAULT_PRESERVE_SUB_DIRS = '';

/** 默认静态资源上传策略 */
export const DEFAULT_UPLOAD_STRATEGY: DeployUploadStrategy = 'overlayKeepAssets';

/** 静态资源上传策略选项 */
export const UPLOAD_STRATEGY_OPTIONS: Array<{ label: string; value: DeployUploadStrategy }> = [
  { label: '覆盖上传并保留旧资源（默认）', value: 'overlayKeepAssets' },
  { label: '清空后替换（可能中断已打开页面）', value: 'cleanReplace' },
];

/** 静态资源上传策略展示文案 */
export const UPLOAD_STRATEGY_LABEL_MAP: Record<DeployUploadStrategy, string> = {
  cleanReplace: '清空后替换',
  overlayKeepAssets: '覆盖保留旧资源',
};

/** 发布失败时顶部区域的简短说明，完整错误保留在日志编辑器中 */
export const DEPLOY_FAILURE_BRIEF = '发布已中断，完整错误信息请查看下方发布日志。';

/** 旧记录无操作人时的兜底展示文案 */
export const UNKNOWN_OPERATOR_TEXT = '未知操作人';

/**
 * 判断发布记录的操作类型。
 * @param record 发布记录
 * @returns 操作类型
 */
export const getDeployRecordAction = (record?: Pick<DeployRecord, 'action' | 'branch'> | null): DeployRecordAction => {
  if (record?.action) return record.action;
  const branch = String(record?.branch || '');
  if (branch.startsWith('undo-rollback-')) return 'undoRollback';
  return branch.startsWith('rollback-') ? 'rollback' : 'deploy';
};

/**
 * 获取发布记录操作类型展示文案。
 * @param record 发布记录
 * @returns 操作类型文案
 */
export const getDeployRecordActionLabel = (record?: Pick<DeployRecord, 'action' | 'branch'> | null): string => {
  const action = getDeployRecordAction(record);
  if (action === 'rollback') return '回滚';
  if (action === 'undoRollback') return '撤销回滚';
  return '发布';
};

/**
 * 获取运行中任务操作类型展示文案。
 * @param action 运行中任务类型
 * @returns 操作类型文案
 */
export const getDeployProgressActionLabel = (action?: DeployProgressSnapshot['action'] | null): string => {
  if (action === 'rollback') return '回滚';
  if (action === 'undoRollback') return '撤销回滚';
  if (action === 'openapi') return '生成 OpenAPI';
  if (action === 'start') return '启动';
  if (action === 'stop') return '停止';
  if (action === 'restart') return '重启';
  return '发布';
};

/**
 * 获取发布记录发布人展示文案。
 * @param record 发布记录
 * @returns 发布人文案
 */
export const getDeployRecordOperator = (record?: Pick<DeployRecord, 'operator'> | null): string => {
  return String(record?.operator || '').trim() || UNKNOWN_OPERATOR_TEXT;
};

/**
 * 获取发布记录提交信息展示文案。
 * @param record 发布记录
 * @returns 提交信息文案
 */
export const getDeployRecordCommitMessage = (record?: Pick<DeployRecord, 'commitMessage'> | null): string => {
  return String(record?.commitMessage || '').trim() || '-';
};

/**
 * 获取发布记录提交人展示文案。
 * @param record 发布记录
 * @returns 提交人文案
 */
export const getDeployRecordCommitAuthor = (record?: Pick<DeployRecord, 'commitAuthor'> | null): string => {
  return String(record?.commitAuthor || '').trim() || '-';
};

/**
 * 获取发布记录短 Commit。
 * @param record 发布记录
 * @returns 短 Commit 文案
 */
export const getDeployRecordShortCommit = (record?: Pick<DeployRecord, 'commitSha'> | null): string => {
  const commitSha = String(record?.commitSha || '').trim();
  return commitSha ? commitSha.slice(0, 8) : '-';
};

/**
 * 格式化发布记录引用。
 * @param recordId 发布记录 ID
 * @returns 记录引用文案
 */
export const formatDeployRecordRef = (recordId?: number | string | null): string => {
  const id = Number(recordId || 0);
  return id ? `#${id}` : '-';
};

/**
 * 获取发布记录来源展示文案。
 * @param record 发布记录
 * @returns 来源记录文案
 */
export const getDeployRecordSourceText = (record?: Pick<DeployRecord, 'sourceRecordId'> | null): string => {
  return formatDeployRecordRef(record?.sourceRecordId);
};

/** 发布记录状态展示配置 */
export const DEPLOY_RECORD_STATUS_META: Record<DeployRecord['status'], { label: string; color: string }> = {
  running: { label: '执行中', color: 'processing' },
  success: { label: '成功', color: 'success' },
  failed: { label: '失败', color: 'error' },
  stopped: { label: '已停止', color: 'default' },
};

/**
 * 获取发布记录状态展示文案。
 * @param status 发布记录状态
 * @returns 状态文案
 */
export const getDeployRecordStatusLabel = (status?: DeployRecord['status'] | null): string => {
  return status ? DEPLOY_RECORD_STATUS_META[status]?.label || String(status) : '-';
};

/**
 * 获取发布记录状态标签颜色。
 * @param status 发布记录状态
 * @returns Ant Design Vue Tag 颜色
 */
export const getDeployRecordStatusColor = (status?: DeployRecord['status'] | null): string => {
  return status ? DEPLOY_RECORD_STATUS_META[status]?.color || 'default' : 'default';
};

/** 运行中任务阶段展示文案 */
export const DEPLOY_PROGRESS_STAGE_LABEL_MAP: Record<string, string> = {
  validate: '参数校验',
  clone: '拉取代码',
  install: '安装依赖',
  build: '构建产物',
  upload: '上传产物',
  nginx: '校验 Nginx',
  reload: '重载 Nginx',
  start: '启动服务',
  stop: '停止服务',
  restart: '重启服务',
  rollback: '恢复版本',
  finish: '收尾',
};

/**
 * 获取运行中任务当前阶段文案。
 * @param snapshot 运行中任务快照
 * @returns 阶段文案
 */
export const getDeployProgressStageLabel = (snapshot?: DeployProgressSnapshot | null): string => {
  const stageEvent = [...(snapshot?.events || [])].reverse().find((event) => event.type === 'stage');
  if (stageEvent?.type === 'stage' && stageEvent.message) return stageEvent.message;
  const stageKey = String(snapshot?.currentStage || '').trim();
  return stageKey ? DEPLOY_PROGRESS_STAGE_LABEL_MAP[stageKey] || stageKey : '执行中';
};

/**
 * 判断发布阶段是否可用于失败标题。
 * @param stageKey 发布阶段标识
 * @returns 是否为已知发布阶段
 */
const isKnownDeployFailureStage = (stageKey?: string | null): stageKey is keyof typeof DEPLOY_PROGRESS_STAGE_LABEL_MAP => {
  const normalizedStageKey = String(stageKey || '').trim();
  return Boolean(normalizedStageKey && normalizedStageKey !== 'error' && DEPLOY_PROGRESS_STAGE_LABEL_MAP[normalizedStageKey]);
};

/**
 * 获取发布失败事件关联的阶段标识。
 * @param events 发布进度事件
 * @param fallbackStage 兜底阶段标识
 * @returns 已知失败阶段标识
 */
export const getDeployProgressFailureStageKey = (events: DeployProgressEvent[] = [], fallbackStage?: string | null): string => {
  const errorEvent = [...events].reverse().find((event) => event.type === 'error' && isKnownDeployFailureStage(event.stage));
  if (errorEvent?.type === 'error' && isKnownDeployFailureStage(errorEvent.stage)) return errorEvent.stage;
  const stageEvent = [...events].reverse().find((event) => event.type === 'stage' && isKnownDeployFailureStage(event.stage));
  if (stageEvent?.type === 'stage' && isKnownDeployFailureStage(stageEvent.stage)) return stageEvent.stage;
  return isKnownDeployFailureStage(fallbackStage) ? String(fallbackStage) : '';
};

/**
 * 获取发布进度失败标题。
 * @param params 失败标题计算参数
 * @returns 失败标题
 */
export const getDeployProgressFailureTitle = (params: {
  action?: DeployProgressSnapshot['action'] | null;
  events?: DeployProgressEvent[] | null;
  fallbackStage?: string | null;
}): string => {
  if (params.action === 'rollback') return '回滚失败';
  if (params.action === 'undoRollback') return '撤销回滚失败';
  if (params.action === 'start') return '启动失败';
  if (params.action === 'stop') return '停止失败';
  if (params.action === 'restart') return '重启失败';
  const stageKey = getDeployProgressFailureStageKey(params.events || [], params.fallbackStage);
  return stageKey ? `${DEPLOY_PROGRESS_STAGE_LABEL_MAP[stageKey]}失败` : '发布失败';
};

/**
 * 格式化部署目标运行态展示文案。
 * @param snapshot 运行中任务快照
 * @returns 运行态文案
 */
export const formatDeployTargetRuntimeStatus = (snapshot?: DeployProgressSnapshot | null): string => {
  if (!snapshot?.running) return '空闲';
  return `正在${getDeployProgressActionLabel(snapshot.action)} · ${getDeployProgressStageLabel(snapshot)}`;
};

/** 日期时间格式化器 */
const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/**
 * 格式化部署日期时间，后端 ISO 时间统一在前端按浏览器本地时区展示。
 * @param value ISO 日期字符串
 * @returns 本地日期时间
 */
export const formatDeployDateTime = (value?: string | number | null): string => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return dateTimeFormatter.format(date).replace(/\//g, '-');
};

/** 服务器表格列 */
export const serverColumns: YTableColumn[] = [
  { field: 'name', title: '服务器名称', minWidth: 220 },
  { field: 'host', title: 'IP / 域名', minWidth: 160 },
  { field: 'port', title: '端口', width: 80, align: 'center' },
  { field: 'username', title: '账号', width: 120 },
  {
    field: 'authType',
    title: '认证方式',
    width: 110,
    formatter: ({ row }) => (row.authType === 'privateKey' ? 'SSH 私钥' : '密码'),
  },
  {
    field: 'nginxRuntime',
    title: 'Nginx 状态',
    width: 120,
    align: 'center',
    formatter: ({ row }) => {
      const runtime = row.nginxRuntime;
      if (!runtime) return '未初始化';
      if (runtime.status === 'running') return '运行中';
      if (runtime.status === 'stopped') return '已停止';
      if (runtime.status === 'error') return '异常';
      return runtime.initializedAt ? '已初始化' : '未初始化';
    },
  },
  { field: 'remark', title: '备注', minWidth: 180 },
];

/** 部署目标表格列 */
export const targetColumns: YTableColumn[] = [
  { field: 'projectName', title: '项目名称', minWidth: 280, fixed: 'left', showOverflow: false, slots: { default: 'projectName' } },
  { field: 'projectType', title: '类型', width: 80, align: 'center', formatter: ({ cellValue }) => cellValue === 'backend' ? '后端' : '前端' },
  { field: 'defaultBranch', title: '分支', minWidth: 200, align: 'center', showOverflow: false, slots: { default: 'defaultBranch' } },
  { field: 'remark', title: '备注', minWidth: 140 },
  {
    field: 'runtimeStatus',
    title: '运行态',
    width: 120,
    align: 'center',
    showOverflow: false,
    slots: { default: 'runtimeStatus' },
  },
  { field: 'serverName', title: '服务器', minWidth: 160, showOverflow: false, slots: { default: 'serverName' } },
  { field: 'deployRoot', title: '部署根目录', minWidth: 240 },
  { field: 'serviceRole', title: '服务角色', width: 90, align: 'center', formatter: ({ row }) => row.projectType === 'backend' ? (row.serviceRole === 'gateway' ? 'Gateway' : '业务服务') : '-' },
  { field: 'serverPort', title: '服务端口', width: 90, align: 'center', formatter: ({ row }) => row.projectType === 'backend' ? row.serverPort || '-' : '-' },
  { field: 'serviceLinks', title: '服务地址', minWidth: 230, showOverflow: false, slots: { default: 'serviceLinks' } },
  { field: 'visitUrl', title: '页面访问地址', minWidth: 220, showOverflow: false, slots: { default: 'visitUrl' } },
  { field: 'nginxInstanceName', title: 'Nginx 实例', minWidth: 90, formatter: ({ row }) => row.nginxInstanceName || '-' },
  { field: 'listenPort', title: '监听端口', width: 90, align: 'center', formatter: ({ row }) => (row.nginxSiteManaged ? row.listenPort || '-' : '-') },
  { field: 'nginxServerName', title: 'server_name', minWidth: 120, formatter: ({ row }) => (row.nginxSiteManaged ? row.nginxServerName || '_' : '-') },
  { field: 'nginxConfPath', title: 'Nginx 配置文件', minWidth: 220 },
  { field: 'uploadStrategy', title: '上传策略', minWidth: 130, formatter: ({ cellValue }) => UPLOAD_STRATEGY_LABEL_MAP[cellValue as DeployUploadStrategy] || UPLOAD_STRATEGY_LABEL_MAP.overlayKeepAssets },
  { field: 'preserveSubDirs', title: '保留子目录', minWidth: 90, formatter: ({ cellValue }) => String(cellValue || '自动识别') },
  // { field: 'envName', title: '环境', width: 90, align: 'center' },
];

/** 发布记录表格列 */
export const recordColumns: YTableColumn[] = [
  { field: 'projectName', title: '项目名称', minWidth: 240, fixed: 'left', showOverflow: false, slots: { default: 'projectName' } },
  { field: 'serverName', title: '服务器', minWidth: 160, showOverflow: false, slots: { default: 'serverName' } },
  { field: 'operator', title: '发布人', width: 90, formatter: ({ row }) => getDeployRecordOperator(row) },
  { field: 'branch', title: '分支', width: 120 },
  { field: 'commitMessage', title: '当前生效提交信息', minWidth: 280, showOverflow: false, slots: { default: 'commitMessage' } },
  { field: 'commitAuthor', title: '提交人', width: 80, formatter: ({ row }) => getDeployRecordCommitAuthor(row) },
  { field: 'releasePath', title: '发布目录', minWidth: 240, showOverflow: false, slots: { default: 'releasePath' } },
  { field: 'startedAt', minWidth: 160, title: '开始时间', formatter: ({ cellValue }) => formatDeployDateTime(cellValue) },
  { field: 'duration', width: 90, title: '耗时', align: 'center', formatter: ({ row }) => formatDeployDuration(row.startedAt, row.finishedAt) },
  { field: 'action', title: '操作类型', width: 100, align: 'center', formatter: ({ row }) => getDeployRecordActionLabel(row) },
  { field: 'sourceRecordId', title: '回滚来源', width: 80, align: 'center', formatter: ({ row }) => getDeployRecordSourceText(row) },
  { field: 'status', title: '状态', minWidth: 80, align: 'center', showOverflow: false, fixed: 'right' },
  // { field: 'envName', title: '环境', width: 90, align: 'center' },
];

/** 发布节点状态 */
export type PublishStageStatus = 'wait' | 'process' | 'finish' | 'error' | 'stopped';

/** 发布节点类型 */
export interface PublishStage {
  key: string;
  title: string;
  percent: number;
  nginxOption?: 'enableNginxTest' | 'enableNginxReload';
}

/** 发布流程节点 */
export const publishStages: PublishStage[] = [
  { key: 'validate', title: '参数校验', percent: 5 },
  { key: 'clone', title: '拉取代码', percent: 15 },
  { key: 'install', title: '安装依赖', percent: 30 },
  { key: 'build', title: '构建产物', percent: 48 },
  { key: 'upload', title: '上传产物', percent: 66 },
  { key: 'nginx', title: '校验 Nginx', percent: 82, nginxOption: 'enableNginxTest' },
  { key: 'reload', title: '重载 Nginx', percent: 92, nginxOption: 'enableNginxReload' },
  { key: 'finish', title: '发布完成', percent: 100 },
];

/** 服务器配置 Formily Schema */
export const serverFormSchema = {
  type: 'object',
  properties: {
    layout: {
      type: 'void',
      'x-component': 'FormLayout',
      'x-component-props': {
        layout: 'horizontal',
        labelAlign: 'right',
        labelWidth: 124,
      },
      properties: {
        basicSection: {
          type: 'void',
          'x-component': 'Slot',
          'x-component-props': { name: 'serverBasicSection' },
        },
        basicGrid: {
          type: 'void',
          'x-component': 'FormGrid',
          'x-component-props': {
            maxColumns: 2,
            minColumns: 1,
            minWidth: 270,
            columnGap: 18,
            rowGap: 0,
          },
          properties: {
            name: {
              type: 'string',
              title: '服务器名称',
              required: true,
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': {
                placeholder: '例如：测试 Nginx 服务器',
                autocapitalize: 'none',
                autocorrect: 'off',
                spellcheck: false,
              },
            },
            host: {
              type: 'string',
              title: 'IP / 域名',
              required: true,
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': {
                placeholder: '例如：192.168.1.10',
                autocapitalize: 'none',
                autocorrect: 'off',
                spellcheck: false,
              },
            },
            port: {
              type: 'number',
              title: 'SSH 端口',
              required: true,
              'x-decorator': 'FormItem',
              'x-component': 'InputNumber',
            },
            username: {
              type: 'string',
              title: '登录账号',
              required: true,
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': {
                autocapitalize: 'none',
                autocorrect: 'off',
                spellcheck: false,
              },
            },
          },
        },
        authSection: {
          type: 'void',
          'x-component': 'Slot',
          'x-component-props': { name: 'serverAuthSection' },
        },
        authGrid: {
          type: 'void',
          'x-component': 'FormGrid',
          'x-component-props': {
            maxColumns: 2,
            minColumns: 1,
            minWidth: 270,
            columnGap: 18,
            rowGap: 0,
          },
          properties: {
            authType: {
              type: 'string',
              title: '认证方式',
              required: true,
              enum: [
                { label: '密码', value: 'password' },
                { label: 'SSH Key', value: 'privateKey' },
              ],
              'x-decorator': 'FormItem',
              'x-component': 'Select',
            },
            password: {
              type: 'string',
              title: '登录密码',
              'x-decorator': 'FormItem',
              'x-component': 'Password',
              'x-component-props': { placeholder: '编辑时留空表示沿用原凭据' },
            },
            privateKey: {
              type: 'string',
              title: 'SSH 私钥',
              'x-decorator': 'FormItem',
              'x-decorator-props': { gridSpan: 2 },
              'x-component': 'Input.TextArea',
              'x-component-props': { rows: 5, placeholder: '编辑时留空表示沿用原凭据' },
            },
            passphrase: {
              type: 'string',
              title: '私钥口令',
              'x-decorator': 'FormItem',
              'x-component': 'Password',
              'x-component-props': { placeholder: '如私钥无口令可留空' },
            },
            remark: {
              type: 'string',
              title: '备注',
              'x-decorator': 'FormItem',
              'x-decorator-props': { gridSpan: 2 },
              'x-component': 'Input.TextArea',
              'x-component-props': { rows: 2 },
            },
          },
        },
        nginxSection: {
          type: 'void',
          'x-component': 'Slot',
          'x-component-props': { name: 'serverNginxSection' },
        },
        nginxGrid: {
          type: 'void',
          'x-component': 'FormGrid',
          'x-component-props': {
            maxColumns: 2,
            minColumns: 1,
            minWidth: 270,
            columnGap: 18,
            rowGap: 0,
          },
          properties: {
            defaultDeployRoot: {
              type: 'string',
              title: '默认部署根目录',
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': { placeholder: '/opt/yuyan/html' },
            },
            defaultBackendRoot: {
              type: 'string',
              title: '后端项目根目录',
              required: true,
              'x-decorator': 'FormItem',
              'x-decorator-props': { tooltip: '每个后端目标的部署根目录必须位于此目录下，例如 /home/guest/huagui/backend' },
              'x-component': 'Input',
              'x-component-props': { placeholder: '/opt/yuyan/backend' },
            },
            defaultNginxConfPath: {
              type: 'string',
              title: '默认配置文件',
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': { placeholder: '/opt/yuyan/nginx/conf/nginx.conf' },
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
              'x-component': 'Input',
              'x-component-props': { placeholder: 'nginx -t' },
            },
            nginxReloadCommand: {
              type: 'string',
              title: '重载命令',
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': { placeholder: 'nginx -s reload' },
            },
          },
        },
      },
    },
  },
};

/** 部署配置 Formily Schema */
export const targetFormSchema = {
  type: 'object',
  properties: {
    layout: {
      type: 'void',
      'x-component': 'FormLayout',
      'x-component-props': {
        layout: 'horizontal',
        labelAlign: 'right',
        labelWidth: 160,
      },
      properties: {
        basicSection: {
          type: 'void',
          'x-component': 'Slot',
          'x-component-props': { name: 'targetBasicSection' },
        },
        basicGrid: {
          type: 'void',
          'x-component': 'FormGrid',
          'x-component-props': {
            maxColumns: 2,
            minColumns: 1,
            minWidth: 270,
            columnGap: 18,
            rowGap: 0,
          },
          properties: {
            projectSource: {
              type: 'string',
              title: '项目来源',
              required: true,
              enum: PROJECT_SOURCE_OPTIONS,
              'x-decorator': 'FormItem',
              'x-decorator-props': { gridSpan: 2 },
              'x-component': 'Select',
            },
            projectId: {
              type: 'number',
              title: '项目',
              required: true,
              enum: [],
              'x-decorator': 'FormItem',
              'x-component': 'Select',
              'x-component-props': {
                showSearch: true,
                filterOption: false,
                optionLabelProp: 'title',
                class: 'project-select',
                popupClassName: 'project-select-dropdown',
                placeholder: '请输入项目名称搜索或选择',
                listItemHeight: 56,
                listHeight: 280,
                autocapitalize: 'none',
                autocorrect: 'off',
                spellcheck: false,
              },
            },
            remark: {
              type: 'string',
              title: '备注',
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': {
                placeholder: '请输入备注',
                autocapitalize: 'none',
                autocorrect: 'off',
                spellcheck: false,
              },
            },
            defaultBranch: {
              type: 'string',
              title: '部署分支',
              required: true,
              enum: [],
              'x-decorator': 'FormItem',
              'x-component': 'Select',
              'x-component-props': {
                showSearch: true,
                optionFilterProp: 'searchKey',
                optionLabelProp: 'title',
                class: 'project-select',
                popupClassName: 'project-select-dropdown',
                placeholder: '请选择分支',
                listItemHeight: 56,
                listHeight: 280,
                autocapitalize: 'none',
                autocorrect: 'off',
                spellcheck: false,
              },
            },
            envName: {
              type: 'string',
              title: '环境',
              required: true,
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': { disabled: true },
            },
            serverId: {
              type: 'number',
              title: '部署服务器',
              required: true,
              enum: [],
              'x-decorator': 'FormItem',
              'x-component': 'Select',
            },
            nginxInstanceId: {
              type: 'number',
              title: 'Nginx 实例',
              required: true,
              enum: [],
              'x-decorator': 'FormItem',
              'x-component': 'Select',
              'x-reactions': {
                dependencies: ['.projectType'],
                fulfill: {
                  state: {
                    visible: '{{$deps[0] !== "backend"}}',
                  },
                },
              },
            },
            projectType: {
              type: 'string',
              title: '项目类型',
              required: true,
              enum: [
                { label: '前端项目', value: 'frontend' },
                { label: '后端项目', value: 'backend' },
              ],
              'x-decorator': 'FormItem',
              'x-component': 'Select',
              'x-component-props': { placeholder: '请选择项目类型' },
            },
            backendTemplate: {
              type: 'string',
              title: '后端模板画像',
              required: false,
              enum: BACKEND_TEMPLATE_OPTIONS,
              'x-decorator': 'FormItem',
              'x-component': 'Select',
              'x-component-props': { placeholder: '选择工程模板自动填充' },
              'x-reactions': {
                dependencies: ['.projectType'],
                fulfill: {
                  state: {
                    visible: '{{$deps[0] === "backend"}}',
                  },
                },
              },
            },
            requiredJdkAlias: {
              type: 'string',
              title: '本机构建 Java 版本',
              required: true,
              enum: [
                { label: 'Java 8 (1.8)', value: '8' },
                { label: 'Java 11', value: '11' },
                { label: 'Java 17', value: '17' },
                { label: 'Java 21', value: '21' },
              ],
              'x-decorator': 'FormItem',
              'x-component': 'Select',
              'x-reactions': {
                dependencies: ['.projectType'],
                fulfill: {
                  state: {
                    visible: '{{$deps[0] === "backend"}}',
                  },
                },
              },
            },
            serviceRole: {
              type: 'string',
              title: '服务角色',
              required: true,
              enum: [
                { label: '业务服务', value: 'application' },
                { label: 'Gateway 网关', value: 'gateway' },
              ],
              'x-decorator': 'FormItem',
              'x-component': 'Select',
              'x-reactions': {
                dependencies: ['.projectType'],
                fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } },
              },
            },
            environmentId: {
              type: 'number',
              title: '共享环境配置',
              enum: [],
              'x-decorator': 'FormItem',
              'x-component': 'Select',
              'x-component-props': { allowClear: true, placeholder: '可选；继承 Nacos/Gateway 地址' },
              'x-reactions': {
                dependencies: ['.projectType'],
                fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } },
              },
            },
            serviceName: {
              type: 'string',
              title: '服务名称',
              required: true,
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': { placeholder: '例如 trade-service 或 valuation-outsourced' },
              'x-reactions': {
                dependencies: ['.projectType'],
                fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } },
              },
            },
            runtimeJavaHome: {
              type: 'string',
              title: '运行 JDK 路径',
              required: true,
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': { placeholder: '例如 /usr/lib/jvm/java-8-openjdk' },
              'x-reactions': {
                dependencies: ['.projectType'],
                fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } },
              },
            },
            serverPort: {
              type: 'number',
              title: '服务端口',
              required: true,
              'x-decorator': 'FormItem',
              'x-component': 'InputNumber',
              'x-component-props': { min: 1, max: 65535, style: { width: '100%' } },
              'x-reactions': {
                dependencies: ['.projectType'],
                fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } },
              },
            },
            processMode: {
              type: 'string',
              title: '进程管理',
              required: true,
              enum: [
                { label: 'PID 脚本', value: 'pid' },
                { label: 'systemd（自动回退 PID）', value: 'systemd' },
              ],
              'x-decorator': 'FormItem',
              'x-component': 'Select',
              'x-reactions': {
                dependencies: ['.projectType'],
                fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } },
              },
            },
          },
        },
        pathSection: {
          type: 'void',
          'x-component': 'Slot',
          'x-component-props': { name: 'targetPathSection' },
        },
        pathGrid: {
          type: 'void',
          'x-component': 'FormGrid',
          'x-component-props': {
            maxColumns: 2,
            minColumns: 1,
            minWidth: 270,
            columnGap: 18,
            rowGap: 0,
          },
          properties: {
            deployRoot: {
              type: 'string',
              title: '部署根目录',
              required: true,
              'x-decorator': 'FormItem',
              'x-component': 'Slot',
              'x-component-props': { name: 'deployRoot' },
              'x-validator': [
                { required: true, whitespace: true, message: '请输入部署根目录' },
                { pattern: /^\//, message: '部署根目录必须是绝对路径' },
              ],
            },
            nginxConfPath: {
              type: 'string',
              title: 'Nginx 配置文件',
              required: true,
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-reactions': {
                dependencies: ['projectType'],
                fulfill: { state: { visible: '{{$deps[0] !== "backend"}}' } },
              },
            },
            nginxSiteManaged: {
              type: 'boolean',
              title: '平台管理站点',
              'x-decorator': 'FormItem',
              'x-decorator-props': {
                tooltip: '开启后，保存目标会同步 Nginx 站点配置并执行校验、重载。服务器已手工配置好 Nginx 时请关闭，平台仍会正常发布前端产物。',
              },
              'x-component': 'Switch',
              'x-component-props': { checkedChildren: '开', unCheckedChildren: '关' },
              'x-reactions': {
                dependencies: ['projectType'],
                fulfill: { state: { visible: '{{$deps[0] !== "backend"}}' } },
              },
            },
            visitUrl: {
              type: 'string',
              title: '访问地址',
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-reactions': {
                dependencies: ['projectType', '.nginxSiteManaged'],
                fulfill: { state: { visible: '{{$deps[0] !== "backend" && $deps[1]}}' } },
              },
            },
            listenPort: {
              type: 'number',
              title: '监听端口',
              'x-decorator': 'FormItem',
              'x-component': 'InputNumber',
              'x-component-props': { min: 1, max: 65535, placeholder: '自动分配' },
              'x-reactions': {
                dependencies: ['projectType', '.nginxSiteManaged'],
                fulfill: { state: { visible: '{{$deps[0] !== "backend" && $deps[1]}}' } },
              },
            },
            serverName: {
              type: 'string',
              title: 'server_name',
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': { placeholder: '_' },
              'x-reactions': {
                dependencies: ['projectType', '.nginxSiteManaged'],
                fulfill: { state: { visible: '{{$deps[0] !== "backend" && $deps[1]}}' } },
              },
            },
          },
        },
        publishSection: {
          type: 'void',
          'x-component': 'Slot',
          'x-component-props': { name: 'targetPublishSection' },
        },
        publishGrid: {
          type: 'void',
          'x-component': 'FormGrid',
          'x-component-props': {
            maxColumns: 2,
            minColumns: 1,
            minWidth: 270,
            columnGap: 18,
            rowGap: 0,
          },
          properties: {
            enableNginxTest: {
              type: 'boolean',
              title: '校验 Nginx',
              'x-decorator': 'FormItem',
              'x-component': 'Switch',
              'x-component-props': { checkedChildren: '开', unCheckedChildren: '关' },
              'x-reactions': {
                dependencies: ['projectType'],
                fulfill: { state: { visible: '{{$deps[0] !== "backend"}}' } },
              },
            },
            enableNginxReload: {
              type: 'boolean',
              title: '重载 Nginx',
              'x-decorator': 'FormItem',
              'x-component': 'Switch',
              'x-component-props': { checkedChildren: '开', unCheckedChildren: '关' },
              'x-reactions': {
                dependencies: ['projectType'],
                fulfill: { state: { visible: '{{$deps[0] !== "backend"}}' } },
              },
            },
            installCommand: {
              type: 'string',
              title: '安装命令',
              required: true,
              'x-decorator': 'FormItem',
              'x-decorator-props': { gridSpan: 2 },
              'x-component': 'Input.TextArea',
              'x-component-props': { rows: 3, placeholder: '每行一条命令，例如：\npnpm install\npnpm --filter app install' },
              'x-reactions': {
                dependencies: ['projectType'],
                fulfill: {
                  state: {
                    title: '{{$deps[0] === "backend" ? "Maven 依赖命令" : "安装命令"}}',
                    required: '{{$deps[0] !== "backend"}}',
                    componentProps: {
                      placeholder: '{{$deps[0] === "backend" ? "每行一条命令，可选（若已在打包命令中处理则可空）。示例：\\n./mvnw -nsu dependency:resolve" : "每行一条命令，例如：\\npnpm install\\npnpm --filter app install"}}'
                    }
                  }
                }
              }
            },
            buildCommand: {
              type: 'string',
              title: '构建命令',
              required: true,
              'x-decorator': 'FormItem',
              'x-decorator-props': { gridSpan: 2 },
              'x-component': 'Input.TextArea',
              'x-component-props': { rows: 3, placeholder: '每行一条命令，例如：\npnpm build\npnpm --filter app build' },
              'x-reactions': {
                dependencies: ['projectType'],
                fulfill: {
                  state: {
                    title: '{{$deps[0] === "backend" ? "Maven 打包命令" : "构建命令"}}',
                    componentProps: {
                      placeholder: '{{$deps[0] === "backend" ? "每行一条命令，例如：\\n./mvnw -nsu clean package -DskipTests\\n多模块微服务：./mvnw -nsu clean package -pl app-starter -am -DskipTests" : "每行一条命令，例如：\\npnpm build\\npnpm --filter app build"}}'
                    }
                  }
                }
              }
            },
            artifactDir: {
              type: 'string',
              title: '产物目录',
              required: false,
              'x-decorator': 'FormItem',
              'x-decorator-props': {
                tooltip:
                  '不填时发布系统会在本次构建后的仓库中自动查找静态产物目录；填写时请填构建产物在仓库内的相对路径，例如 packages/dist 或 packages/mainapp/dist。这里不会读取微应用 CI 配置，路径填错时发布日志会给出自动发现的建议路径。',
              },
              'x-component': 'Input',
              'x-component-props': { placeholder: '不填自动识别；示例：packages/dist' },
              'x-reactions': {
                dependencies: ['projectType'],
                fulfill: {
                  state: {
                    title: '{{$deps[0] === "backend" ? "Jar 产物相对路径" : "产物目录"}}',
                    required: '{{$deps[0] === "backend"}}',
                    decoratorProps: {
                      tooltip: '{{$deps[0] === "backend" ? "请填写打包后生成的 jar 包在仓库内的相对路径，例如：target/*.jar 或 app-starter/target/*.jar" : "不填时发布系统会在本次构建后的仓库中自动查找静态产物目录；填写时请填构建产物在仓库内的相对路径，例如 packages/dist。" }}'
                    },
                    componentProps: {
                      placeholder: '{{$deps[0] === "backend" ? "必填，示例：target/*.jar 或 starter/target/*.jar" : "不填自动识别；示例：packages/dist"}}'
                    }
                  }
                }
              }
            },
            preserveSubDirs: {
              type: 'string',
              title: '保留子目录',
              required: false,
              'x-decorator': 'FormItem',
              'x-decorator-props': {
                tooltip:
                  '默认会自动识别同一服务器下部署根目录位于当前目录内的部署目标，并在发布、失败恢复 and 回滚时保留这些顶层目录。这里可手动补充目录名，多个用逗号分隔，例如 insurance-risk, masterData。',
              },
              'x-component': 'Input',
              'x-component-props': { placeholder: '自动识别；手动补充示例：insurance-risk, masterData' },
              'x-reactions': {
                dependencies: ['projectType'],
                fulfill: { state: { visible: '{{$deps[0] !== "backend"}}' } },
              },
            },
            uploadStrategy: {
              type: 'string',
              title: '资源上传策略',
              required: true,
              enum: UPLOAD_STRATEGY_OPTIONS,
              'x-decorator': 'FormItem',
              'x-decorator-props': {
                gridSpan: 2,
                tooltip:
                  '覆盖上传并保留旧资源适合微应用平滑发布，会先发布静态资源、最后发布入口文件，并按最近发布次数自动清理旧 hash。清空后替换会删除旧资源，可能导致已打开页面切换路由失败。',
              },
              'x-component': 'Select',
              'x-reactions': {
                dependencies: ['projectType'],
                fulfill: { state: { visible: '{{$deps[0] !== "backend"}}' } },
              },
            },
            springProfiles: {
              type: 'string',
              title: 'Spring Profiles',
              'x-decorator': 'FormItem',
              'x-decorator-props': {
                tooltip: '留空时采用应用自身默认配置；如需填写，必须与服务器现有 startup.sh 的 spring.profiles.active 保持一致。检测项目配置不会自动覆盖此项。',
              },
              'x-component': 'Input',
              'x-component-props': { allowClear: true, placeholder: '可选，例如 test；不要根据文件名猜测' },
              'x-reactions': {
                dependencies: ['projectType'],
                fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } }
              }
            },
            externalConfigPath: {
              type: 'string',
              title: '外部配置路径',
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': { placeholder: '可选，例如 /home/guest/.../shared/config/' },
              'x-reactions': {
                dependencies: ['projectType'],
                fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } }
              }
            },
            jvmOptions: {
              type: 'string',
              title: 'JVM 参数',
              'x-decorator': 'FormItem',
              'x-decorator-props': { gridSpan: 2 },
              'x-component': 'Input.TextArea',
              'x-component-props': { rows: 2, placeholder: '例如 -Xms512m -Xmx1024m' },
              'x-reactions': {
                dependencies: ['projectType'],
                fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } }
              }
            },
            appArgs: {
              type: 'string',
              title: '应用参数',
              'x-decorator': 'FormItem',
              'x-decorator-props': { gridSpan: 2 },
              'x-component': 'Input.TextArea',
              'x-component-props': { rows: 2, placeholder: '可选的 Spring Boot 命令行参数' },
              'x-reactions': {
                dependencies: ['projectType'],
                fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } }
              }
            },
            stopTimeoutSeconds: {
              type: 'number',
              title: '停止超时（秒）',
              'x-decorator': 'FormItem',
              'x-component': 'InputNumber',
              'x-component-props': { min: 5, max: 300, style: { width: '100%' } },
              'x-reactions': { dependencies: ['projectType'], fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } } },
            },
            startupTimeoutSeconds: {
              type: 'number',
              title: '启动超时（秒）',
              'x-decorator': 'FormItem',
              'x-component': 'InputNumber',
              'x-component-props': { min: 10, max: 900, style: { width: '100%' } },
              'x-reactions': { dependencies: ['projectType'], fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } } },
            },
            healthCheckPath: {
              type: 'string',
              title: '健康检查路径',
              required: true,
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': { placeholder: '例如 /monitor/health' },
              'x-reactions': { dependencies: ['projectType'], fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } } },
            },
            nacosServerAddr: {
              type: 'string',
              title: 'Nacos 地址',
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': { placeholder: '例如 192.168.10.10:8848' },
              'x-reactions': { dependencies: ['projectType'], fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } } },
            },
            nacosConsoleUrl: {
              type: 'string',
              title: 'Nacos 控制台',
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': { placeholder: '例如 http://192.168.10.10:8848/nacos' },
              'x-reactions': { dependencies: ['projectType'], fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } } },
            },
            nacosNamespace: {
              type: 'string',
              title: 'Nacos Namespace',
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-reactions': { dependencies: ['projectType'], fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } } },
            },
            nacosGroup: {
              type: 'string',
              title: 'Nacos Group',
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': { placeholder: '例如 DEFAULT_GROUP' },
              'x-reactions': { dependencies: ['projectType'], fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } } },
            },
            requireNacosRegistration: {
              type: 'boolean',
              title: '校验 Nacos 注册',
              'x-decorator': 'FormItem',
              'x-component': 'Switch',
              'x-component-props': { checkedChildren: '开', unCheckedChildren: '关' },
              'x-reactions': { dependencies: ['projectType'], fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } } },
            },
            gatewayUrl: {
              type: 'string',
              title: 'Gateway 地址',
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': { placeholder: '例如 http://192.168.10.10:8080' },
              'x-reactions': { dependencies: ['projectType'], fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } } },
            },
            gatewayProbePath: {
              type: 'string',
              title: 'Gateway 探测路径',
              'x-decorator': 'FormItem',
              'x-component': 'Input',
              'x-component-props': { placeholder: '例如 /valuation/monitor/health' },
              'x-reactions': { dependencies: ['projectType'], fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } } },
            },
            openapiCommand: {
              type: 'string',
              title: 'OpenAPI 命令',
              'x-decorator': 'FormItem',
              'x-decorator-props': { gridSpan: 2 },
              'x-component': 'Input.TextArea',
              'x-component-props': { rows: 2 },
              'x-reactions': { dependencies: ['projectType'], fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } } },
            },
            openapiOutputPath: {
              type: 'string',
              title: 'OpenAPI 输出路径',
              'x-decorator': 'FormItem',
              'x-decorator-props': { gridSpan: 2 },
              'x-component': 'Input',
              'x-component-props': { placeholder: '仓库内相对路径，禁止 ..' },
              'x-reactions': { dependencies: ['projectType'], fulfill: { state: { visible: '{{$deps[0] === "backend"}}' } } },
            },
          },
        },
      },
    },
  },
};

/**
 * 将模板中的项目名占位符替换为真实项目名
 * @param value - 模板字符串
 * @param appName - 项目名
 * @returns 替换后的字符串
 */
export const applyProjectTemplate = (value: string, appName: string): string => String(value || '').replace(/\{appName\}/g, appName || '');
