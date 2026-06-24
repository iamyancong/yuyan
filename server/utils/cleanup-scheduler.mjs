/**
 * 定时清理任务
 * @description 定期清理过期的临时项目文件
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { CLEANUP_INTERVAL_MS, TEMP_FILE_MAX_AGE_MS } from '../config/constants.mjs';

/**
 * 启动定时清理任务
 */
export function startCleanupScheduler() {
  setInterval(async () => {
    try {
      const tempDirs = await fs.readdir('/tmp');
      const now = Date.now();

      for (const dir of tempDirs) {
        if (dir.startsWith('scaffold-')) {
          const dirPath = path.join('/tmp', dir);
          const stats = await fs.stat(dirPath);
          const age = now - stats.mtime.getTime();

          if (age > TEMP_FILE_MAX_AGE_MS) {
            await fs.rm(dirPath, { recursive: true, force: true });
            console.log(`[cleanup-scheduler] 已清理过期临时目录: ${dir}`);
          }
        }
      }
    } catch (error) {
      console.warn('[cleanup-scheduler] 清理任务执行失败:', error);
    }
  }, CLEANUP_INTERVAL_MS);

  console.log(`[cleanup-scheduler] 定时清理任务已启动 (间隔: ${CLEANUP_INTERVAL_MS / 1000 / 60} 分钟)`);
}
