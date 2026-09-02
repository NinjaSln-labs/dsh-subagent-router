# dsh-subagent-router 开发流程（敏捷迭代版）

> 原则：**短迭代、增量交付、持续反馈、复盘沉淀**。插件开发不是一次性的瀑布工程，而是一连串小迭代——每个功能就是一个迭代，每个迭代结束都要交付可用的版本、收集反馈、复盘沉淀。
> 本仓库是 `dsh-subagent-router` 的**独立单库**（2026-09 从 dsh-plugins monorepo 迁出），仓库根即插件目录。

## 核心循环（一个迭代 = 一个功能）

```
Backlog ──Sprint 计划──▶ 设计决策 ──▶ 实现 ──▶ DoD 验证 ──▶ 交付试用 ──▶ 回顾
   ▲                                                                        │
   └────────────────── 反馈/新坑 进 Backlog 与速查表 ◀───────────────────────┘
```

- **迭代长度**：一个功能一个迭代（动态插件场景下通常就是一次会话/一个版本）；多个小功能可合并一个迭代
- **每迭代只做 1-2 条 Backlog**，做完并验证才进下一个——防止"半成品堆叠"

## 1. Backlog（产品待办，用户故事格式）

所有条目用用户故事写，**体验导向**：

```
作为 <用户>，我想要 <能力>，以便 <收益>
```

三类条目统一进 Backlog，按价值排序：
- **功能**：新能力（如"作为用户，我想要子代理按任务复杂度自动升级模型，以便不用手动指定"）
- **缺陷**：从用户反馈来的（如"402 配额耗尽没触发换路"）
- **技术债**：从回顾来的（如"client half 缺失"）——不还债 = 后面更慢

## 2. Sprint 计划（迭代开始，轻量）

- 从 Backlog 顶部取 1-2 条
- **只做必要的设计决策**（不是全套设计文档）：
  - 平台与边界：host/client 各自做什么（**两个 half 都要写**）
  - 契约预检：`cordis_inspect_query` 查清用到的 Service/Event/Builtin/Slot 精确签名（动态插件尤其重要——格式错误运行时才发现 = 一个迭代白做）
  - 数据流与生命周期：状态放哪、谁写谁读、停止/更新时清理什么
  - 边界条件：空输入 / 并发 / 超时 / 取消 / 重启恢复

## 3. 实现

编码规范（动态 Cordis 插件）：

- 纯 JS，无 TS/JSX/import/require
- **沙箱禁用全局**：`setTimeout/setInterval/setImmediate/clearTimeout/clearInterval`（用 `ctx.timeout/ctx.interval`，`inject: ['timer']`）、`fetch`（用 `ctx.web`）、`process/Buffer`（用 btoa/atob/TextEncoder）、`require`（用服务）
- 服务访问：`ctx.get(name)` + undefined 检查；硬依赖才 `inject`
- 动态工具：`harness.defineTool()` 包装后再 `harness.registerTool(ctx, tool)`；`parameters` 根省略 `additionalProperties`
- **每次 define 显式提供 `code.host` 和 `code.client`**（省略 client = UI 消失，踩过 4 次）
- append 事件格式：先查系统同类事件再写（source/id/surfaceOp 对齐）

## 4. DoD（Definition of Done）——每迭代必须全部满足

> 没有验证 = 没有做完。以下清单逐项打勾，全绿才算迭代完成。

### 功能 DoD
- [ ] 用户故事描述的行为可复现（手动走一遍）
- [ ] 端到端验收任务跑通（如：`subagent_model` 传 `model: "auto"` → 子代理按档选型并带 `[auto]` 理由返回）
- [ ] 边界条件处理明确（空/并发/超时/取消/重启）

### 质量 DoD（AI 风险检查）
- [ ] `cordis_inspect_self`：state=running，**hasHostHalf 与 hasClientHalf 均为 true**
- [ ] 无沙箱禁用全局（grep setTimeout/fetch/require/process/Buffer）
- [ ] 所有 ctx 服务访问有契约依据（无猜的 API）
- [ ] 生命周期可逆（stop 后无残留进程/定时器/订阅）
- [ ] 持久化/写入路径确定（基目录明确）
- [ ] 通知/消息格式对照系统事件
- [ ] 客户端无 `client-render` 诊断；工具注册确认
- [ ] 会话日志无 command/done error；状态文件按预期生成

### 文档 DoD
- [ ] README（双语）更新（决策、接口、已知坑）
- [ ] PUBLISHING.md 版本历史一行记录（做了什么 + 为什么）
- [ ] 新坑已进速查表（若无则不勾）

### 端到端验收任务模板

```
委托一个子代理，prompt 为「分别总结 Git 的 fast-forward、rebase、squash 三种合并策略，再综合成一段对比」，model 用 auto
```
验收点：auto 选型给出理由 → 子代理运行 → 结果带 `[auto]` 行与 `tier` → 失败时能观测到分类与换路。

## 5. 交付与反馈

- 交付 = 一个可运行的版本 + 一句话变更说明（用户看得懂）
- **让用户立即试用**：给一条可直接复制的命令
- 用户的每个反馈都登记：满意点 / 不满意点 / 建议——不满意点优先转成 Backlog 缺陷条目

## 6. 回顾（Retrospective，每迭代 5 分钟）

三个问题，答案必须落盘（写进 PUBLISHING.md 或速查表）：

1. **这次什么顺利？**（保留的做法）
2. **这次踩了什么坑？**（新坑 → 立即进速查表）
3. **同类坑是否重复出现 ≥2 次？**（是 = 流程缺陷，先补流程再继续）

## 看板状态流

```
Backlog → In Progress → Verify(DoD) → Done
              ↑              │
              └── 未过 DoD：打回 ──┘
```

## 部署纪律：profile 安装（2026-08-31 事故沉淀，2026-09 单库化适配）

> 事故：本地改了源码并 build，但 profile 里装的仍是 registry 旧版——**同版本号、不同内容**，版本校验完全失效，行为错位极难排查。根因是安装方式不统一（registry / file: 混用 + 无装后校验）。

### 统一规则

| 插件状态 | profile 安装方式 |
|---|---|
| 联调中（本目录有未提交改动） | `file:` 指向本目录源码目录 |
| 已入库、未发版 | `file:` 指向本目录（仓库根即插件） |
| 已发版且本目录 lib == 部署 lib | registry `^x.y.z` |

安装一律走官方入口（内部 pnpm，禁裸 npm install——npm 会把 peerDependencies 装进 profile，产生第二套 `@deepseek-ai/*`，导致 Symbol 错配 unscoped、webserver 版本错配 400）：

```bash
dsh plugin --profile web install
```

### 装后自检（每次 install 后必跑）

一键自检脚本（替代手工 diff，FAIL 即非零退出码）：

```bash
npm run check:deploy     # 全量（本单库即一个插件，等价 --pkg dsh-subagent-router）
```

FAIL 条件：① registry 安装且与本目录 lib 有差异（同版本号不同内容，硬拦截）；② profile 内 `@deepseek-ai/` 出现非 cosmokit/schemastery 包；③ `file:` 安装为软链，或源码 lib ≠ 部署 lib。

手工命令（脚本不可用时的等价操作）：

```bash
# 1) 对齐：源码 lib == 部署 lib（改完源码必跑，diff 非空 = 事故前兆）
diff -rq lib ~/.dsh/profiles/web/node_modules/dsh-subagent-router/lib

# 2) 无宿主核心包阴影：此处只允许 cosmokit / schemastery
ls ~/.dsh/profiles/web/node_modules/@deepseek-ai/

# 3) file: 拷贝应为真实目录（pnpm 会剥离插件自带 node_modules，防遮蔽宿主）
ls -la ~/.dsh/profiles/web/node_modules/ | grep dsh-subagent-router
```

### 强制执行（git hook）

pre-commit 钩子（`.githooks/pre-commit`）：提交涉及 `src/`、`scripts/` 改动时自动跑 `check:deploy`，FAIL 拒绝提交（`lib/` 为构建产物已 ignore，故挂在 src 上）。启用方式：

```bash
git config core.hooksPath .githooks
```

中间态确需跳过时用 `git commit --no-verify`，并在提交说明注明"未部署，部署前需自检"。仓库根的 `AGENTS.md` 已内联规则摘要（指向本节）。

### 关键认知

- **版本号相同 ≠ 内容相同**：registry 包只在"发版→立即重装"闭环里可信；脱离闭环一律降级为 file: 直装
- peer 永远由宿主 dsh 提供（fallback 在 `~/.dsh/profiles/node_modules/@deepseek-ai/`），profile 内不装宿主核心包；`npm ls` 报 missing peer 属预期（运行时由宿主解析）
- **单库化说明**：monorepo 时代的 `pnpm-workspace.yaml` 及 `overrides`（32 条钉版本）是**多包 workspace 防双实例护栏**，本单库只有单一包、不是 workspace，**不需要** pnpm-workspace.yaml/overrides——peer 版本兼容由宿主 dsh 单点决定，peerDependencies 声明实际需求即可
- `file:` 场景禁止手动软链：Node 按 realpath 解析会脱离 profile 的宿主 fallback，报 `Cannot find package '@deepseek-ai/...'`

## 附录：高频坑速查表（回顾沉淀）

| 坑 | 症状 | 拦截环节 |
|---|---|---|
| 省略 client half | 看板/UI 消失 | 实现规范 + 质量 DoD |
| setTimeout 等全局定时器 | 运行时 throw | 实现规范 + 质量 DoD |
| defineTool 未包装 / parameters 违规 | host-half-failed | Sprint 计划契约预检 |
| user/message source/id/surfaceOp 格式错 | 静默被拒，状态误存 | Sprint 计划契约预检 |
| workspaceRoot 与会话 cwd 不一致 | 文件落错目录 | Sprint 计划数据流 |
| persist 防抖吞最后一次更新 | 状态丢失 | Sprint 计划边界条件 |
| 子代理提前结束（只声明意图） | 产出残缺 | 功能 DoD 验收任务 |
| 依赖任务拿不到上游产出 | 下游瞎找 | Sprint 计划数据流 |
| subagent-settled 通知默认折叠渲染 | 用户看不到汇报（收起时仅一行 summary） | Sprint 计划数据流（summary 要承载核心信息） |
| 宿主升级导致 peer API break | 插件启动即炸（如 dsh-settings API 变更） | 发版前对照宿主版本验证；peerDependencies 如实声明 |
| 中文任务被系统性低估 | 一般中文 prompt 总落 `standard` 档，选不到强/弱模型 | verb-tier 动词中英双语字典 + 四档细分（trivial/light/standard/complex） |
| 402 配额耗尽未触发换路 | 子代理失败却只记瞬态 `other`，5 分钟后恢复重试同 provider | 从 `SubagentResult.diagnostic` 提取失败证据分类为 `quota`，触发 autoReroute |
| registry 装的插件改了源码没发版 | 同版本号不同内容，行为错位、版本校验失效 | `npm run check:deploy`（registry 差异 → FAIL）+ `.githooks/pre-commit` 硬拦截 + AGENTS.md 规则内联 |

## 维护

- 速查表 = 回顾的沉淀物，新坑先补表再修码
- 流程本身也要迭代：回顾中发现"清单没拦住"的坑 → 改清单
