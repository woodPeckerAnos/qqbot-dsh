/**
 * Docker 构建期的依赖管理脚本。两个子命令：
 *
 *   node scripts/docker-install.mjs install   # 安装全部依赖（含 devDependencies）
 *   node scripts/docker-install.mjs prune     # 剔除 devDependencies 与异平台可选依赖
 *
 * 为什么要写脚本而不是在 Dockerfile 里直接 `npm install`：
 *
 *   1. **必须分两步**。编译需要 typescript（devDependency），所以不能一开始就用
 *      `--omit=dev`；但运行镜像又不该带 vitest/@types。npm 没有 `prune --prod`，
 *      所以自己按 package.json 判定并逐个删除。
 *
 *   2. **剔除异平台可选依赖**。本项目在 macOS 上开发，本机 install 会落地
 *      `@deepseek-ai/node-addon-system-darwin-arm64` 之类的包。它们被 COPY 进
 *      Linux 运行镜像后是几十 MB 的死重，还会误导人以为用了本机二进制。
 *
 * 本脚本只跑在构建阶段，不进入运行镜像。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const command = process.argv[2];
if (command !== 'install' && command !== 'prune') {
  console.error('用法：node scripts/docker-install.mjs <install|prune>');
  process.exit(2);
}

if (command === 'install') {
  console.log('[docker-install] npm install（含 devDependencies，编译需要 typescript）');
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { stdio: 'inherit' });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const devNames = new Set(Object.keys(pkg.devDependencies ?? {}));
const prodNames = new Set(Object.keys(pkg.dependencies ?? {}));
const optionalNames = new Set(Object.keys(pkg.optionalDependencies ?? {}));

function readManifest(dir) {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function listTopLevel(root) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('.')) continue;
    const full = join(root, entry);
    if (entry.startsWith('@')) {
      if (!statSync(full).isDirectory()) continue;
      for (const sub of readdirSync(full)) out.push({ name: `${entry}/${sub}`, dir: join(full, sub) });
      continue;
    }
    if (!statSync(full).isDirectory()) continue;
    out.push({ name: entry, dir: full });
  }
  return out;
}

/**
 * 是否应删除该顶层包。
 *
 * 保守规则：
 *   - 在 dependencies / optionalDependencies 里 → 保留；
 *   - 在 devDependencies 里 → 删除；
 *   - 其余（纯传递依赖）→ 保留，除非它的 os/cpu 与当前平台不符。
 */
function shouldRemove(name, manifest) {
  if (prodNames.has(name) || optionalNames.has(name)) return false;
  if (devNames.has(name)) return true;
  if (manifest?.os !== undefined || manifest?.cpu !== undefined) {
    const osOk = manifest.os === undefined || manifest.os.includes(process.platform);
    const cpuOk = manifest.cpu === undefined || manifest.cpu.includes(process.arch);
    if (!osOk || !cpuOk) return true;
  }
  return false;
}

function directorySize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else {
        try {
          total += statSync(path).size;
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  return total;
}

console.log(`[docker-install] 剪枝：平台=${process.platform}/${process.arch}`);
let removed = 0;
let freedBytes = 0;
const removedNames = [];
for (const { name, dir } of listTopLevel('node_modules')) {
  const manifest = readManifest(dir);
  if (!shouldRemove(name, manifest)) continue;
  try {
    const size = directorySize(dir);
    rmSync(dir, { recursive: true, force: true });
    removed += 1;
    freedBytes += size;
    removedNames.push(name);
  } catch (error) {
    console.warn(`[docker-install] 删除 ${name} 失败：${error.message}`);
  }
}

console.log(
  `[docker-install] 删除 ${removed} 个包，释放约 ${(freedBytes / 1024 / 1024).toFixed(1)} MB`,
);
if (removedNames.length <= 12) console.log(`[docker-install] ${removedNames.join(', ')}`);
