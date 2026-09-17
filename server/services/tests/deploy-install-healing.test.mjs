import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isStandardInstallCommand,
  prepareRuntimeNpmConfig,
  executeDependencyInstallWithHealing,
} from "../deploy-service.mjs";

test("isStandardInstallCommand 支持灵活识别各种包管理器安装命令及 flags 变体", () => {
  // Yarn 相关变体
  assert.equal(isStandardInstallCommand("yarn"), true, "yarn 独立命令应识别为标准安装");
  assert.equal(isStandardInstallCommand("yarn --ignore-engines"), true, "yarn 带 flags 默认执行 install，应识别为标准安装");
  assert.equal(isStandardInstallCommand("yarn install --ignore-engines"), true, "yarn install 带 flags 应识别为标准安装");
  assert.equal(isStandardInstallCommand("yarn --ignore-engines install"), true, "yarn flag 在 install 前面也应识别为标准安装");
  assert.equal(isStandardInstallCommand("yarn --production=false"), true, "yarn 任意 flags 均应识别为标准安装");
  assert.equal(isStandardInstallCommand("corepack yarn --ignore-engines"), true, "corepack yarn 应识别为标准安装");
  assert.equal(isStandardInstallCommand("yarn add vue"), false, "yarn add 包含副作用，不应识别为标准安装");
  assert.equal(isStandardInstallCommand("yarn build"), false, "yarn build 为自定义构建脚本，不应识别为标准安装");

  // npm 相关变体
  assert.equal(isStandardInstallCommand("npm install"), true);
  assert.equal(isStandardInstallCommand("npm i"), true);
  assert.equal(isStandardInstallCommand("npm ci"), true);
  assert.equal(isStandardInstallCommand("npm install --legacy-peer-deps"), true);
  assert.equal(isStandardInstallCommand("npm run build"), false);

  // pnpm 相关变体
  assert.equal(isStandardInstallCommand("pnpm install"), true);
  assert.equal(isStandardInstallCommand("pnpm i"), true);
  assert.equal(isStandardInstallCommand("pnpm --frozen-lockfile install"), true);
  assert.equal(isStandardInstallCommand("pnpm add axios"), false);

  // bun 相关变体
  assert.equal(isStandardInstallCommand("bun install"), true);
  assert.equal(isStandardInstallCommand("bun i"), true);

  // 恶意/多命令检测
  assert.equal(isStandardInstallCommand("yarn && rm -rf /"), false);
  assert.equal(isStandardInstallCommand("yarn; touch hacked"), false);
});

test("prepareRuntimeNpmConfig 默认注入 CI 防御环境变量（跳过大型二进制下载）", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yuyan-ci-env-test-"));
  try {
    const envs = await prepareRuntimeNpmConfig(tmpDir, () => {});
    assert.equal(envs.CYPRESS_INSTALL_BINARY, "0", "应注入 CYPRESS_INSTALL_BINARY=0");
    assert.equal(envs.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD, "true", "应注入 PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true");
    assert.equal(envs.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, "1", "应注入 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1");
    assert.equal(envs.ELECTRON_SKIP_BINARY_DOWNLOAD, "1", "应注入 ELECTRON_SKIP_BINARY_DOWNLOAD=1");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("executeDependencyInstallWithHealing 能捕获 Yarn 缓存损坏错误并尝试自愈重试", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yuyan-heal-test-"));
  const logs = [];
  const log = (level, message, stage) => {
    logs.push({ level, message, stage });
  };

  // 构造一个会输出类似 Unexpected end of JSON input 的失败命令测试
  const fakeFailScript = path.join(tmpDir, "fake-fail.sh");
  // 模拟第一次失败且包含 Yarn 损坏信息，第二次通过（通过检测标记文件）
  const flagFile = path.join(tmpDir, "first_run_done");
  await fs.writeFile(fakeFailScript, "#!/bin/sh\nif [ ! -f \"" + flagFile + "\" ]; then\n  touch \"" + flagFile + "\"\n  echo \"error SyntaxError: /usr/local/share/.cache/yarn/v6/npm-ora-5.4.1/ora/.yarn-metadata.json: Unexpected end of JSON input\" >&2\n  exit 1\nelse\n  echo \"retry success\"\n  exit 0\nfi\n", { mode: 0o755 });

  try {
    await executeDependencyInstallWithHealing({
      command: fakeFailScript,
      cwd: tmpDir,
      env: {},
      signal: null,
      log,
    });

    const hasWarnLog = logs.some((l) => l.message.includes("检测到 Yarn 全局缓存损坏"));
    const hasRetrySuccess = logs.some((l) => l.message.includes("依赖安装重试成功"));
    assert.equal(hasWarnLog, true, "应记录缓存损坏自愈 warn 日志");
    assert.equal(hasRetrySuccess, true, "应记录重试成功 success 日志");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
