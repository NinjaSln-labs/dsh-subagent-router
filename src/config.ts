/**
 * dsh-subagent-router — plugin config schema.
 *
 * The exported schemastery `Config` documents the config shape for the
 * settings UI (设置 → 插件配置). Only LIVE fields are configurable: they are
 * re-read on every tool call (`getConfig()`), so a settings write takes effect
 * on the next call without a restart.
 *
 * Registration-time knobs (subagent provider, tool names, background mode,
 * depth cap, feature toggles) are NOT configurable — they are fixed module
 * constants with sane defaults in index.ts / tools.ts (see the "fixed" block
 * there). Making them configurable earlier produced a settings surface where
 * "saves" silently did not apply (注册期快照, see HANDOFF 坑 10), so they were
 * removed from the config face entirely.
 *
 * *** 双源警告 ***：此 schema 的 `.default()` 值与 index.ts 中
 * `resolveConfig` 的 `??` 回退必须保持同步——Loader 路径走 schema 归一化，
 * 直接调用路径走 resolveConfig；改一处必须改另一处。
 */
import z from '@deepseek-ai/schemastery'

/** Per-tier auto selection mode. */
const autoTierPolicyMode = z.union([z.const('anchor'), z.const('cheapest'), z.const('strongest')])

/** Schemastery schema: documents the shape for the Loader and settings UI. */
export const Config = z.object({
  /** After a failed foreground run, retry once on the next auto tier (default true). */
  autoEscalate: z.boolean().default(true),
  /** Reroute to a healthy provider route when the auto-chosen route fails terminally (quota/auth) (default true). */
  autoReroute: z.boolean().default(true),
  /** Max escalation steps on the same provider after repeated transient failures (default 1). */
  autoEscalationTiers: z.number().min(0).default(1),
  /** Provider priority order for `model: "auto"` provider resolution (default: registry order). Unlisted providers sort after listed ones. */
  autoProviderOrder: z.array(z.string()).default([]),
  /** Per-tier selection mode; omitted tiers fall back to the built-in heuristic (trivial→cheapest, light→balanced, standard→strong, complex→strongest). */
  autoTierPolicy: z.object({
    trivial: autoTierPolicyMode.required(false),
    light: autoTierPolicyMode.required(false),
    standard: autoTierPolicyMode.required(false),
    complex: autoTierPolicyMode.required(false),
  }).required(false),
  /** Per-tier explicit candidate list, in priority order; when present, fully overrides the tier policy for that tier. */
  autoTierPicks: z.object({
    trivial: z.array(z.string()).required(false),
    light: z.array(z.string()).required(false),
    standard: z.array(z.string()).required(false),
    complex: z.array(z.string()).required(false),
  }).required(false),
  /** Classifier timeout for `subagent_recommend`'s one-shot LLM call, in milliseconds (default 8000). Past it the tool degrades to the naming heuristic. */
  recommendTimeoutMs: z.number().min(100).default(8000),
})

/**
 * 注册期固定配置（单一权威来源）：这些槽位曾是配置项，但都是「注册时快照」
 * ——设置页改了既不生效也不报错（见 HANDOFF 坑 10 的 backgroundMode 案例），
 * 对用户是个坑。现全部固定为合理默认，不再暴露给用户配置：
 *
 * - subagentProvider: 'spawn' —— dsh 主程序的默认可续子代理提供方
 * - toolName / modelsToolName —— 标准工具名（改名没有场景价值）
 * - enableRunInBackground: true + backgroundMode: 'continuable'
 *   —— 与 dsh harness 原生 subagent 工具语义一致（后台默认 + 持久 subagentId +
 *   可续聊；显式 run_in_background: false 仍可前台等待）；continuable 要求提供方
 *   具备 prepareContinuable（挂载时 fail-loud）
 * - enableModelList / enableAuto —— 功能开关固定打开（关闭场景无价值）
 * - maxDepth: 'provider-managed' —— 深度上限交给提供方管理（不要求 depthLimit
 *   能力，任何提供方可挂载）
 */
export const fixedConfig = {
  subagentProvider: 'spawn',
  toolName: 'subagent_model',
  modelsToolName: 'subagent_models',
  recommendToolName: 'subagent_recommend',
  enableRunInBackground: true,
  backgroundMode: 'continuable',
  enableModelList: true,
  enableAuto: true,
  maxDepth: 'provider-managed',
} as const