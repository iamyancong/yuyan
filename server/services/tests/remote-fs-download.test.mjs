import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  formatFsDownloadTimestamp,
  sanitizeFsFileNamePart,
  parseDownloadPaths,
  buildBatchTarCommand,
  buildHiddenExcludeArgs,
  calculateRemoteFsSize,
  FS_SIZE_TIMEOUT_MS,
  createDownloadTicket,
  consumeDownloadTicket,
  isTicketedFsDownloadRequest,
} from '../remote-fs-service.mjs';
import { buildSafeContentDisposition } from '../../utils/http-header-utils.mjs';

test('formatFsDownloadTimestamp 能够生成固定长度的纯数字时间戳', () => {
  const fixedDate = new Date('2026-09-24T14:15:30Z');
  const timestamp = formatFsDownloadTimestamp(fixedDate);
  assert.equal(timestamp.length, 14);
  assert.match(timestamp, /^\d{14}$/);
});

test('sanitizeFsFileNamePart 过滤非法字符与特殊符号并保留有效字符', () => {
  assert.equal(sanitizeFsFileNamePart('my folder name', 'fallback'), 'my-folder-name');
  assert.equal(sanitizeFsFileNamePart('path/to/folder:special?*', 'fallback'), 'path-to-folder-special');
  assert.equal(sanitizeFsFileNamePart('', 'default-dir'), 'default-dir');
  assert.equal(sanitizeFsFileNamePart('   ', 'fallback'), 'fallback');
  assert.equal(sanitizeFsFileNamePart('华贵委外 192.168.1.1', 'fallback'), '华贵委外-192.168.1.1');
});

test('buildSafeContentDisposition 能防止非 ASCII 字符导致 Node.js ERR_INVALID_CHAR 崩溃', () => {
  const chineseFileName = '国寿海外星河系统-192.168.165.13-dmDataService-20260924151700.tar.gz';
  const headerValue = buildSafeContentDisposition(chineseFileName);

  // 1. 验证在 Node.js 原生 http.OutgoingMessage 中 setHeader 不报错
  const msg = new http.OutgoingMessage();
  assert.doesNotThrow(() => {
    msg.setHeader('Content-Disposition', headerValue);
  });

  // 2. 验证 filename="..." 部分绝不含码点 > 127 的字符
  const plainMatch = headerValue.match(/filename="([^"]+)"/);
  assert.ok(plainMatch, '应当包含 filename="..."');
  for (let i = 0; i < plainMatch[1].length; i++) {
    assert.ok(plainMatch[1].charCodeAt(i) <= 127, `字符 ${plainMatch[1][i]} 不属于 ASCII 范围`);
  }

  // 3. 验证 filename* 包含标准 UTF-8 编码且可完美还原中文原名
  const utf8Match = headerValue.match(/filename\*=UTF-8''([^;]+)/);
  assert.ok(utf8Match, '应当包含 filename*=UTF-8\'\'...');
  assert.equal(decodeURIComponent(utf8Match[1]), chineseFileName);
});

test('buildSafeContentDisposition 处理纯 ASCII 文件名保持优雅与干净', () => {
  const asciiFileName = 'nginx-12-config.tar.gz';
  const headerValue = buildSafeContentDisposition(asciiFileName);
  const msg = new http.OutgoingMessage();
  assert.doesNotThrow(() => {
    msg.setHeader('Content-Disposition', headerValue);
  });
  assert.ok(headerValue.includes('filename="nginx-12-config.tar.gz"'));
  assert.ok(headerValue.includes("filename*=UTF-8''nginx-12-config.tar.gz"));
});

test('parseDownloadPaths: 正确解析单路径并保留含逗号的文件名', () => {
  // 单路径传参（绝不按逗号拆分）
  const commaPath = '/var/log/nginx/access,2026-10-09,backup.log';
  const result1 = parseDownloadPaths({ path: commaPath });
  assert.deepEqual(result1, [commaPath]);

  // 数组传参且元素内含有逗号
  const result2 = parseDownloadPaths({ paths: [commaPath, '/var/log/error.log'] });
  assert.deepEqual(result2, [commaPath, '/var/log/error.log']);
});

test('parseDownloadPaths: 对重复路径执行严格去重并过滤空值', () => {
  const result = parseDownloadPaths({
    paths: [
      '/var/www/html/index.html',
      '/var/www/html/style.css',
      '/var/www/html/index.html',
      '',
      '   ',
      '/var/www/html/style.css',
    ],
  });
  assert.deepEqual(result, ['/var/www/html/index.html', '/var/www/html/style.css']);
});

test('buildHiddenExcludeArgs: 导出 GNU tar/du 排除内部隐藏条目的通用参数', () => {
  const args = buildHiddenExcludeArgs();
  assert.equal(args, "--exclude='*/.*'");
});

test('buildBatchTarCommand: 同一父目录下拼接且包含 --exclude 与 -- 参数终止符，抵御选项注入', () => {
  // 测试以 - 开头的文件名（防止 tar 选项注入漏洞）与隐藏文件
  const maliciousPaths = [
    '/var/www/html/--checkpoint=1',
    '/var/www/html/--checkpoint-action=exec=sh x.sh',
    '/var/www/html/normal.txt',
    '/var/www/html/.yuyan-backups',
  ];

  const cmd = buildBatchTarCommand({ safeRealPaths: maliciousPaths, sudo: 'sudo -n ' });

  // 验证带有 sudo 前缀
  assert.ok(cmd.startsWith('sudo -n tar -czf - '));
  // 验证包含 --exclude 且在 -- 终止符之前
  const excludeIdx = cmd.indexOf("--exclude='*/.*'");
  const dashDashIdx = cmd.indexOf(' -- ');
  assert.ok(excludeIdx !== -1, '必须包含 --exclude 参数');
  assert.ok(dashDashIdx !== -1, '必须包含 -- 参数终止符');
  assert.ok(excludeIdx < dashDashIdx, '--exclude 必须位于 -- 终止符之前');
  // 验证工作目录正确切换
  assert.ok(cmd.includes(" -C '/var/www/html' -- "));
  // 验证不包含 --ignore-failed-read
  assert.ok(!cmd.includes('--ignore-failed-read'));
  // 验证文件名均已安全包裹且直接选中的隐藏项保留在参数中
  assert.ok(cmd.includes("'--checkpoint=1'"));
  assert.ok(cmd.includes("'--checkpoint-action=exec=sh x.sh'"));
  assert.ok(cmd.includes("'normal.txt'"));
  assert.ok(cmd.includes("'.yuyan-backups'"));
});

test('buildBatchTarCommand: 跨父目录文件时切换为根路径相对打包并保持 --exclude 与 -- 防护', () => {
  const crossPaths = [
    '/etc/nginx/nginx.conf',
    '/var/log/nginx/error.log',
  ];

  const cmd = buildBatchTarCommand({ safeRealPaths: crossPaths });
  assert.ok(cmd.startsWith("tar -czf - --exclude='*/.*' -C / -- "));
  assert.ok(cmd.includes("'etc/nginx/nginx.conf'"));
  assert.ok(cmd.includes("'var/log/nginx/error.log'"));
  assert.ok(!cmd.includes('--ignore-failed-read'));
});

test('createDownloadTicket & consumeDownloadTicket: 内存票据生命周期管理', () => {
  const serverId = 123;
  const paths = ['/var/www/app,1.js', '/var/www/app,2.js', '/var/www/app,1.js'];

  // 1. 创建票据（自动去重）
  const ticket = createDownloadTicket(serverId, paths);
  assert.ok(typeof ticket === 'string' && ticket.length > 0);

  // 2. 消费票据：与 serverId 匹配成功
  const consumed = consumeDownloadTicket(ticket, serverId);
  assert.equal(consumed.serverId, serverId);
  assert.deepEqual(consumed.paths, ['/var/www/app,1.js', '/var/www/app,2.js']);

  // 3. 重复消费失败（单次有效）
  assert.throws(
    () => consumeDownloadTicket(ticket, serverId),
    /已过期/
  );

  // 4. 不匹配的 serverId 拦截
  const ticket2 = createDownloadTicket(serverId, ['/var/log/app.log']);
  assert.throws(
    () => consumeDownloadTicket(ticket2, 999),
    /不匹配/
  );

  // 5. 超过 500 项上限直接在创建票据时快速阻断
  const overflowPaths = Array.from({ length: 501 }, (_, i) => `/var/www/file_${i}.txt`);
  assert.throws(
    () => createDownloadTicket(serverId, overflowPaths),
    /单次批量下载条目数不能超过 500 项/
  );

  // 6. 票据携带创建者身份元数据并供审计还原
  const creator = { user: 'ryan_dev', clientType: 'web', ip: '192.168.1.108' };
  const ticketWithCreator = createDownloadTicket(serverId, ['/var/www/app.js'], creator);
  const consumedWithCreator = consumeDownloadTicket(ticketWithCreator, serverId);
  assert.deepEqual(consumedWithCreator.creator, creator);
});

test('isTicketedFsDownloadRequest: 严格限制仅对 GET /servers/:id/fs/download 且带有效 ticket 放行', () => {
  // 1. 合法命中场景
  assert.equal(
    isTicketedFsDownloadRequest({
      method: 'GET',
      path: '/servers/12/fs/download',
      query: { ticket: 'abc123456789' },
    }),
    true
  );

  // 2. 缺少 ticket
  assert.equal(
    isTicketedFsDownloadRequest({
      method: 'GET',
      path: '/servers/12/fs/download',
      query: {},
    }),
    false
  );

  // 3. 非 GET 方法拦截（即使带 ticket 也绝不放行）
  assert.equal(
    isTicketedFsDownloadRequest({
      method: 'POST',
      path: '/servers/12/fs/download',
      query: { ticket: 'abc123456789' },
    }),
    false
  );

  // 4. 其他路由路径拦截（防鉴权越权探测）
  assert.equal(
    isTicketedFsDownloadRequest({
      method: 'GET',
      path: '/servers/12/fs/list',
      query: { ticket: 'abc123456789' },
    }),
    false
  );
  assert.equal(
    isTicketedFsDownloadRequest({
      method: 'GET',
      path: '/servers/invalid/fs/download',
      query: { ticket: 'abc123456789' },
    }),
    false
  );
});

test('calculateRemoteFsSize: 具有 10 秒超时配置并优先执行前置参数校验（不碰数据库）', async () => {
  assert.equal(FS_SIZE_TIMEOUT_MS, 10_000);

  // 1. 空路径拦截：传入非真实 serverId 也必须先被拦截，绝不碰数据库
  await assert.rejects(
    () => calculateRemoteFsSize(9999999, []),
    /目标路径列表不能为空/
  );

  // 2. 超过 500 项限制拦截：同样前置拦截，不查库
  const overflowPaths = Array.from({ length: 501 }, (_, i) => `/var/www/file_${i}.txt`);
  await assert.rejects(
    () => calculateRemoteFsSize(9999999, overflowPaths),
    /单次大小查询条目数不能超过 500 项/
  );

  // 3. 非法 serverId 校验拦截
  await assert.rejects(
    () => calculateRemoteFsSize(NaN, ['/var/www/index.html']),
    /无效的服务器 ID/
  );
});

test('buildBatchTarCommand: 验证跨目录与同目录对直接选中隐藏项的排除特征', () => {
  // 1. 同一父目录下：-C 切换父目录，传入 basename（无斜杠），*/.* 天然保留直接选中的顶层隐藏项
  const sameParentWithHidden = ['/var/www/html/.yuyan-backups', '/var/www/html/app'];
  const cmdSame = buildBatchTarCommand({ safeRealPaths: sameParentWithHidden });
  assert.ok(cmdSame.includes("-C '/var/www/html' -- "));
  assert.ok(cmdSame.includes("'.yuyan-backups'"));

  // 2. 跨目录场景下：-C / 模式下相对路径带斜杠（如 var/www/.yuyan-backups），会被 */.* 排除；
  // 生产环境 RemoteFs 仅允许在单目录内多选（allSameParent 恒为 true）
  const crossParentWithHidden = ['/var/www/.yuyan-backups', '/etc/nginx/nginx.conf'];
  const cmdCross = buildBatchTarCommand({ safeRealPaths: crossParentWithHidden });
  assert.ok(cmdCross.startsWith("tar -czf - --exclude='*/.*' -C / -- "));
});
