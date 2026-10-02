# dsh-subagent-router — Roadmap

状态基准：**v0.3.0**（2026-08-27 发布，git CI 管道跑通）。本文件是路线图的**唯一权威来源（单源）**；`.handoff/` 存储（本地私有，未追踪） / `PUBLISHING.md` / `README.md` 只记录 delta 并引用本文件，不复制路线内容。

## 已交付（到 v0.3.0）

### 第一波（v0.1.x，含旧名 dsh-subagent-model-picker）

- **显式模型路由** — `subagent_model` 工具：每次委派可指定 `provider` / `model` / `max_tokens`；省略字段继承父级路由
- **目录工具** — `subagent_models`：实时 provider 路由 + 模型目录（advisory）
- **`model: "auto"` 自动路由** — 锚定父模型（默认，`anchored` 标记）→ 任务分档（trivial/standard/complex）→ 重任务弱父升强（目录最强）→ 失败升级（`autoEscalate`，只升不降）→ 全程可审计（`[auto]` 行 + reason + escalatedFrom）
- **CI 自动发布** — tag `subagent-router-v*` 触发 → 版本守卫 → 验证链（strict typecheck/30 测试/build）→ environment `npm-publish` 人工审批 → `npm publish`
- **更名** — `dsh-subagent-model-picker` → `dsh-subagent-router`（旧包已 deprecate 指向新包）

### 第二波（v0.2.x 先行项，健康感知）

- **失败分类与脱敏透传** — 可观测失败（start 拒绝 / 基础设施故障）分类为 quota / rate-limit / auth / context / server / timeout / transport，脱敏拼进工具结果（含 HTTP 状态与 retry-after），不再只是「subagent run failed」
- **死锚检测（健康感知）** — 会话内 per-route 失败分类（`RouteHealthStore`）；父路由不健康时 auto 不再锚定，改挑健康 provider。**2026-08-27 深化（与 2a 同期）**：过期从单一 60s TTL 改为按失败类型分档——auth 终态(不过期) · model-not-found 24h · rate-limit 用 retry-after+buffer，无则 35s(RPM 假设) · quota 下一时钟整点 · server/timeout/transport/context 60s · other 5min 默认；`extractFailureEvidence` 从 cause chain 提取 retry-after + model-not-found
- **终态失败换路** — `quota`/`auth` 失败时换到健康 provider 路由重试（`autoReroute`，默认开），不再傻等同一路由
- **升级次数参数化** — `autoEscalationTiers`（默认 1，保持历史行为；可调大），`autoEscalate` 仍控制开关
- **目录健康标注** — `subagent_models` 输出每个 provider 的 `health` + `failingClass` + `retryAfterSec`
- **模型路由优先级配置化（四层组合）** — `autoProviderOrder`（供应商优先级）+ `autoTierPolicy`（每档模式：anchor/cheapest/strongest）+ `autoTierPicks`（每档显式候选序，可跨 provider）+ `autoCeiling`（预算封顶）；都不配 = 现状不变

### 质量

- **64 项自动化测试全绿**（30 项既有 + 34 项新增：失败分类、健康存储、死锚换路、瞬态升级、多档阶梯、详情透传、目录标注、优先级配置四层、other 瞬态信号、换路沿用配置）
- **CI 双坑修复**（原归档于仓库根 `HANDOFF-ARCHIVE/`，该目录已删除，坑详情见 `../PUBLISHING.md` 0.1.1 节）：workflow step name 冒号 invalid YAML；setup-node `cache: npm` 无 lockfile

## 待做（按优先级）

> 主线目标：**自动路由从「启发式可用」走向「智能、可控、可量化」**。顺序原则：实测补齐 > 数据地基 > 推荐引擎 > 生态。

### Phase 1 — 打磨与实测（v0.2.x，近期）

| # | 项 | 优先级 | 动机 / 价值 | 依赖 |
|---|---|---|---|---|
| 1a | ~~`backgroundMode: continuable` 运行时实测~~ → **✅ 已完成（2026-08-27）**：base 层（profile cordis.patch.yml）`backgroundMode: continuable` + 重启 → `subagent_model` 默认返回 `kind:'continuable'` + 持久 `subagentId` → `send_message` 同会话续聊成功（第二轮回执「send_message 续聊 OK」）· spawn provider `prepareContinuable` 前提✅ · 前台路径✅ · one-shot 后台 jobs 通道✅ · 工具描述✅ · **关键机制发现**：`backgroundMode` 是注册期快照，`installSettingsSection` 的 `setSource` 异步注入晚于 `apply()` 冻结——用户层/设置页对该字段无效，**必须写 base 层**（详见 `.handoff/` 坑记录 10（本地私有，未追踪）） | P0 | 后台委派是主力场景，不能只靠单测；验证 startContinuable 路径 + 工具描述 | — |
| 1b | ~~profile 级 config 覆盖实测~~ → **✅ 已完成**：设置页 UI（设置 → 插件配置）实现并验证（host settings 命名空间 + client 卡片 + 实时生效，见 PLAN-settings-ui.md） | P1 | 配置面闭环，堵静默失效 | — |
| 1c | ~~目录元数据~~ → **✅ 已完成（2026-08-27，`fb14814`）**：`subagent_models` 每个模型加派生元数据（`cost` 成本档 / `speed` 速度档 / `strength` 强度档 / `specialty` 特长 / `contextWindow` 已知模型上下文窗口）——零外部依赖，命名启发式 + 内置已知映射（`src/meta.ts`）；无法推断的字段省略不猜，精确值留 3c | P0 | 一切智能选型的地基，推荐引擎（2a）的输入 | — |
| 1d | **auto 策略参数化（余项）**：档位阈值（字符数/markers）、**预算上限**（maxCost / tier ceiling） | P0 | 防升级失控；升级次数上限已交付（`autoEscalationTiers`） | — |
| 1e | ~~真实环境健康感知验证~~ → **✅ 已实测（2026-08-27，`ec10a98`）**：teamorouter/deepseek-v4-flash-free 委派失败复现。**发现两个问题**：① bug（已修）`initialAgentOptions` 传空 `{}` → 失败/健康记录 provider 记为 `spawn` 而非实际 llm provider；② **seam 局限（依赖 dsh-subagent）**——子代理「运行时」配额耗尽被 dsh-subagent 压缩成 `stopReason:'error'`（`dsh-tool-subagent` 渲染为 ``subagent run failed``），底层 LlmFailure/quota 证据不跨进程传回 tool 层，classifyFailure 只能判 `other`（瞬态 60s），死锚无法识别为终态 quota。**死锚+换路对「start 拒绝」（基础设施，能暴露 LlmError/HTTP）仍有效；对「运行时 quota」盲区需 dsh-subagent 暴露失败分类** | P0 | 死锚检测是本次新增的核心，需在真实 provider 上验证分类与换路 | 第二波 |

### Phase 2 — 智能推荐（v0.3.x，中期）

| # | 项 | 优先级 | 动机 / 价值 | 依赖 |
|---|---|---|---|---|
| 2a | **`subagent_recommend` 工具**：任务描述 → 推荐 provider/model + reason —— **✅ 已交付，随下版发布（2026-08-28，实测闭环）**：`src/recommend.ts` + `src/selection.ts`。核心设计：**「模型选型范围」候选池**（`buildSelectionScope` 全量 167 → ≤12 = `cheapest`/`medium`/`strong`/`best` 4 档各 3，`normalizeModelId` 去版本变体，多 provider 同模型按 `autoProviderOrder` 去重，`ScopeStore` 缓存 + `llm/adapters-updated` 失效）→ **分类器锚定父模型**（复用 harness auto 锚定语义；失败回退 `pickClassifiers` 多候选重试，排除 light/lite 超轻量）→ 归一化 LRU 缓存 + 超时降级（`recommendTimeoutMs` 默认 15000）+ `validatePicks` 归一/大小写鲁棒匹配 + 结果带 `recommended`（=top-1）+ `tier` 四档。**实测揪出并修复的问题链**：① pickClassifier 死守注册顺序选中慢 route + 超时太短 → 尊重 `autoProviderOrder` + 超时 4000→15000；② 分类器全幻觉 → `validatePicks` 归一鲁棒匹配；③ light 模型返回空/超时 → 排除超轻量 + medium/strong 优先；④ 单点分类器太脆 → 多候选重试；⑤ **收敛为锚定父模型**（`63b6691`，真机 2/3 命中 llm，剩余失败是 provider 真实 5xx 瞬态，降级启发式兜底正确）。`tests/{selection,recommend,failure-evidence}.spec.ts` 共 40 项，全套件 106/106 全绿 | P1 | 比命名启发式准一个量级；复用 harness auto 锚定 + knowledge L1 扩展模式（一次小模型调用 + 归一化缓存 + 超时降级）——**B2 已解除**：`ctx.llm.stream()` 插件内可自足发起辅助分类调用，无需跨仓库配合 | 1c |
| 2b | **失败反馈闭环**：按 任务类型×模型 记录成功/失败/耗时，反哺策略与推荐 | P1 | 长期差异化；轻量自存或对接 dsh-knowledge-sqlite | 2a |
| 2c | **同模型多 route 感知**：同一 model id 在多个 provider 注册时按成本/延迟选 route | P2 | 自动选择不应忽略路由维度（如 deepseek-v4-pro 在 deepseek-official 与 opencode-go 都有） | 1c |
| 2d | **预算仪表**：auto 决策历史（每任务选了谁、花了多少、升级几次）可查 | P2 | 可审计性从单次升级到全局 | 1d |

### Phase 3 — 生态（远期）

| # | 项 | 优先级 | 动机 / 价值 | 依赖 |
|---|---|---|---|---|
| 3a | **子代理自主升级**：任务中途自调 `subagent_model` 换强模型继续 | P2 | 启动便宜、中途发现变难场景 | — |
| 3b | **会话级策略**：per-session 默认策略（如「一律锚定父模型、不升级」） | P3 | 按会话场景定制 | 1d |
| 3c | **与 context-compass / session-health 打通**：选型直接吃真实计价数据（CNY/USD），替代命名启发式 | P3 | 成本感知选型 | 1c |
| 3d | **preset 化**：沉淀为 preset 行，其他 profile 一行启用 | P3 | 推广安装 | — |

## 被阻塞（需 harness 或跨仓库配合）

| # | 项 | 卡点 |
|---|---|---|
| B1 | 知识库自动写回（2b 强联动） | dsh-knowledge-sqlite 需开放公开、带门控的写入服务（跨仓库协作） |
| B3 | **死锚检测的「运行时失败」盲区**（1e 实测发现，2026-08-27） | dsh-subagent 故意把子代理「运行时」失败压成 `stopReason:'error'`（`dsh-tool-subagent:59` 渲染为 `subagent run failed`，dsh 主程序仓库），底层 `LlmFailure`（code/status/retry-after）留在子代理日志、不跨进程传回 tool 层 → router 的 `classifyFailure` 只能判 `other`（瞬态）而非终态 `quota`/`rate-limit`。**死锚+换路对「start 拒绝」（基础设施，能暴露 LlmError/HTTP）有效，对「子代理运行时 quota/限流」盲区**。根治需 harness 改动：`dsh-subagent` 在子代理结算时把失败分类作为结构化字段回传父层（harness 暂不动，仅记录） |

## 排期建议

| 版本 | 内容 |
|---|---|
| **0.2.x / 0.3.x** | ✅ 健康感知先行落地（失败分类/死锚/换路/升级参数化/目录标注）· ✅ 1b 设置页配置 UI · ✅ 1a continuable 实测 · ✅ 1c 目录元数据 · ✅ 1e 真实环境验证（发现 bug `ec10a98` + seam 盲区 B3）· 配置面瘦身+枚举化 |
| **0.4.x** | ✅ 2a subagent_recommend（已实测闭环）· 2b 反馈闭环 · 2c 多 route 感知 · 2d 决策历史 |
| **后续** | 3a–3d · B1/B3（等依赖就绪；B3 需 dsh-subagent 暴露失败分类） |

## 明确不做

- 无审计的黑盒自动选型（任何 auto 决策必须带 reason）
- 硬编码模型名单的策略（目录是活的，策略必须数据驱动）
- 替用户省钱作为唯一目标（任务匹配优先，省钱次之）

## 维护规则

- 本文件是路线图的**唯一权威来源**；完成一项 → 从「待做」移到「已交付」并标注落地版本
- 被阻塞项保留在「被阻塞」并写明卡点；卡点解除后移回「待做」
- 优先级/排期变化只改这里；`.handoff/` 存储（本地私有，未追踪） / `PUBLISHING.md` / `README.md` 引用本文件、不复制路线内容
- **peer 基线策略**：`peerDependencies` 声明"最低要求的服务版本"，保持宽松、不随 harness 每次升级而升；仅当接入依赖更高版本独有 API 时局部升对应服务
- **发布一律走 git 管道**（tag → 审批 → publish），见 `.handoff/` 存储与 `PUBLISHING.md`（本地私有，未追踪）
