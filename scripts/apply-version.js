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

// 4. 更新 Cargo.lock 中 name = "yuyan-swift-vpn" 下的 version
const cargoLockPath = path.resolve('src-tauri/Cargo.lock');
if (fs.existsSync(cargoLockPath)) {
  let cargoLock = fs.readFileSync(cargoLockPath, 'utf8');
  const regex = /((?:^|\n)\[\[package\]\]\r?\nname\s*=\s*"yuyan-swift-vpn"\r?\nversion\s*=\s*")[^"]*"/;
  if (regex.test(cargoLock)) {
    cargoLock = cargoLock.replace(regex, `$1${targetVersion}"`);
    fs.writeFileSync(cargoLockPath, cargoLock, 'utf8');
    console.log(`Updated Cargo.lock version to ${targetVersion}`);
  } else {
    console.warn('Warning: Could not find yuyan-swift-vpn package block in Cargo.lock');
  }
}

