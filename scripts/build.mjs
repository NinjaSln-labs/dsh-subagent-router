#!/usr/bin/env node
/**
 * 构建探测包装（build 链单源入口）：package.json 的 "build" 固定调用本脚本。
 *
 * 固定步骤：tsc -p tsconfig.build.json（host 产物 lib/）
 * 探测步骤（文件存在才跑，按序）：
 *   scripts/build-client.mjs → client bundle（esbuild；本仓存在，自动生效）
 *
 * 有 client 半的库接入 build-client.mjs 后自动生效，不用改 build 命令；
 * 无 client 的库验证链不再死在缺失脚本上。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 固定步骤：host tsc 编译
const tsc = spawnSync('npx tsc -p tsconfig.build.json', { shell: true, stdio: 'inherit', cwd: ROOT });
if (tsc.status !== 0) {
  console.error(`✗ tsc 失败（exit ${tsc.status ?? 'signal'}）`);
  process.exit(1);
}

// 探测步骤：client bundle（存在才跑）
const buildClient = join(ROOT, 'scripts', 'build-client.mjs');
if (existsSync(buildClient)) {
  const r = spawnSync('node', [buildClient], { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) {
    console.error(`✗ build-client 失败（exit ${r.status}）`);
    process.exit(1);
  }
}
console.log('build 完成（tsc host + client bundle）。');
