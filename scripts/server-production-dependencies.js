/**
 * 桌面安装包内嵌服务所需的生产依赖。
 * @description 与根项目依赖分开安装，确保打包后的 server 目录可独立运行。
 */
export const serverProductionDependencies = {
  axios: '^1.11.0',
  compression: '^1.8.1',
  'connect-history-api-fallback': '^2.0.0',
  cors: '^2.8.5',
  express: '^5.1.0',
  ssh2: '^1.17.0',
  zod: '3.25.76',
};
