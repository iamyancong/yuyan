import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateUpdateManifest } from './generate-update-manifest.js';

/** 为测试创建一个带签名的更新产物。 */
const createSignedArtifact = (root, target, filename) => {
  const targetDirectory = path.join(root, target);
  fs.mkdirSync(targetDirectory, { recursive: true });
  const artifactPath = path.join(targetDirectory, filename);
  fs.writeFileSync(artifactPath, target);
  fs.writeFileSync(`${artifactPath}.sig`, `signature-${target}\n`);
};

test('生成包含 macOS 双架构与 Windows x86_64 签名资产的 latest.json', () => {
  const distDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-update-manifest-'));
  createSignedArtifact(distDirectory, 'darwin-aarch64', 'yuyan_1.2.3_darwin-aarch64.app.tar.gz');
  createSignedArtifact(distDirectory, 'darwin-x86_64', 'yuyan_1.2.3_darwin-x86_64.app.tar.gz');
  createSignedArtifact(distDirectory, 'windows-x86_64', 'yuyan_1.2.3_windows-x86_64-setup.exe');
  fs.writeFileSync(
    path.join(distDirectory, 'windows-x86_64', 'a-unsigned-installer.exe'),
    'unsigned-bundle-copy',
  );

  const manifest = generateUpdateManifest({
    version: '1.2.3',
    tag: 'v1.2.3',
    repository: 'ycwang-dev/yuyan',
    distDirectory,
    notes: '测试更新',
    publishedAt: new Date('2026-07-17T00:00:00.000Z'),
  });

  assert.deepEqual(Object.keys(manifest.platforms), [
    'darwin-aarch64',
    'darwin-x86_64',
    'windows-x86_64',
  ]);
  assert.equal(manifest.notes, '测试更新');
  assert.equal(manifest.platforms['darwin-aarch64'].signature, 'signature-darwin-aarch64');
  assert.match(manifest.platforms['darwin-x86_64'].url, /v1.2.3\/yuyan_1.2.3_darwin-x86_64.app.tar.gz$/);
  assert.match(manifest.platforms['windows-x86_64'].url, /v1.2.3\/yuyan_1.2.3_windows-x86_64-setup.exe$/);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(distDirectory, 'latest.json'), 'utf8')),
    manifest,
  );
});

test('缺少签名时拒绝生成更新清单', () => {
  const distDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-update-manifest-missing-'));
  createSignedArtifact(distDirectory, 'darwin-aarch64', 'yuyan_1.2.3_darwin-aarch64.app.tar.gz');
  createSignedArtifact(distDirectory, 'windows-x86_64', 'yuyan_1.2.3_windows-x86_64-setup.exe');
  const intelDirectory = path.join(distDirectory, 'darwin-x86_64');
  fs.mkdirSync(intelDirectory, { recursive: true });
  fs.writeFileSync(path.join(intelDirectory, 'yuyan_1.2.3_darwin-x86_64.app.tar.gz'), 'unsigned');

  assert.throws(() => generateUpdateManifest({
    version: '1.2.3',
    tag: 'v1.2.3',
    repository: 'ycwang-dev/yuyan',
    distDirectory,
  }), /缺少更新签名/);
});
