import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 目标目录：src-tauri/resources/bin
const targetDir = path.resolve(__dirname, '../src-tauri/resources/bin');
// 是否为开发模式
const isDev = process.argv.includes('--dev');

// 确保目标目录存在
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
  console.log(`📁 创建目标目录: ${targetDir}`);
}

if (isDev) {
  console.log(`ℹ️  当前为开发模式，跳过本地 Node.js 二进制文件拷贝。`);
  process.exit(0);
}

// 源 node 路径
const sourceNode = process.execPath;
const binaryName = path.basename(sourceNode); // windows上是 node.exe, mac/linux上是 node
const targetNode = path.join(targetDir, binaryName);

console.log(`🚀 准备将本地 Node.js 写入 Tauri 资源目录...`);
console.log(`📂 源 Node.js 路径: ${sourceNode}`);
console.log(`📂 目标路径: ${targetNode}`);

try {
  let needCopy = true;
  if (fs.existsSync(targetNode)) {
    const sourceStats = fs.statSync(sourceNode);
    const targetStats = fs.statSync(targetNode);
    if (sourceStats.size === targetStats.size) {
      console.log(`ℹ️  目标 Node.js 二进制文件已存在且大小一致，跳过拷贝以防止文件锁定。`);
      needCopy = false;
    }
  }

  if (needCopy) {
    fs.copyFileSync(sourceNode, targetNode);
    console.log(`✅ Node.js 二进制文件复制成功！`);
  }

  // 在 macOS/Linux 上，确保有执行权限
  if (process.platform !== 'win32') {
    fs.chmodSync(targetNode, 0o755);
    console.log(`🔑 已为二进制文件设置执行权限 (0755)`);

    if (process.platform === 'darwin') {
      try {
        execSync(`codesign --force --deep --sign - "${targetNode}"`);
        console.log(`✍️  已成功为 macOS 二进制文件进行 ad-hoc 重新签名`);
      } catch (err) {
        console.warn(`⚠️ 重新签名失败，请尝试手动执行 codesign:`, err);
      }
    }
  }

  // ----------------------------------------------------
  // 新增：自动生成 server/package.json 并安装轻量生产依赖，解决打包遗漏 node_modules 的 Bug
  // ----------------------------------------------------
  const serverDir = path.resolve(__dirname, '../server');
  const serverPkgPath = path.join(serverDir, 'package.json');
  const serverPkgContent = {
    name: "yuyan-server",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies: {
      "axios": "^1.11.0",
      "compression": "^1.8.1",
      "connect-history-api-fallback": "^2.0.0",
      "cors": "^2.8.5",
      "express": "^5.1.0",
      "ssh2": "^1.17.0"
    }
  };

  console.log(`\n📦 正在为后端服务准备生产依赖...`);
  fs.writeFileSync(serverPkgPath, JSON.stringify(serverPkgContent, null, 2), 'utf8');
  console.log(`✅ 已生成 ${serverPkgPath}`);

  console.log(`⏳ 正在 server 目录下执行 npm install --omit=dev...`);
  execSync('npm install --omit=dev --no-audit --no-fund', {
    cwd: serverDir,
    stdio: 'inherit'
  });
  console.log(`✅ 后端生产依赖准备完成！`);

} catch (error) {
  console.error(`❌ 复制 Node.js 二进制文件或准备后端依赖失败:`, error);
  process.exit(1);
}
