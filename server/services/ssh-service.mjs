/**
 * SSH / SFTP 操作服务
 * @description 封装独立服务器的远程命令、文件读写和目录上传
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'ssh2';

/**
 * Shell 参数安全转义
 * @param {string} value - 原始值
 * @returns {string} 转义后的 shell 参数
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * 拼接远程路径
 * @param {...string} parts - 路径片段
 * @returns {string} POSIX 路径
 */
function remoteJoin(...parts) {
  return path.posix.join(...parts.map((item) => String(item || '')));
}

/**
 * 创建 SSH 连接配置
 * @param {Object} server - 服务器配置
 * @returns {Object} ssh2 连接配置
 */
function createConnectConfig(server) {
  const config = {
    host: server.host,
    port: Number(server.port || 22),
    username: server.username,
    readyTimeout: 15000,
  };

  if (server.authType === 'privateKey') {
    config.privateKey = server.credential?.privateKey || '';
    if (server.credential?.passphrase) config.passphrase = server.credential.passphrase;
  } else {
    config.password = server.credential?.password || '';
  }

  return config;
}

/**
 * 创建 SSH 连接
 * @param {Object} server - 服务器配置
 * @returns {Promise<Client>} SSH 客户端
 */
export function connectSsh(server) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => resolve(conn))
      .on('error', reject)
      .connect(createConnectConfig(server));
  });
}

/**
 * 使用 SSH 连接执行任务
 * @param {Object} server - 服务器配置
 * @param {(conn: Client) => Promise<*>} task - 任务函数
 * @returns {Promise<*>} 任务结果
 */
export async function withSsh(server, task) {
  const conn = await connectSsh(server);
  try {
    return await task(conn);
  } finally {
    conn.end();
  }
}

/**
 * 执行远程命令
 * @param {Client} conn - SSH 客户端
 * @param {string} command - 命令
 * @param {Object} options - 选项
 * @returns {Promise<{stdout: string, stderr: string, code: number}>} 执行结果
 */
export function execSsh(conn, command, options = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      let stdout = '';
      let stderr = '';

      stream
        .on('close', (code) => {
          const result = { stdout, stderr, code: Number(code || 0) };
          if (result.code === 0 || options.allowFailure) {
            resolve(result);
            return;
          }
          reject(new Error(`${options.label || command} 执行失败，退出码 ${result.code}\n${stderr || stdout}`));
        })
        .on('data', (chunk) => {
          const text = chunk.toString();
          stdout += text;
          options.onStdout?.(text);
        });

      stream.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        options.onStderr?.(text);
      });
    });
  });
}

/**
 * 流式执行远程命令并把 stdout 原样写入输出流。
 * @param {Client} conn - SSH 客户端
 * @param {string} command - 远程命令
 * @param {import('node:stream').Writable} output - 输出流
 * @param {Object} options - 选项
 * @returns {Promise<{stderr: string, code: number}>} 执行结果
 */
export function streamSshCommand(conn, command, output, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';

    /**
     * 安全结束当前 Promise。
     * @param {Error|null} error - 错误对象
     * @param {{stderr: string, code: number}=} result - 成功结果
     */
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      output.off?.('error', onOutputError);
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    };

    /** 输出流错误处理。 */
    const onOutputError = (error) => finish(error);

    output.on?.('error', onOutputError);
    conn.exec(command, (error, stream) => {
      if (error) {
        finish(error);
        return;
      }

      stream
        .on('close', (code) => {
          const result = { stderr, code: Number(code || 0) };
          if (result.code === 0 || options.allowFailure) {
            finish(null, result);
            return;
          }
          finish(new Error(`${options.label || command} 执行失败，退出码 ${result.code}\n${stderr}`));
        })
        .on('data', (chunk) => {
          options.onStdout?.(chunk);
          if (!output.write(chunk)) {
            stream.pause();
            output.once('drain', () => stream.resume());
          }
        });

      stream.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        options.onStderr?.(text);
      });
    });
  });
}

/**
 * 获取 SFTP 实例
 * @param {Client} conn - SSH 客户端
 * @returns {Promise<Object>} SFTP 实例
 */
function getSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((error, sftp) => {
      if (error) reject(error);
      else resolve(sftp);
    });
  });
}

/**
 * 读取远程文本文件
 * @param {Client} conn - SSH 客户端
 * @param {Object} server - 服务器配置
 * @param {string} filePath - 文件路径
 * @returns {Promise<string>} 文件内容
 */
export async function readRemoteText(conn, server, filePath) {
  const prefix = server.useSudo ? 'sudo -n ' : '';
  const result = await execSsh(conn, `${prefix}cat ${shellQuote(filePath)}`, { label: `读取 ${filePath}` });
  return result.stdout;
}

/**
 * 写入远程文本文件并在写入前备份
 * @param {Client} conn - SSH 客户端
 * @param {Object} server - 服务器配置
 * @param {string} filePath - 文件路径
 * @param {string} content - 文件内容
 * @returns {Promise<{backupPath: string}>} 备份信息
 */
export async function writeRemoteTextWithBackup(conn, server, filePath, content) {
  const sftp = await getSftp(conn);
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const backupPath = `${filePath}.bak.${timestamp}`;
  const tempPath = `/tmp/yuyan-nginx-conf-${timestamp}-${Math.random().toString(16).slice(2)}.tmp`;
  const sudo = server.useSudo ? 'sudo -n ' : '';

  await execSsh(conn, `${sudo}cp ${shellQuote(filePath)} ${shellQuote(backupPath)}`, {
    label: `备份 ${filePath}`,
    allowFailure: true,
  });

  await new Promise((resolve, reject) => {
    sftp.writeFile(tempPath, content, 'utf8', (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  if (server.useSudo) {
    await execSsh(conn, `sudo -n cp ${shellQuote(tempPath)} ${shellQuote(filePath)} && rm -f ${shellQuote(tempPath)}`, {
      label: `写入 ${filePath}`,
    });
  } else {
    await execSsh(conn, `cp ${shellQuote(tempPath)} ${shellQuote(filePath)} && rm -f ${shellQuote(tempPath)}`, {
      label: `写入 ${filePath}`,
    });
  }

  return { backupPath };
}

/**
 * 创建远程目录
 * @param {Client} conn - SSH 客户端
 * @param {string} dirPath - 目录路径
 * @returns {Promise<void>}
 */
export async function ensureRemoteDir(conn, dirPath) {
  await execSsh(conn, `mkdir -p ${shellQuote(dirPath)}`, { label: `创建目录 ${dirPath}` });
}

/**
 * 上传目录到远程服务器
 * @param {Client} conn - SSH 客户端
 * @param {string} localDir - 本地目录
 * @param {string} remoteDir - 远程目录
 * @param {(info: Object) => void} onFile - 文件上传回调
 * @param {Object} options - 上传选项
 * @param {string[]} options.excludeTopLevelNames - 跳过上传的顶层目录或文件名
 * @returns {Promise<void>}
 */
export async function uploadDirectory(conn, localDir, remoteDir, onFile, options = {}) {
  const sftp = await getSftp(conn);
  await ensureRemoteDir(conn, remoteDir);
  const excludeTopLevelNames = new Set((options.excludeTopLevelNames || []).map((name) => String(name || '').trim()).filter(Boolean));

  const walk = async (currentLocal, currentRemote) => {
    await ensureRemoteDir(conn, currentRemote);
    const entries = await fs.readdir(currentLocal, { withFileTypes: true });
    for (const entry of entries) {
      if (currentLocal === localDir && excludeTopLevelNames.has(entry.name)) continue;
      const localPath = path.join(currentLocal, entry.name);
      const remotePath = remoteJoin(currentRemote, entry.name);
      if (entry.isDirectory()) {
        await walk(localPath, remotePath);
        continue;
      }
      if (!entry.isFile()) continue;
      await new Promise((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      onFile?.({ localPath, remotePath });
    }
  };

  await walk(localDir, remoteDir);
}

/**
 * 上传单个文件到远程服务器。
 * @param {Client} conn - SSH 客户端
 * @param {string} localPath - 本地文件路径
 * @param {string} remotePath - 远程文件路径
 * @returns {Promise<void>}
 */
export async function uploadFile(conn, localPath, remotePath) {
  const sftp = await getSftp(conn);
  await ensureRemoteDir(conn, path.posix.dirname(remotePath));
  await new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
