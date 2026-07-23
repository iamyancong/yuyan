/**
 * 定时清理任务
 * @description 定期清理过期的临时项目文件
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AGENT_SESSION_TOKEN, CLEANUP_INTERVAL_MS, TEMP_FILE_MAX_AGE_MS } from '../config/constants.mjs';
import { cleanupExpiredAgentOperations } from '../services/agent-store.mjs';

/**
 * 启动定时清理任务
 */
export function startCleanupScheduler() {
  const timer = setInterval(async () => {
    try {
      const tempRoot = os.tmpdir();
      const tempDirs = await fs.readdir(tempRoot);
      const now = Date.now();

      for (const dir of tempDirs) {
        if (dir.startsWith('scaffold-')) {
          const dirPath = path.join(tempRoot, dir);
          const stats = await fs.stat(dirPath);
          const age = now - stats.mtime.getTime();

          if (age > TEMP_FILE_MAX_AGE_MS) {
            await fs.rm(dirPath, { recursive: true, force: true });
            console.log(`[cleanup-scheduler] 已清理过期临时目录: ${dir}`);
          }
        }
      }
      if (AGENT_SESSION_TOKEN) {
        const deletedOperations = cleanupExpiredAgentOperations();
        if (deletedOperations > 0) {
          console.log(`[cleanup-scheduler] 已按保留策略清理 ${deletedOperations} 条已结束任务`);
        }
      }
    } catch (error) {
      console.warn('[cleanup-scheduler] 清理任务执行失败:', error);
    }
  }, CLEANUP_INTERVAL_MS);
  timer.unref?.();

  console.log(`[cleanup-scheduler] 定时清理任务已启动 (间隔: ${CLEANUP_INTERVAL_MS / 1000 / 60} 分钟)`);
  return () => {
    clearInterval(timer);
    console.log('[cleanup-scheduler] 定时清理任务已停止');
  };
}
