# 发布记录：dsh-subagent-router

**已发布**（GitHub + npm）：`dsh-subagent-router@0.3.0`（latest，git CI 自动发布）。旧名 `dsh-subagent-model-picker`（0.1.0 / 0.1.1）已 deprecate 指向本包。

## 发布状态（2026-09 单库化更新）

> 本仓库 2026-09 从 dsh-plugins monorepo 迁出为独立单库（`NinjaSln-labs/dsh-subagent-router`），
> 历史 0.3.0 及更早在 monorepo 发布；此后版本在**本单库**发布。

| 项 | 状态 |
|---|---|
| npm | ✅ `dsh-subagent-router@0.4.0`（latest，CI 自动发布）· `0.3.0` · `0.2.0` · `0.1.1` · `0.1.0`（手动首发 bootstrap） |
| GitHub | ✅ 单库 `NinjaSln-labs/dsh-subagent-router`；tag `subagent-router-v0.4.0`（本单库首个）；历史 tag `subagent-router-v0.3.0` 在 dsh-plugins monorepo |
| 旧包 | ✅ `dsh-subagent-model-picker` 0.1.0/0.1.1 deprecated（Renamed to dsh-subagent-router） |
| profile | `~/.dsh/profiles/web` 仍为 `file:` 协议指向本地插件目录（本机私有部署；发版后可选切回 npm `^0.4.0`，见 HANDOFF §3.1（本地私有，未追踪）） |
| 发布管道 | ✅ tag → 版本守卫 → 验证链 → OIDC trusted publishing 直发（0.1.1 首次跑通；0.3.0 第三次；**0.4.0 单库化后首个、OIDC Trusted Publisher 首次跑通，provenance v1**） |

## 版本历史

- **0.4.0** — **单库化后首个版本 + peer 对齐宿主 alpha + 配置面板修复闭环**（本单库发布）：
  - 单库迁移：dsh-plugins monorepo → `NinjaSln-labs/dsh-subagent-router` 独立仓库（subtree split 保留历史）；check:deploy + pre-commit 部署纪律落地
  - peer 对齐宿主 alpha（`0cc33e1`）：cordis `^4.0.2` / dsh-client-runtime `^0.1.1-rc.2` / 其余 dsh 宿主包 `^0.1.2-alpha.4`；适配 dsh-settings `installSection`、dsh-util-values `JsonValue`、`ToolCallId`、provider `agentOptions` capability
  - 配置面板修复：模型目录改走 host catalog RPC（`309323a`）、推荐分类超时 8000ms（`ad75a14`）、分档策略合并为单个「选型策略」控件 + 补 light 档（`017d3e8`/`467c87d`）
  - **根治「选默认保存又回固定」**（`aa2ccfe`）：host 侧 schemastery schema 归一化把缺失 `autoTierPicks` 补成四档空数组、client `picks !== undefined` 误判为「固定」；档位数组/标量加 `.default(undefined)` 修复（Playwright 实机复测通过）
  - 验证：strict typecheck + 132/132 vitest + build + mount 全绿；CI 等价验证通过后推 `subagent-router-v0.4.0` tag → OIDC trusted publishing 发布（public 源仓库，provenance v1）
  - 发布前置（承接）：Trusted Publisher 在 npmjs.com 配置完毕（Owner=`NinjaSln-labs` / Repo=`dsh-subagent-router` / Workflow=`publish.yml`）

- **0.3.0** — **配置面瘦身 + 枚举化 + 1c 目录元数据**（接手会话配置体验闭环，breaking）：
  - 配置面瘦身：注册快照 8 项（subagentProvider/toolName/modelsToolName/enableRunInBackground/backgroundMode/enableModelList/enableAuto/maxDepth）剔除、固定为 `fixedConfig`（spawn / continuable / provider-managed）；只留 live 字段——「保存即生效」对所有可见配置成立
  - 枚举化候选：`autoProviderOrder`/`autoTierPicks` 改真实目录下拉（client `connection.api.llm.models` 全局目录，OrderedPicker 有序多选，归一化聚合 + 供应商标注）
  - **移除 autoCeiling**（最后一处手填模型 id，语义与 tierPolicy 重叠）；autoTierPicks 改按 `autoProviderOrder` 顺序找
  - ROADMAP 1c：`subagent_models` 每个模型加派生元数据（cost/speed/strength/specialty/contextWindow，`src/meta.ts`）
  - 设置页 UX：分组标题/层次、触控目标、`:focus-visible`、保存反馈、tier policy 保存修复（stale 闭包 + patch 冗余值根因）
  - 配置面最终：**7 个 live 字段**；67/67 vitest
  - 发布前置（承接）：client build 干净安装缺陷已在前版修复（`3f9c919`，ui-slots devDep pin）

- **0.2.0** — **健康感知 + 配置化 + 设置页 UI**（HANDOFF 会话三大功能块）：
  - 内容：失败分类脱敏透传、死锚检测（RouteHealthStore）、终态换路（autoReroute）、升级参数化（autoEscalationTiers）、目录健康标注、模型路由优先级配置化四层（autoProviderOrder/autoTierPolicy/autoTierPicks/autoCeiling）、设置页配置 UI（host+client 化，settings 命名空间 + 插件卡片）
  - 发布前置修复（`3f9c919`，接手会话）：client build 干净安装缺陷——`@deepseek-ai/dsh-client-ui-slots` module augmentation 在全新 `npm install` 下 TS2664/TS2345（`skipLibCheck` 不加载 .d.ts 传递 import）；修复 = devDependencies 精确 pin `0.1.0-rc.6`（与 runtime peer 解析副本一致，caret 会漂移致 SlotMap 双副本）+ client.tsx 副作用 `import type {}`。详见 HANDOFF §4 坑 9（本地私有，未追踪）
  - 验证：strict typecheck + 66/66 vitest + build 全绿；CI 等价（fresh `npm install`）模拟通过后推 tag → GitHub 审批 → publish

- **0.1.1** — **git 自动发布管道首次跑通**：
  - 发布流程：`npm version patch --no-git-tag-version`（工作树脏时 npm 的自动 commit/tag 会被跳过）→ 手动 commit + 打 `subagent-router-v0.1.1` tag → push → GitHub 审批（environment `npm-publish`）→ CI publish
  - 管道修复的两个 CI 坑（原记录在仓库根 `HANDOFF-ARCHIVE/`，该目录已删除，详情如下）：
    1. workflow step name `Guard: tag version...` 冒号 = invalid YAML，GitHub 静默失败 run 从不触发发布——加引号修复（`d071b69`，顺带修好 context-compass 的 publish.yml）
    2. setup-node `cache: npm` 找不到 lockfile（本仓库 pnpm lock 不入库）→ Setup Node 直接失败——去掉 `cache: npm`（`c42fe98`）

- **0.1.0** — **新包名首发（手动 bootstrap）**：
  - 背景：更名 `dsh-subagent-model-picker` → `dsh-subagent-router`（picker 低估了路由+auto 策略的功能面）；granular token 选不到未发布包，需手动首发
  - 手动 `npm publish`（npm 发布 token，向用户索取）→ 包上线后建立限权 granular token → NPM_TOKEN secret → 后续版本走 git 管道
  - 旧包 deprecate：`dsh-subagent-model-picker@0.1.0/0.1.1` → 「Renamed to dsh-subagent-router」

- **0.1.0–0.1.2（旧名 dsh-subagent-model-picker，已 deprecate）**：
  - v0.1.0 — 首发：`subagent_model` / `subagent_models` 两个工具（显式 provider/model/max_tokens）
  - v0.1.1 — `model: "auto"` 自动选型（任务分档 → 目录打分 → 失败升级 → 可审计）
  - v0.1.2 — auto 策略锚定父模型（默认沿用父模型，重任务弱父升强，升级只升不降）

## 发布流程（日常）

```bash
# 本单库仓库根即插件目录（2026-09 单库化）
npm version patch --no-git-tag-version -m "chore: release v%s"
git add package.json && git commit -m "chore: release v$(node -p "require('./package.json').version")"
git tag subagent-router-v$(node -p "require('./package.json').version")
git push && git push --tags    # CI 验证 → 人工审批 → OIDC trusted publishing 发布
```

## 维护规则

- 每个新版本发布后在本文件追加一条版本历史（一行式 + 关键细节），并在 `HANDOFF.md` §2 同步快照（本地私有，未追踪）
- 发布一律走 git 管道，不用手工 `npm publish`（bootstrap 例外仅限新包名首发）
