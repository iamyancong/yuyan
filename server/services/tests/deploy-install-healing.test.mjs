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

const PNPM_NETWORK_ENV_KEYS = [
  "YUYAN_PNPM_NETWORK_CONCURRENCY",
  "YUYAN_PNPM_FETCH_TIMEOUT_MS",
  "YUYAN_PNPM_FETCH_RETRIES",
];
const NPMRC_ENV_KEYS = ["NPMRC_CONTENT", "NPM_REGISTRY", "NPM_AUTH_TOKEN", "NPM_ALWAYS_AUTH"];

/**
 * 临时覆盖 process.env，结束后还原。
 * @param {Record<string, string|undefined>} overrides - 要写入的环境变量，undefined 表示删除
 * @param {() => Promise<void>} fn - 回调
 * @returns {Promise<void>}
 */
async function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    await fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function clearPnpmAndNpmrcEnv() {
  const overrides = {};
  for (const key of [...PNPM_NETWORK_ENV_KEYS, ...NPMRC_ENV_KEYS]) overrides[key] = undefined;
  return overrides;
}

test("prepareRuntimeNpmConfig 默认注入 CI 防御环境变量（跳过大型二进制下载）", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yuyan-ci-env-test-"));
  try {
    await withEnv(clearPnpmAndNpmrcEnv(), async () => {
      const logs = [];
      const envs = await prepareRuntimeNpmConfig(tmpDir, (level, message, stage) => {
        logs.push({ level, message, stage });
      });
      assert.equal(envs.CYPRESS_INSTALL_BINARY, "0", "应注入 CYPRESS_INSTALL_BINARY=0");
      assert.equal(envs.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD, "true", "应注入 PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true");
      assert.equal(envs.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, "1", "应注入 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1");
      assert.equal(envs.ELECTRON_SKIP_BINARY_DOWNLOAD, "1", "应注入 ELECTRON_SKIP_BINARY_DOWNLOAD=1");
      assert.equal(envs.npm_config_network_concurrency, "8", "应默认注入 pnpm network-concurrency=8");
      assert.equal(envs.npm_config_fetch_timeout, "120000", "应默认注入 pnpm fetch-timeout=120000");
      assert.equal(envs.npm_config_fetch_retries, "4", "应默认注入 pnpm fetch-retries=4");
      assert.equal(envs.npm_config_fetch_retry_mintimeout, "5000", "应默认注入 pnpm fetch-retry-mintimeout=5000");
      assert.equal(envs.NPM_CONFIG_USERCONFIG, undefined, "未配置私服时应走提前返回路径，不写入临时 npmrc");
      assert.equal(
        logs.some(
          (item) =>
            item.stage === "install" &&
            item.level === "info" &&
            item.message.includes("network-concurrency=8") &&
            item.message.includes("fetch-timeout=120000ms") &&
            item.message.includes("fetch-retries=4")
        ),
        true,
        "安装阶段应记录生效的 pnpm 下载参数"
      );
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("prepareRuntimeNpmConfig 允许通过容器环境变量覆盖 pnpm 下载参数", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yuyan-ci-env-override-"));
  try {
    await withEnv(
      {
        ...clearPnpmAndNpmrcEnv(),
        YUYAN_PNPM_NETWORK_CONCURRENCY: "6",
        YUYAN_PNPM_FETCH_TIMEOUT_MS: "180000",
        YUYAN_PNPM_FETCH_RETRIES: "5",
      },
      async () => {
        const envs = await prepareRuntimeNpmConfig(tmpDir, () => {});
        assert.equal(envs.npm_config_network_concurrency, "6");
        assert.equal(envs.npm_config_fetch_timeout, "180000");
        assert.equal(envs.npm_config_fetch_retries, "5");
        assert.equal(envs.npm_config_fetch_retry_mintimeout, "5000");
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("prepareRuntimeNpmConfig 在非法覆盖值时回退到默认 pnpm 下载参数", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yuyan-ci-env-invalid-"));
  try {
    await withEnv(
      {
        ...clearPnpmAndNpmrcEnv(),
        YUYAN_PNPM_NETWORK_CONCURRENCY: "0",
        YUYAN_PNPM_FETCH_TIMEOUT_MS: "-1",
        YUYAN_PNPM_FETCH_RETRIES: "abc",
      },
      async () => {
        const envs = await prepareRuntimeNpmConfig(tmpDir, () => {});
        assert.equal(envs.npm_config_network_concurrency, "8");
        assert.equal(envs.npm_config_fetch_timeout, "120000");
        assert.equal(envs.npm_config_fetch_retries, "4");
      }
    );

    await withEnv(
      {
        ...clearPnpmAndNpmrcEnv(),
        YUYAN_PNPM_NETWORK_CONCURRENCY: "8.5",
        YUYAN_PNPM_FETCH_TIMEOUT_MS: "  ",
        YUYAN_PNPM_FETCH_RETRIES: "3.0",
      },
      async () => {
        const envs = await prepareRuntimeNpmConfig(tmpDir, () => {});
        assert.equal(envs.npm_config_network_concurrency, "8", "小数应视为非法并回退");
        assert.equal(envs.npm_config_fetch_timeout, "120000", "空白应回退默认值");
        assert.equal(envs.npm_config_fetch_retries, "3", "3.0 是整数 3，应视为合法覆盖");
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("prepareRuntimeNpmConfig 在写入临时 npmrc 时仍注入 pnpm 下载参数且不改动私服配置", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yuyan-ci-env-npmrc-"));
  try {
    await withEnv(
      {
        ...clearPnpmAndNpmrcEnv(),
        NPM_REGISTRY: "http://example.invalid/repository/npm-group/",
        NPM_ALWAYS_AUTH: "true",
      },
      async () => {
        const envs = await prepareRuntimeNpmConfig(tmpDir, () => {});
        assert.equal(envs.npm_config_network_concurrency, "8");
        assert.equal(envs.npm_config_fetch_timeout, "120000");
        assert.equal(envs.npm_config_fetch_retries, "4");
        assert.equal(envs.npm_config_fetch_retry_mintimeout, "5000");
        assert.equal(envs.NPM_CONFIG_USERCONFIG, path.join(tmpDir, ".yuyan.npmrc"));
        const npmrc = await fs.readFile(envs.NPM_CONFIG_USERCONFIG, "utf8");
        assert.match(npmrc, /registry=http:\/\/example\.invalid\/repository\/npm-group\//);
        assert.doesNotMatch(npmrc, /network-concurrency|fetch-timeout|fetch-retries/);
      }
    );
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
