import fs from 'fs';
import path from 'path';

const targetVersion = process.argv[2];
if (!targetVersion) {
  console.error('Usage: node scripts/apply-version.js <version>');
  process.exit(1);
}

// 1. 更新 package.json
const packageJsonPath = path.resolve('package.json');
if (fs.existsSync(packageJsonPath)) {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  packageJson.version = targetVersion;
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
  console.log(`Updated package.json version to ${targetVersion}`);
}

// 2. 更新 tauri.conf.json
const tauriConfigPath = path.resolve('src-tauri/tauri.conf.json');
if (fs.existsSync(tauriConfigPath)) {
  const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
  tauriConfig.version = targetVersion;
  fs.writeFileSync(tauriConfigPath, JSON.stringify(tauriConfig, null, 2) + '\n', 'utf8');
  console.log(`Updated tauri.conf.json version to ${targetVersion}`);
}

// 3. 更新 Cargo.toml [package] 下的 version
const cargoTomlPath = path.resolve('src-tauri/Cargo.toml');
if (fs.existsSync(cargoTomlPath)) {
  let cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
  cargoToml = cargoToml.replace(/^version\s*=\s*"[^"]*"/m, `version = "${targetVersion}"`);
  fs.writeFileSync(cargoTomlPath, cargoToml, 'utf8');
  console.log(`Updated Cargo.toml version to ${targetVersion}`);
}
