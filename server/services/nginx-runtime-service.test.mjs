import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArchiveTarCommand } from './nginx-runtime-service.mjs';

/** 创建运行包命令测试配置。 */
const createConfig = (patch = {}) => ({
  useSudo: false,
  ...patch,
});

test('完整运行包排除部署备份、发布清单和 Nginx 运行态目录', () => {
  const command = buildArchiveTarCommand(createConfig(), 'opt/yuyan', 'all');

  assert.match(command, /tar -czf - -C \//);
  assert.equal(command.includes("--exclude='*/.yuyan-backups'"), true);
  assert.equal(command.includes("--exclude='*/.yuyan-backups/*'"), true);
  assert.equal(command.includes("--exclude='*/.yuyan-manifests'"), true);
  assert.equal(command.includes("--exclude='opt/yuyan/nginx/logs'"), true);
  assert.equal(command.includes("--exclude='opt/yuyan/nginx/run'"), true);
  assert.equal(command.includes("--exclude='*/yuyan-nginx.sh.bak.*'"), true);
});

test('仅前端静态产物也排除部署备份和发布清单', () => {
  const command = buildArchiveTarCommand(createConfig({ useSudo: true }), 'opt/yuyan/html', 'html');

  assert.match(command, /^sudo -n tar -czf - -C \//);
  assert.equal(command.includes("--exclude='*/.yuyan-backups'"), true);
  assert.equal(command.includes("--exclude='*/.yuyan-manifests'"), true);
  assert.equal(command.includes('nginx/logs'), false);
});
