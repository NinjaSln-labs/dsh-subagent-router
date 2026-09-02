# dsh-subagent-router

[English](README.en.md) | 简体中文

[![npm version](https://img.shields.io/npm/v/dsh-subagent-router)](https://www.npmjs.com/package/dsh-subagent-router)
[![GitHub stars](https://img.shields.io/github/stars/NinjaSln-labs/dsh-subagent-router?style=social)](https://github.com/NinjaSln-labs/dsh-subagent-router)

> 中文为本仓库权威文档；[English](README.en.md) 翻译可能滞后。

为 subagent 委派做模型路由的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。自带的 `subagent` 工具只会继承父级模型路由；本插件新增一个姊妹工具，让委派模型在每次调用时自行挑选子代理的 LLM **provider**、**model** 与 **输出上限**（或把选择交给内置的 `model: "auto"` 路由策略）—— 而委派的其他一切（深度核算、委派策略、continuable 后台子代理、结果收集）仍然完全走标准的 `ctx.subagents` 通道。

## 工具

| 工具 | 用途 |
|---|---|
| `subagent_model` | 委派任务给子代理，并在本次调用中指定 `provider` / `model` / `max_tokens`。省略的字段继承调用方代理的路由。传 `model: "auto"` 可把模型选择交给内置自动策略。 |
| `subagent_models` | 只读目录：列出当前 `ctx.llm` 上注册的 provider 路由（`listProviders()`）及每个 provider 广告的模型列表，并为每个模型标注**派生元数据**（`cost` 成本档 / `speed` 速度档 / `strength` 强度档 / `specialty` 特长 / `contextWindow` 已知模型的上下文窗口）+ 每个路由的 `health` 状态。 |
| `subagent_recommend` | 智能推荐：任务描述 → 返回排名靠前的 provider/model 建议（top-n，默认 3）。首选一次轻量 LLM 分类（`ctx.llm.stream()`，**锚定父模型**、失败多候选重试），并把全量目录精简成一个「模型选型范围」（≤12 = cheapest/medium/strong/best 四档各 3、去版本归一、多 provider 按优先级去重）喂给分类器；分类失败即降级到命名启发式并说明原因。结果带 `recommended`（系统默认首选）与 `tier` 四档。 |

### 模型选择如何工作

- **`provider`** 会与 `ctx.llm` 上注册的路由（如 `deepseek-official`，或你在 settings 里声明的任意 pi-ai 路由）做硬校验；未知路由立即报错并列出已注册路由。
- **`model`** 原样透传。Harness 把模型目录视为「参考性」信息：DeepSeek 适配器接受任意模型 id，而 pi-ai 路由会拒绝未配置的模型 —— 所以模型有效性由 provider 自己裁决，与你自己会话的行为完全一致。`subagent_models` 的存在就是为了让模型能做出有依据的选择。
- **`max_tokens`** 限制子代理输出（正整数），透传为 `agentOptions.maxTokens`。
- 子代理通过 `ctx.subagents.start()` / `startContinuable()` 创建，携带 `agentOptions = { provider, model, maxTokens }`；harness 的 `resolveChildAgentOptions` 会把本次覆盖与父级路由合并，因此省略的字段自动继承。

### 自动选择（`model: "auto"`）

把模型选择交给一个确定性、可审计的策略 —— 不引入额外 LLM 调用：

1. **确定 provider**：显式 `provider` 参数优先，否则取调用方代理自己的路由（`parent.options.provider`）。需要 `llm` 服务。
2. **任务分档**：`trivial`（短任务，≤160 字符且无重标记）、`complex`（≥1200 字符，或含代码块 / 结构化输出诉求 / 推理动词如 analyze、design、debug、refactor、evaluate），其余为 `standard`。
3. **默认锚定父模型**：调用方代理的 options 在解析出的 provider 上命名了模型时，就用它 —— `trivial`/`standard` 任务无条件使用，`complex` 任务在父模型已算强模型（`pro` / `max` / `reason` / `think` / `ultra` / `code` / `turbo` / `large` / `deep`）时也保留。只有两种情况回退到目录打分选型（强信号 +1、廉价信号 `flash`/`mini`/`lite`/`fast`/`small`/`quick`/`nano`/`light` −1；`trivial` 取最低分、`complex` 取最高分、`standard` 取第一个 0 分）：父没有命名模型，或任务是 `complex` 且父模型不够强（此时取目录最强模型）。显式 `provider` 与父路由不同时同样丢弃锚点（父模型不再属于该分组）。
4. **可审计**：每次 auto 调用都会在工具结果里记录 `auto: { provider, model, tier, reason, anchored?, escalatedFrom?, reroutedFrom?, rerouteReason? }`，渲染文本带 `[auto]` 行（保留父模型时带 `anchored` 标记）与理由 —— 随时可以问「为什么选它」。
5. **失败恢复**（仅前台调用）：
   - **瞬态失败升级**（`autoEscalate` + `autoEscalationTiers`）：`rate-limit` / `server` / `timeout` / `transport` / 未分类失败时，用下一档重试（`trivial → standard → complex`，默认最多 1 次），但仅当该选择**严格更强**于当前模型时才升级 —— 锚定的强父模型永远不会被降级。重试结果记录 `escalatedFrom`。后台/continuable 调用跳过升级（失败对调用方不可见）。
   - **终态失败换路**（`autoReroute`）：`quota` / `auth`（配额耗尽 / 凭据失效）重试同一 provider 无意义 —— 直接换到目录里第一个健康的 provider 路由重启（`reroutedFrom` + `rerouteReason`）。升级中若撞上终态失败也会停止继续升级该 provider。
6. **健康感知（死锚检测）**：插件在会话内记录每个 provider 路由的失败分类。一旦父模型所在路由被判定不健康，后续 `model: "auto"` 调用**不再锚定**该父路由，而是直接改挑健康 provider —— 避免把子代理一直钉在坏路由上。过期时间**按失败类型分档**：`auth` 终态（不过期）· 不支持模型 24h · `rate-limit` 用 retry-after（无则约 35s，RPM 假设）· `quota` 下一整点 · `server`/`timeout`/`transport`/`context` 60s · 未分类默认 5min。`subagent_models` 目录工具也会为每个 provider 标注 `health: healthy/unhealthy` + `failingClass` + `retryAfterSec`。
7. **失败详情透传**：子代理失败不再只是「subagent run failed」——能观测到的失败（`start` 拒绝、基础设施故障）会被分类（quota / rate-limit / auth / context / server / timeout / transport）并**脱敏**后拼进工具结果（含 HTTP 状态码与 retry-after），调用方直接看到「provider rate-limited (http 429)」而不是误判成执行失败。

策略刻意保守：默认沿用调用方自己的模型，只有任务明显超出弱父模型能力时才升级，从不隐藏自己的决策理由，并且一旦路由被证实不健康就果断换路而不是盲目重试。

## 安装

```bash
dsh plugin add dsh-subagent-router
```

bundle 只插入一行组合（`subagent-router`）。它消费 host 的 `tools` / `subagents` / `llm` 注册表且不发布任何服务，所以属于 host 平面（或 preset 的自由行），不需要 isolate realm。

## 配置

**设置页 UI**：插件提供 client half，配置可在 **设置 → 插件配置** 里直接编辑（`subagent-router` 卡片）。**全部可配置项都是 live 字段**——编辑即时写入用户设置层（`~/.dsh/settings.yaml` 的 `subagent-router` 段），**保存后下一次 `subagent_model` 调用即生效，无需重启**；清除字段回退到下方组合行配置。

也可以写在组合行的 `config` 里（作为 base 层，被设置页 user 层覆盖）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `autoEscalate` | `true` | 前台运行失败后是否用高一档自动重试一次。 |
| `autoReroute` | `true` | 终态失败（quota/auth）时是否换到健康 provider 路由重试。 |
| `autoEscalationTiers` | `1` | 同一 provider 上瞬态失败的最大升级次数（`0` 表示不升级）。 |
| `autoProviderOrder` | — | **provider 优先级**：`model: "auto"` 按此顺序解析 provider（未列出的排在之后）；父路由不健康或缺失时用它兜底。不配则用注册表顺序。 |
| `autoTierPolicy` | — | **每档选型模式**：`{ trivial\|standard\|complex: 'anchor'\|'cheapest'\|'strongest' }`。`anchor`=父路由健康时沿用父模型；`cheapest`=目录里命名分最低；`strongest`=最高。未配的档位保持内置启发式。 |
| `autoTierPicks` | — | **每档显式候选序**：`{ trivial\|standard\|complex: [modelId, ...] }`，完全覆盖该档选型；候选是全局模型优先级，按 provider 优先级顺序找，第一个被健康 provider 广告的模型胜出（可跨 provider）。 |
| `recommendTimeoutMs` | `8000` | `subagent_recommend` 的一次性 LLM 分类调用超时（毫秒）；超时降级到命名启发式并说明原因。 |

**固定默认（不可配置）**：注册期行为固定为合理默认，不再暴露为配置项（早期版本这些字段可配但「保存」不生效，是陷阱）：

| 槽位 | 固定值 | 理由 |
|---|---|---|
| 子代理提供方 | `spawn` | dsh 主程序的默认可续子代理提供方。 |
| 委派/目录工具名 | `subagent_model` / `subagent_models` | 标准命名，改名无场景价值。 |
| 后台模式 | `continuable` | 与 dsh harness 原生 subagent 语义一致：**默认后台、立即返回持久子代理 id、同会话可续聊**；需要前台等待时显式传 `run_in_background: false`。要求提供方具备 `prepareContinuable`（不支持则挂载时 fail-loud）。 |
| 功能开关 | 全开（`run_in_background` / `model: "auto"` / 目录工具） | 关闭无场景价值。 |
| 深度上限 | `provider-managed` | 交给提供方管理递归预算，任何提供方可挂载（不要求 `depthLimit` 能力）。 |

示例行：

```yaml
- id: subagent-router
  name: 'dsh-subagent-router'
```

带模型路由优先级的示例（按你自己的供应商偏好配置）：

```yaml
- id: subagent-router
  name: 'dsh-subagent-router'
  config:
    autoProviderOrder: [deepseek-official, pi-ai-cn]   # 供应商优先级
    autoTierPolicy:
      trivial: cheapest        # 琐碎任务永远用最便宜的
      standard: anchor         # 普通任务跟随父模型
      complex: strongest       # 重任务用最强模型
    autoTierPicks:
      complex: [deepseek-v4-pro, pi-3-maxi]  # 可选：重任务显式候选序
```

## 典型模型流程

1. `subagent_models` → 列出 `deepseek-official`（含其目录）与所有 pi-ai 路由。
2. `subagent_model` 传 `{ description: "对比定价", prompt: "...", provider: "deepseek-official", model: "deepseek-r1", max_tokens: 4000 }` → 子代理在该路由上运行并返回结果。
3. `subagent_model` 传 `{ description: "say hi", prompt: "hi", provider: "deepseek-official", model: "auto" }` → 若调用方自己的模型属于该 provider，则沿用父模型（`[auto]` 行带 `anchored` 标记）；否则回退到目录选型并记录 `[auto] ...` 及其理由。
4. 省略 `provider`/`model` 即让子代理沿用你自己的路由。

## 开发

```bash
npm install --legacy-peer-deps
npm test       # vitest：schema 形态、路由校验、agentOptions 透传、目录工具、auto 策略与升级、健康换路
npm run build  # tsc -> lib/ + esbuild 客户端 bundle
```

测试套件在真实的 `ToolRuntime` + `SubagentRuntime` 上驱动真实插件体，使用脚本化子代理 provider 与伪造的 `llm` 路由注册表；不触网、不用凭据。

## 路线图

自动路由策略的后续计划（目录元数据、推荐工具、反馈闭环、预算上限）：见 [docs/ROADMAP.md](./docs/ROADMAP.md)。发布记录见 [PUBLISHING.md](./PUBLISHING.md)。交接记录（HANDOFF.md）为本地私有文件，不入仓库/npm 包。

## License

MIT
