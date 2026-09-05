#!/usr/bin/env node
/**
 * 验证链单源入口（single source of truth）。
 *
 * package.json 的 "verify"、.github/workflows/ci.yml 与 .github/workflows/publish.yml 的 Verify
 * 步骤都只调本脚本——"验证链三处一致"由此从纪律约束变成结构保证：链内增删步骤只改这里。
 *
 * 固定步骤：build → typecheck
 * 探测步骤（文件存在才跑，按序）：
 *   vitest.config.{ts,mjs,js} 或 tests/ 目录 → npx vitest run（真实驱动测试）
 *   scripts/mount.mjs                        → 真实 cordis 挂载测试
 *   scripts/client-mount.mjs                 → 浏览器启动路径
 * 退出码：任一步 FAIL = 1（发布前门）。
 *
 * 说明：visual（Playwright 视觉回归）需要运行中 harness，是本地发布前门、不进 CI——
 * 与实践库一致，不在本链内；需要时加 `npm run visual` 自查。
 * check:deploy 是本机部署一致性检查（比对 profile 副本），不在验证链内。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const steps = [
  { name: 'build', cmd: 'npm run build' },
  { name: 'typecheck', cmd: 'npm run typecheck' },
];
const hasVitestConfig =
  existsSync(join(ROOT, 'vitest.config.ts')) ||
  existsSync(join(ROOT, 'vitest.config.mjs')) ||
  existsSync(join(ROOT, 'vitest.config.js'));
const hasTestsDir = existsSync(join(ROOT, 'tests'));
if (hasVitestConfig || hasTestsDir) steps.push({ name: 'vitest', cmd: 'npx vitest run' });
if (existsSync(join(ROOT, 'scripts', 'mount.mjs')))
  steps.push({ name: 'mount', cmd: 'node scripts/mount.mjs' });
if (existsSync(join(ROOT, 'scripts', 'client-mount.mjs')))
  steps.push({ name: 'client-mount', cmd: 'node scripts/client-mount.mjs' });

console.log(`验证链（verify.mjs 单源）：${steps.map((s) => s.name).join(' → ')}\n`);

const failed = [];
for (const step of steps) {
  const r = spawnSync(step.cmd, { shell: true, stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) {
    console.error(`\n✗ [FAIL] ${step.name}（exit ${r.status ?? 'signal'}）——验证链中断，禁止发布`);
    process.exit(1);
  }
  console.log(`✓ [PASS] ${step.name}`);
}

console.log(`\n验证链全绿（${steps.length} 步）。`);
