/**
 * 文件下载控制器
 * @description 处理项目文件的打包和下载
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const downloadRegistry = new Map();

export function getScaffoldArchivePath(appName, timestamp) {
  return path.join('/tmp', 'scaffold-downloads', `${appName}-${timestamp}.zip`);
}

export function registerScaffoldDownload({ appName, timestamp, tempRoot, projectDir, archivePath, expiresAt }) {
  if (!appName || !timestamp) return;
  downloadRegistry.set(`${appName}:${timestamp}`, {
    tempRoot,
    projectDir,
    archivePath,
    expiresAt: expiresAt || Date.now() + 1000 * 60 * 60,
  });
}

function getRegisteredDownload(appName, timestamp) {
  const key = `${appName}:${timestamp}`;
  const record = downloadRegistry.get(key);
  if (!record) return null;
  if (record.expiresAt && Date.now() > record.expiresAt) {
    downloadRegistry.delete(key);
    return null;
  }
  return record;
}

/**
 * 处理项目下载请求
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
export async function handleDownload(req, res) {
  try {
    const { appName, timestamp } = req.params;

    const registered = getRegisteredDownload(appName, timestamp);
    let projectDir = registered?.projectDir || null;
    let tempRoot = registered?.tempRoot || null;
    const zipFileName = `${appName}.zip`;
    const archivePath = registered?.archivePath || getScaffoldArchivePath(appName, timestamp);

    try {
      await fsp.access(archivePath);
      res.download(archivePath, zipFileName, (err) => {
        if (err && !res.headersSent) {
          console.error('[download-controller] 归档文件下载失败:', err);
          res.status(500).json({ error: '下载失败' });
        }
      });
      return;
    } catch {}

    // 兼容旧的临时目录扫描逻辑，避免升级过程中中断
    if (!projectDir || !tempRoot) {
      const tempDirs = await fsp.readdir('/tmp');
      projectDir = null;
      tempRoot = null;

      // 在所有 scaffold 目录中查找包含目标时间戳的项目
      for (const dir of tempDirs) {
        if (dir.startsWith('scaffold-')) {
          tempRoot = path.join('/tmp', dir);
          const potentialProjectDir = path.join(tempRoot, appName);

          try {
            await fsp.stat(potentialProjectDir);

            // 检查这个项目目录的修改时间是否接近请求的时间戳
            const stats = await fsp.stat(tempRoot);
            const dirTimestamp = Math.floor(stats.mtime.getTime() / 1000) * 1000;
            const requestTimestamp = Math.floor(parseInt(timestamp, 10) / 1000) * 1000;

            if (Math.abs(dirTimestamp - requestTimestamp) < 10000) {
              // 10秒容差
              projectDir = potentialProjectDir;
              break;
            }
          } catch {}
        }
      }
    }

    if (!projectDir || !tempRoot) {
      return res.status(404).json({ error: '项目未找到，可能已过期清理' });
    }

    // 设置响应头为 zip 文件下载
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFileName}"`);

    // 使用系统 zip 命令直接输出到响应流
    const zipProcess = spawn('zip', ['-r', '-', appName], {
      cwd: tempRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    zipProcess.stderr.on('data', (data) => {
      console.error('[download-controller] zip stderr:', data.toString());
    });

    zipProcess.on('error', (err) => {
      console.error('[download-controller] zip process error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: '压缩失败' });
      }
    });

    // 管道传输到响应
    zipProcess.stdout.pipe(res);

    zipProcess.on('close', (code) => {
      if (code !== 0) {
        console.error('[download-controller] zip process exited with code:', code);
        if (!res.headersSent) {
          res.status(500).json({ error: '压缩失败' });
        }
      }
    });
  } catch (error) {
    console.error('[download-controller] 下载失败:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: '下载失败' });
    }
  }
}
