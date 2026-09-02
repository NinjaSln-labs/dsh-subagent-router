/**
 * dsh-subagent-router — model-chosen subagent delegation for DeepSeek Harness.
 *
 * The shipped `subagent` tool inherits the parent's model route (or a static
 * `agentOptions` in the composition row). This plugin registers a sibling tool
 * (`subagent_model`, name configurable) that lets the delegating model pick the
 * child's LLM provider route, model id, and output cap per call:
 *
 *   - `provider`  — an LLM provider route registered on `ctx.llm` (hard-validated
 *                   against `ctx.llm.listProviders()`; omitted → inherit parent).
 *   - `model`     — any model id the chosen provider accepts (passed through:
 *                   the harness treats catalogs as advisory — the DeepSeek
 *                   adapter accepts arbitrary ids, pi-ai validates configured
 *                   ones — so the provider itself owns model rejection).
 *   - `max_tokens`— per-child output cap (positive integer).
 *   - `model: "auto"`— built-in auto selection: anchored to the calling
 *                   agent's own model by default (upgrades to the strongest
 *                   catalog model only when the task is heavy and the parent
 *                   model is not a strong one), records the decision with its
 *                   reason on the result, and retries once on the next tier
 *                   after a failed foreground run (`enableAuto` /
 *                   `autoEscalate`; escalation never downgrades).
 *                   Health-aware: an observed quota/auth failure marks the
 *                   route unhealthy, the auto policy then treats the parent
 *                   anchor as DEAD and reroutes to a healthy provider route
 *                   (`autoReroute`), and failed-run recovery reroutes on
 *                   terminal failures instead of blindly escalating on a
 *                   broken route. Failure details are classified and
 *                   sanitized into the tool result (rate-limit / quota /
 *                   auth / context / server / timeout / transport) instead of
 *                   a bare "subagent run failed".
 *
 * The child still runs through the ordinary `ctx.subagents` seam
 * (`resolveChildAgentOptions` merges per-child overrides over the parent's
 * route), so spawn/fork/in-process composition, depth accounting, delegation
 * policy, and continuable background children all behave exactly as they do
 * for the shipped tool. A companion read-only `subagent_models` tool lists the
 * live provider routes and their model catalogs so the model can make an
 * informed choice.
 *
 * 组合位置：host 平面（与 tool-subagent 相同 —— 它消费 host 的 `tools` /
 * `subagents` / `llm` 注册表，不发布服务，因此无需 isolate realm）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
// dsh-settings@>=0.1.2-alpha.4: module-level exports removed; the value import
// below also loaded its `Context.settings` type augmentation — keep a side-effect
// import so the module's `declare module` is still seen by the type system.
import '@deepseek-ai/dsh-settings'
import { registerModelPickerTools } from './tools.ts'
import { Config, fixedConfig } from './config.ts'
export { Config } from './config.ts'

/** Prompt order after bounded delegation policy and before child reporting. */
const SUBAGENT_SECTION_ORDER = 116.5

/** Per-tier auto selection mode. */
export type AutoTierPolicyMode = 'anchor' | 'cheapest' | 'strongest'

/** Per-tier auto selection configuration. */
export type AutoTierPolicy = Partial<Record<'trivial' | 'light' | 'standard' | 'complex', AutoTierPolicyMode>>

/**
 * Plugin config; every field optional with a sane default. Only LIVE fields
 * (re-read on every tool call) live here — registration-time knobs are fixed
 * module constants in `fixedConfig` (see config.ts), not configurable.
 */
export interface ModelPickerConfig {
  /** After a failed foreground run, retry once on the next auto tier (default true). */
  autoEscalate?: boolean
  /** Reroute to a healthy provider route when the auto-chosen route fails terminally (quota/auth) (default true). */
  autoReroute?: boolean
  /** Max escalation steps on the same provider after repeated transient failures (default 1 — matches the historical single-step escalation). */
  autoEscalationTiers?: number
  /** Provider priority order for `model: "auto"` provider resolution (default: registry order). Unlisted providers sort after listed ones. */
  autoProviderOrder?: string[]
  /** Per-tier selection mode; omitted tiers fall back to the built-in heuristic (trivial→cheapest, light→balanced, standard→strong, complex→strongest). */
  autoTierPolicy?: AutoTierPolicy
  /** Per-tier explicit candidate list, in priority order; when present, fully overrides the tier policy for that tier. */
  autoTierPicks?: Partial<Record<'trivial' | 'light' | 'standard' | 'complex', string[]>>
  /** Classifier timeout for `subagent_recommend`'s one-shot LLM call, in milliseconds (default 15000). Past it the tool degrades to the naming heuristic. */
  recommendTimeoutMs?: number
}

export const name = 'dsh-subagent-router'
export const inject = ['tools', 'subagents', 'systemPrompt']

export const defaultConfig = {
  autoEscalate: true,
  autoReroute: true,
  autoEscalationTiers: 1,
  autoProviderOrder: [] as string[],
  recommendTimeoutMs: 15000,
} as const satisfies Required<Pick<ModelPickerConfig, 'autoEscalate' | 'autoReroute' | 'autoEscalationTiers' | 'autoProviderOrder' | 'recommendTimeoutMs'>>

/** The fully resolved config after defaults: per-tier picks and policy stay optional. */
export type ResolvedModelPickerConfig =
  Required<Omit<ModelPickerConfig, 'autoTierPolicy' | 'autoTierPicks'>>
  & Pick<ModelPickerConfig, 'autoTierPolicy' | 'autoTierPicks'>

export function resolveConfig(config: ModelPickerConfig): ResolvedModelPickerConfig {
  return {
    autoEscalate: config.autoEscalate ?? defaultConfig.autoEscalate,
    autoReroute: config.autoReroute ?? defaultConfig.autoReroute,
    autoEscalationTiers: config.autoEscalationTiers ?? defaultConfig.autoEscalationTiers,
    autoProviderOrder: config.autoProviderOrder ?? defaultConfig.autoProviderOrder,
    autoTierPolicy: config.autoTierPolicy,
    autoTierPicks: config.autoTierPicks,
    recommendTimeoutMs: config.recommendTimeoutMs ?? defaultConfig.recommendTimeoutMs,
  }
}

export function apply(ctx: Context, config: ModelPickerConfig = {}): void {
  // ---- responsive config ----
  // The composition entry (cordis.patch.yml) is the base layer; when the
  // settings service mounts, `installSettingsSection` lets the user layer
  // (设置 → 插件配置) override it. `current` holds the latest authoritative
  // value and every consumer reads through `getResolved()` so a settings
  // write takes effect without re-registering tools.
  let resolved = resolveConfig(config)
  const getResolved = (): ResolvedModelPickerConfig => resolved
  // `setSource` hands us a thunk reading the live settings scope; `onChange`
  // fires on every committed settings write, so we re-resolve from that
  // thunk — this is what makes a 设置 → 插件配置 edit take effect live.
  // settings.installSection is wired through `ctx.inject(['settings'], …)`,
  // so it waits for the settings service to mount (and is inert when it never
  // does). dsh-settings@>=0.1.2-alpha.4 removed the module-level
  // installSettingsSection/settingsNamespace exports.
  let readScope: (() => ModelPickerConfig) | undefined
  ctx.inject(['settings'], (sctx) => {
    try {
      sctx.settings.installSection(ctx, 'subagent-router', Config, config, {
        setSource: (current) => {
          readScope = current
          resolved = resolveConfig(current())
        },
        onChange: () => {
          if (readScope !== undefined) resolved = resolveConfig(readScope())
        },
      })
    } catch (err) {
      ctx.logger.warn(
        `[dsh-subagent-router] settings section invalid — falling back to entry config: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  })
  // Registration-time knobs are fixed constants (see `fixedConfig` in
  // config.ts): the subagent provider, tool names, background mode
  // (continuable — matches the harness-native subagent semantics), feature
  // toggles, and the depth cap (provider-managed — no capability requirement).
  const backgroundEnabled = fixedConfig.enableRunInBackground
  const continuable = fixedConfig.backgroundMode === 'continuable'

  // Mirror provider lifecycle: sibling load order and HMR replacement can
  // change provider availability while this fiber stays active.
  let disposeTools: (() => void) | undefined
  const mount = (provider: SubagentProvider): void => {
    // Continuable is the fixed background mode; a provider without
    // `prepareContinuable` cannot host children at all — fail at mount (the
    // earliest point capabilities are known), not on delegation.
    if (continuable && provider.prepareContinuable === undefined) {
      throw new Error(
        `dsh-subagent-router: provider "${provider.name}" does not support `
        + 'the fixed `backgroundMode: continuable` (no prepareContinuable capability)',
      )
    }
    disposeTools = registerModelPickerTools(ctx, getResolved)
  }

  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === fixedConfig.subagentProvider && disposeTools === undefined) mount(provider)
  })
  ctx.on('subagent/provider-removed', (name) => {
    if (name !== fixedConfig.subagentProvider || disposeTools === undefined) return
    disposeTools()
    disposeTools = undefined
  })
  const present = ctx.subagents.getProvider(fixedConfig.subagentProvider)
  if (present !== undefined) {
    mount(present)
  } else {
    ctx.logger.info(
      `dsh-subagent-router: subagent provider "${fixedConfig.subagentProvider}" not registered yet; `
      + `the "${fixedConfig.toolName}" tool will register when it appears`,
    )
  }

  if (backgroundEnabled && continuable) {
    // The section follows provider availability without its own manual
    // lifecycle: empty text is omitted while the tool is absent.
    ctx.systemPrompt.section({
      name: `tool:${fixedConfig.toolName}`,
      order: SUBAGENT_SECTION_ORDER,
      text: context => disposeTools === undefined || ctx.tools.get(fixedConfig.toolName, context.scope) === undefined
        ? ''
        : `Use ${fixedConfig.toolName} in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set \`run_in_background: false\` only when your next action depends on that subagent's result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message.`,
    })
  }
}

export default {
  name,
  inject,
  Config,
  apply,
}
