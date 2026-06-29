/**
 * 服务配置常量
 * @description 集中管理所有环境变量和应用配置
 */

import path from 'node:path';
import fs from 'node:fs';

/** 服务配置目录 */
const __dirnameResolved = path.dirname(new URL(import.meta.url).pathname);

/** 项目根目录 */
export const PROJECT_ROOT = path.resolve(path.join(__dirnameResolved, '..', '..'));

/**
 * 加载本地环境变量文件
 * @description 仅用于本地开发；系统环境变量优先级最高
 */
function loadLocalEnv() {
  const envFiles = [path.join(PROJECT_ROOT, '.env'), path.join(PROJECT_ROOT, '.env.local')];
  for (const filePath of envFiles) {
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      const rawValue = trimmed.slice(index + 1).trim();
      if (process.env[key]) continue;
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
    }
  }
}

loadLocalEnv();

/** 服务端口号 */
export const PORT = process.env.PORT ? Number(process.env.PORT) : 3100;

/** 模板仓库本地路径 */
export const TEMPLATE_REPO_PATH = process.env.TEMPLATE_REPO_PATH || '/opt/template';

/** 模板仓库远程 URL */
export const TEMPLATE_REPO_URL = process.env.TEMPLATE_REPO_URL || '';

/** 模板仓库分支名 */
export const TEMPLATE_BRANCH = process.env.TEMPLATE_BRANCH || 'template';

/** GitLab 服务地址 */
export const GITLAB_HOST = process.env.GITLAB_HOST || '';

/** GitLab 访问 Token */
export const GITLAB_TOKEN = process.env.GITLAB_TOKEN || '';

/** Git 用户名 */
export const GIT_USER_NAME = process.env.GIT_USER_NAME || '';

/** Git 用户邮箱 */
export const GIT_USER_EMAIL = process.env.GIT_USER_EMAIL || '';

/** 独立服务器部署数据目录 */
export const DEPLOY_DATA_DIR = process.env.DEPLOY_DATA_DIR || path.join(PROJECT_ROOT, '.yuyan-deploy');

/** 独立服务器部署 SQLite 数据库路径 */
export const DEPLOY_DB_PATH = process.env.DEPLOY_DB_PATH || path.join(DEPLOY_DATA_DIR, 'deploy.sqlite');

/** 独立服务器部署日志目录 */
export const DEPLOY_LOG_DIR = process.env.DEPLOY_LOG_DIR || path.join(DEPLOY_DATA_DIR, 'logs');

/** 桌面端更新静态资源根目录。 */
export const APP_UPDATE_DIR = process.env.APP_UPDATE_DIR || path.join(DEPLOY_DATA_DIR, 'app-updates');

/** 部署凭据加密密钥，生产环境必须显式配置 */
export const DEPLOY_SECRET_KEY = process.env.DEPLOY_SECRET_KEY || 'yuyan-ops-local-deploy-secret';

/** 每个项目保留的发布记录数 */
export const DEPLOY_RECORD_KEEP_PER_PROJECT = process.env.DEPLOY_RECORD_KEEP_PER_PROJECT ? Number(process.env.DEPLOY_RECORD_KEEP_PER_PROJECT) : 20;

/** 每个部署目标保留的远程备份版本数 */
export const DEPLOY_BACKUP_KEEP_PER_TARGET = process.env.DEPLOY_BACKUP_KEEP_PER_TARGET ? Number(process.env.DEPLOY_BACKUP_KEEP_PER_TARGET) : 8;

/** 内置 Nginx 运行时资源总目录（包含多个变体子目录） */
export const NGINX_RUNTIME_ASSET_DIR = process.env.NGINX_RUNTIME_ASSET_DIR || path.join(PROJECT_ROOT, 'server', 'assets', 'nginx-runtime');

/** 内置 Nginx 运行时变体注册表路径 */
export const NGINX_RUNTIME_REGISTRY_PATH = process.env.NGINX_RUNTIME_REGISTRY_PATH || path.join(NGINX_RUNTIME_ASSET_DIR, 'registry.json');

/** 前端构建目录（相对于 server 目录）*/
export const CLIENT_DIST = path.resolve(path.join(__dirnameResolved, '..', '..', 'dist'));

/** 临时文件清理间隔（毫秒）*/
export const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1小时

/** 临时文件过期时间（毫秒）*/
export const TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24小时
