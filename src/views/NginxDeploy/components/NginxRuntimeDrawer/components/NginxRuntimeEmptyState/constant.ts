/** 空态类型 */
export type NginxDrawerEmptyType = 'no_server' | 'no_instance';

/** 托管卡片配置 */
export const MANAGED_CARD_INFO = {
  title: '平台托管 Nginx',
  subtitle: '零运维成本 · 标准化目录',
  description: '由雨燕平台在目标服务器自动部署沙箱隔离的 Nginx 运行时，自带独立启动控制脚本、标准站点目录与日志归档。',
  buttonText: '一键托管初始化',
};

/** 已有实例卡片配置 */
export const EXTERNAL_CARD_INFO = {
  title: '扫描已有 Nginx',
  subtitle: '兼容已有资产 · 免迁移',
  description: '自动探测服务器上通过 apt/yum 或源码安装的现有 Nginx 主进程与 conf.d 站点配置，无缝纳管至雨燕平台。',
  buttonText: '智能发现已有 Nginx',
};
