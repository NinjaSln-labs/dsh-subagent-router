#!/usr/bin/env node
/**
 * 部署纪律装后自检（DEVELOPMENT.md「部署纪律：profile 安装」配套脚本）
 *
 * 三点检查：
 *   1) 源码 lib == 部署 lib（file: 指向的源码目录 vs profile 内实际安装产物）
 *   2) profile 内 @deepseek-ai/ 只允许 cosmokit / schemastery（防第二套宿主核心包）
 *   3) file: 安装在 profile 内必须是真实目录（非软链，防 realpath 脱离宿主 fallback）
 *
 * 用法：
 *   node scripts/check-deploy.mjs                # 全量检查 profile 里所有插件
 *   node scripts/check-deploy.mjs --pkg dsh-imgdraw [--pkg ...]  # 只查指定插件
 *   node scripts/check-deploy.mjs --profile ~/.dsh/profiles/web  # 指定 profile
 *
 * 退出码：0 = 全部 PASS（或无插件安装）；1 = 存在 FAIL。
 */

import { readdirSync, readFileSync, existsSync, statSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_HOST_PKGS = new Set(['cosmokit', 'schemastery']);

// ---------- 参数 ----------
const argv = process.argv.slice(2);
function getFlag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const profileArg = getFlag('--profile');
const PROFILE = profileArg
  ? resolve(profileArg.replace(/^~(?=\/|$)/, homedir()))
  : join(homedir(), '.dsh', 'profiles', 'web');
const pkgFilters = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--pkg' && argv[i + 1]) pkgFilters.push(argv[i + 1]);
}

// ---------- 工具 ----------
function hashTree(dir, base = dir, acc = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = full.slice(base.length + 1);
    if (entry.isDirectory()) hashTree(full, base, acc);
    else if (entry.isFile()) acc.set(rel, createHash('sha256').update(readFileSync(full)).digest('hex'));
  }
  return acc;
}
function diffTrees(aDir, bDir) {
  const a = hashTree(aDir), b = hashTree(bDir);
  const diffs = [];
  for (const [k, v] of a) if (b.get(k) !== v) diffs.push(b.has(k) ? `M ${k}` : `D ${k}`);
  for (const k of b.keys()) if (!a.has(k)) diffs.push(`+ ${k}`);
  return diffs;
}
function resolveFileTarget(spec) {
  // file: 相对路径按 profile package.json 所在目录解析
  const p = spec.slice('file:'.length);
  return isAbsolute(p) ? p : resolve(PROFILE, p);
}

// ---------- 读取 profile ----------
const pkgJsonPath = join(PROFILE, 'package.json');
if (!existsSync(pkgJsonPath)) {
  console.error(`✗ profile 不存在或缺少 package.json：${PROFILE}`);
  process.exit(1);
}
const profilePkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
const deps = profilePkg.dependencies || {};
const pluginDeps = Object.entries(deps).filter(([name]) => !name.startsWith('@') );

// 本仓库自身包名：单库布局下 REPO_ROOT 即插件目录（源码 lib 在 REPO_ROOT/lib）；
// 多包布局下 REPO_ROOT/<name>/lib。有 REPO_ROOT/package.json 且 name 匹配时按单库处理。
let selfName = null;
try {
  const selfPkgPath = join(REPO_ROOT, 'package.json');
  if (existsSync(selfPkgPath)) selfName = JSON.parse(readFileSync(selfPkgPath, 'utf8')).name || null;
} catch { /* 忽略：读不到按多包布局 */ }
function localSrcFor(name) {
  // 单库：被查插件即本仓库自身
  return name === selfName ? join(REPO_ROOT, 'lib') : join(REPO_ROOT, name, 'lib');
}

let failed = 0, checked = 0;
const results = [];

for (const [name, spec] of pluginDeps) {
  if (pkgFilters.length && !pkgFilters.includes(name)) continue;
  checked++;
  const installed = join(PROFILE, 'node_modules', name);

  if (!spec.startsWith('file:')) {
    // registry 安装：按纪律只在「发版→立即重装」闭环里可信
    const localSrc = localSrcFor(name);
    let note;
    if (existsSync(localSrc) && existsSync(join(installed, 'lib'))) {
      const diffs = diffTrees(localSrc, join(installed, 'lib'));
      if (diffs.length) {
        // 硬拦截点：改了源码未发版却仍 registry 安装 = 同版本号不同内容事故本体
        results.push({ name, status: 'FAIL', msg: `registry 安装且与本仓 lib 有差异（${diffs.length} 个文件）：\n      ${diffs.slice(0, 10).join('\n      ')}${diffs.length > 10 ? `\n      …共 ${diffs.length} 项` : ''}\n      → 改源码未发版必须改用 file: 安装：dsh plugin --profile web install` });
        failed++; continue;
      }
      note = 'registry 安装，内容与本仓 lib 一致';
    } else {
      note = 'registry 安装（本仓无该插件或未 build，无法比对）';
    }
    results.push({ name, status: 'WARN', msg: `${note}；registry 包只在「发版→立即重装」闭环里可信，若已改源码未发版请改用 file: 安装` });
    continue;
  }

  const src = resolveFileTarget(spec);

  // 检查 3：profile 内必须是真实目录，不是软链
  if (existsSync(installed) && lstatSync(installed).isSymbolicLink()) {
    results.push({ name, status: 'FAIL', msg: 'profile 内是软链：Node 按 realpath 解析会脱离宿主 fallback，报 Cannot find package' });
    failed++; continue;
  }

  // 源码 lib vs 部署 lib
  const srcLib = join(src, 'lib');
  if (!existsSync(srcLib)) {
    results.push({ name, status: 'FAIL', msg: `file: 源码缺少 lib/（未 build？）：${srcLib}` });
    failed++; continue;
  }
  if (!existsSync(join(installed, 'lib'))) {
    results.push({ name, status: 'FAIL', msg: `profile 内插件不完整（无 lib/）：${installed}` });
    failed++; continue;
  }
  const diffs = diffTrees(srcLib, join(installed, 'lib'));
  if (diffs.length) {
    results.push({ name, status: 'FAIL', msg: `源码 lib ≠ 部署 lib（${diffs.length} 个文件差异）：\n      ${diffs.slice(0, 10).join('\n      ')}${diffs.length > 10 ? `\n      …共 ${diffs.length} 项` : ''}\n      → 改完源码后重新 install：dsh plugin --profile web install` });
    failed++; continue;
  }

  // 顺带验证 file: 目标确实存在
  if (!existsSync(src)) {
    results.push({ name, status: 'FAIL', msg: `file: 目标不存在：${src}` });
    failed++; continue;
  }
  results.push({ name, status: 'PASS', msg: `file: 安装，源码 lib 与部署 lib 一致（源自 ${src}）` });
}

// 检查 2：profile 内 @deepseek-ai/ 无宿主核心包阴影
const dsaiDir = join(PROFILE, 'node_modules', '@deepseek-ai');
if (existsSync(dsaiDir)) {
  const present = readdirSync(dsaiDir).filter((n) => !ALLOWED_HOST_PKGS.has(n));
  if (present.length) {
    results.push({ name: '@deepseek-ai/*', status: 'FAIL', msg: `出现非白名单宿主核心包：${present.join(', ')} → 第二套 @deepseek-ai/*，Symbol 错配/400 前兆；用 dsh plugin --profile web install 重装` });
    failed++;
  } else {
    results.push({ name: '@deepseek-ai/*', status: 'PASS', msg: '仅 cosmokit / schemastery，无宿主核心包阴影' });
  }
}

// ---------- 输出 ----------
console.log(`部署纪律自检（profile: ${PROFILE}）\n`);
for (const r of results) {
  const icon = r.status === 'PASS' ? '✓' : r.status === 'WARN' ? '△' : '✗';
  console.log(`${icon} [${r.status}] ${r.name} — ${r.msg}`);
}
if (!checked && !pkgFilters.length) console.log('（profile 内未发现插件依赖）');
console.log(`\n共 ${results.filter((r) => r.name !== '@deepseek-ai/*').length} 个插件，FAIL ${failed}。`);
process.exit(failed ? 1 : 0);
