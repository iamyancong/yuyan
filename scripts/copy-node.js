import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 目标目录：src-tauri/resources/bin
const targetDir = path.resolve(__dirname, '../src-tauri/resources/bin');
// 源 node 路径
const sourceNode = process.execPath;
const binaryName = path.basename(sourceNode); // windows上是 node.exe, mac/linux上是 node
const targetNode = path.join(targetDir, binaryName);

console.log(`🚀 准备将本地 Node.js 写入 Tauri 资源目录...`);
console.log(`📂 源 Node.js 路径: ${sourceNode}`);
console.log(`📂 目标路径: ${targetNode}`);

try {
  // 确保目标目录存在
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
    console.log(`📁 创建目标目录: ${targetDir}`);
  }

  // 复制文件
  fs.copyFileSync(sourceNode, targetNode);
  console.log(`✅ Node.js 二进制文件复制成功！`);

  // 在 macOS/Linux 上，确保有执行权限
  if (process.platform !== 'win32') {
    fs.chmodSync(targetNode, 0o755);
    console.log(`🔑 已为二进制文件设置执行权限 (0755)`);
  }
} catch (error) {
  console.error(`❌ 复制 Node.js 二进制文件失败:`, error);
  process.exit(1);
}
