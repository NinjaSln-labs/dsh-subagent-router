/**
 * dsh-subagent-router — model-facing tools.
 *
 * `subagent_model`: delegation with per-call provider / model / max_tokens.
 * Passing `model: "auto"` delegates model choice to the built-in auto policy:
 * it anchors to the calling agent's own model by default, upgrades to a
 * stronger catalog model only when the task is heavy and the parent model is
 * not a strong one, and records the decision with its reason on the result.
 * Foreground calls retry once on the next tier up after a failed run
 * (`autoEscalate`), never downgrading.
 * `subagent_models`: read-only catalog of live LLM provider routes and their
 * model listings (advisory; catalog membership never gates requests — it only
 * informs the delegating model).
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { settleRun } from '@deepseek-ai/dsh-subagent'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { ResolvedModelPickerConfig } from './index.ts'
import type { AutoTierPolicyMode } from './index.ts'
import { fixedConfig } from './config.ts'
import { classifyFailure, failureLabel, sanitizeFailureDetail, extractFailureEvidence, extractFailureEvidenceFromResult } from './failure.ts'
import type { FailureClass } from './failure.ts'
import { RouteHealthStore } from './health.ts'
import { modelMeta } from './meta.ts'
import { recommend, LruCache, RECOMMEND_CACHE_CAPACITY, ScopeStore } from './recommend.ts'
import type { RecommendationCore } from './recommend.ts'

/** Render text blocks from the canonical JSON block array without trusting arbitrary values. */
function outputValueText(values: JsonValue[]): string {
  return values
    .filter((value): value is { type: 'text'; text: string } =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && value.type === 'text' && typeof value.text === 'string')
    .map(value => value.text)
    .join('')
}

/** Settle pending startup without rejecting the task producer contract. */
async function settleStart(
  start: Promise<SubagentRun>,
  signal: AbortSignal,
  health: RouteHealthStore | undefined,
  provider: string,
): Promise<JobOutcome> {
  try {
    return await settleRun(await start)
  } catch (error: unknown) {
    if (signal.aborted) {
      return { status: 'killed' }
    }
    health?.record(provider, extractFailureEvidence(error))
    return { status: 'failed', detail: failureDetail(error) }
  }
}

/** Sanitized failure detail for a tool error, prefixed with the failure class. */
function failureDetail(error: unknown): string {
  const cls = classifyFailure(error)
  const label = cls === 'other' ? '' : `${failureLabel(cls)}: `
  const base = sanitizeFailureDetail(error)
  // LlmError carries provider facts (HTTP status / retry-after) that the
  // message alone omits — append them so a caller sees "429" rather than a
  // bare message.
  let facts = ''
  if (error instanceof LlmError) {
    const failure = (error as unknown as { failure?: { status?: number; providerRetryAfterMs?: number } }).failure
    if (failure?.status !== undefined) facts += ` (http ${failure.status})`
    if (failure?.providerRetryAfterMs !== undefined && Number.isFinite(failure.providerRetryAfterMs)) {
      facts += ` (retry-after ${Math.ceil(failure.providerRetryAfterMs / 1000)}s)`
    }
  }
  return `${label}${base}${facts}`
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/** Append the child's preserved partial answer to a stop-reason error. */
function withPartialText(error: string, output: ContentBlock[]): string {
  const text = output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}`
}

type ForegroundToolResult = {
  readonly kind: 'foreground'
  readonly runId: SubagentRun['id']
  readonly output: JsonValue[]
  readonly auto?: AutoDecision
}

/** One canonical delegation outcome the tool returns to the parent model. */
type DelegationToolResult =
  | { readonly kind: 'background'; readonly jobId: string; readonly auto?: AutoDecision }
  | { readonly kind: 'continuable'; readonly subagentId: string; readonly auto?: AutoDecision }
  | ForegroundToolResult

/** Built-in auto-selection tier for `model: "auto"`. */
type AutoTier = 'trivial' | 'light' | 'standard' | 'complex'

/** The audit record of one `model: "auto"` decision, returned to the caller. */
type AutoDecision = {
  readonly provider: string
  readonly model: string
  readonly tier: AutoTier
  readonly reason: string
  /** Set when the foreground run failed and the retry escalated tiers. */
  readonly escalatedFrom?: string
  /** Set when the choice stayed on the calling agent's own model. */
  readonly anchored?: boolean
  /** Set when the choice rerouted away from an unhealthy provider route. */
  readonly reroutedFrom?: string
  /** Why the reroute happened (audit context for the caller). */
  readonly rerouteReason?: string
}

/** A resolved auto selection plus its escalation ladder (one step per tier). */
type AutoSelection = {
  readonly decision: AutoDecision
  /** Ordered stronger models to try after a failed foreground run, one per tier. */
  readonly escalationPath: Array<{ readonly id: string; readonly tier: AutoTier; readonly reason: string }>
}

/** Task markers that push the auto tier toward `complex`. */
const COMPLEX_MARKERS = [
  /```|=>|#include|require\(/,
  /\b(function|class|interface|import|export|const|def)\s/,
  /\b(JSON|schema|structured|matrix|architecture|algorithm)\b/i,
  /\b(analy[sz]e|architect|design|optimize|debug|refactor|synthesi[sz]e|evaluate|investigate|research|derive|proof|implement|migrate|complex)\b/i,
]

/** Model-id signals for a strong / reasoning model. */
const STRONG_MODEL = /\b(pro|max|reason|think|ultra|code|turbo|large|deep)\b/i

/** Model-id signals for a cheap / fast model. */
const LIGHT_MODEL = /\b(flash|mini|lite|fast|small|quick|nano|light)\b/i

/**
 * 任务动词 → 复杂度档位字典。
 * 中英双语，提取 prompt 首句中的核心动词来判断任务复杂度。
 * 按优先级排序：complex 先匹配（避免"分析"被光标的"列"抢先）。
 */
const VERB_TIER_MAP: ReadonlyArray<{ verbs: readonly string[]; tier: AutoTier }> = [
  // complex：分析/设计/研究类
  { verbs: ['分析', '研究', '调研', '评估', '调查', '推导', '架构', '设计', '综合', '迁移', '集成', '验证'], tier: 'complex' },
  { verbs: ['analyze', 'analyse', 'research', 'investigate', 'design', 'evaluate', 'synthesize', 'derive', 'architect', 'migrate', 'integrate', 'validate', 'explain', 'explore'], tier: 'complex' },
  // standard：实现/重构/开发类
  { verbs: ['实现', '重构', '优化', '调试', '编写', '修改', '构建', '开发', '测试', '配置', '部署'], tier: 'standard' },
  { verbs: ['implement', 'refactor', 'optimize', 'debug', 'write', 'modify', 'build', 'develop', 'test', 'configure', 'deploy'], tier: 'standard' },
  // light：简单操作
  { verbs: ['总结', '翻译', '创建', '更新', '添加', '删除', '复制', '移动', '重命名', '转换', '提取', '生成'], tier: 'light' },
  { verbs: ['summarize', 'summarise', 'translate', 'create', 'update', 'add', 'delete', 'copy', 'move', 'rename', 'convert', 'extract', 'generate'], tier: 'light' },
  // trivial：查询/查看类
  { verbs: ['查看', '列出', '显示', '搜索', '检查', '读取', '寻找', '查询', '浏览', '打开'], tier: 'trivial' },
  { verbs: ['列', '查', '找', '看'], tier: 'trivial' }, // 单字动词（仅匹配开头/礼貌前缀后，防误配复合词）
  { verbs: ['list', 'show', 'find', 'check', 'read', 'search', 'look', 'browse', 'open', 'view', 'ls', 'cat', 'grep'], tier: 'trivial' },
]

/**
 * 中文单字动词的已知复合词前缀。
 * 当单字动词前是这些字时，该字属于复合词的一部分而非独立动词。
 * 如"序列"中"列"不是独立动词 → 不匹配；"请列一下"中"列"是独立动词 → 匹配。
 */
const COMPOUND_PREFIX: Record<string, string> = { '列': '序列排陈罗', '查': '调查检审普', '找': '寻找', '看': '查看' }

/**
 * 从 prompt 文本中提取核心动词并返回对应档位。
 * 匹配策略：按字典序依次匹配，先匹配到的动词的档位为结果。
 * 匹配范围：prompt 首句（前 200 字符，按标点截断）。
 * 中文单字动词（"列""查""找""看"）仅匹配开头 8 字符内，且排除已知复合词前缀。
 */
function extractVerbTier(text: string): AutoTier | undefined {
  // 取首句：按句号/问号/感叹号/换行截断，取前 200 字符
  const sentenceEnd = text.search(/[。？！\n!?.]\s|$/)
  const head = text.slice(0, sentenceEnd >= 0 && sentenceEnd <= 200 ? sentenceEnd + 1 : 200).toLowerCase()
  for (const entry of VERB_TIER_MAP) {
    for (const verb of entry.verbs) {
      // 中文单字动词：排除已知复合词前缀，其余情况匹配
      if (verb.length === 1 && /[\u4e00-\u9fff]/.test(verb)) {
        const wideStart = head.slice(0, 8)
        const idx = wideStart.indexOf(verb)
        if (idx >= 0) {
          if (idx === 0) return entry.tier // 开头直接匹配
          const prevChar = wideStart[idx - 1]
          const badPrefixes = COMPOUND_PREFIX[verb] || ''
          if (!badPrefixes.includes(prevChar)) return entry.tier
        }
      } else if (head.includes(verb.toLowerCase())) {
        return entry.tier
      }
    }
  }
  return undefined
}

/** Classify a delegation task into the auto-selection tier. */
function classifyTier(description: string, prompt: string): AutoTier {
  const task = `${description}\n${prompt}`

  // 1. Length-based complex fast path: enough text to be complex regardless of content
  if (task.length >= 1200) return 'complex'

  // 2. Code/structured markers → complex (language-agnostic)
  if (COMPLEX_MARKERS.some(marker => marker.test(task))) return 'complex'

  // 3. Verb extraction from prompt (more reliable) and description (fallback)
  const verbTier = extractVerbTier(prompt) ?? extractVerbTier(description)
  if (verbTier !== undefined) return verbTier

  // 4. Fallback: length-based heuristic (4 tiers instead of 3)
  if (task.length <= 160) return 'trivial'
  if (task.length <= 400) return 'light'
  return 'standard'
}

/** One-line justification of a tier for the audit reason. */
function tierNote(tier: AutoTier): string {
  switch (tier) {
    case 'trivial':
      return 'short task without heavy markers'
    case 'light':
      return 'light task with simple operations'
    case 'complex':
      return 'long task or heavy markers (code / structured output / reasoning verbs)'
    case 'standard':
      return 'ordinary task length and content'
  }
}

/** Naming-based strength score: +1 strong signals, -1 cheap signals, -1 free-tier penalty. */
function modelScore(id: string): number {
  let score = 0
  if (STRONG_MODEL.test(id)) score += 1
  if (LIGHT_MODEL.test(id)) score -= 1
  // Free-tier model names carry a quota risk; auto policy should prefer the
  // paid version when both are available. The penalty is small enough that
  // a free-tier model is still chosen when it is the only option.
  if (/\b-free\b/i.test(id)) score -= 1
  return score
}

/** Pick the catalog model best matching a tier (ties keep catalog order). */
function pickModel(models: readonly { id: string }[], tier: AutoTier): { id: string; score: number } | undefined {
  if (models.length === 0) return undefined
  const scored = models.map(model => ({ id: model.id, score: modelScore(model.id) }))
  switch (tier) {
    case 'trivial': {
      const min = Math.min(...scored.map(entry => entry.score))
      return scored.find(entry => entry.score === min)
    }
    case 'light': {
      // Balanced: prefer score === 0 (flash/nano), fall back to the highest
      // score so a -free penalty does not push the free model to the front.
      const balanced = scored.find(entry => entry.score === 0)
      if (balanced !== undefined) return balanced
      const max = Math.max(...scored.map(entry => entry.score))
      return scored.find(entry => entry.score === max)
    }
    case 'standard': {
      // Strong: prefer score >= 1 (pro/code), fall back to the highest score.
      const strong = scored.find(entry => entry.score >= 1)
      if (strong !== undefined) return strong
      const max = Math.max(...scored.map(entry => entry.score))
      return scored.find(entry => entry.score === max)
    }
    case 'complex': {
      const max = Math.max(...scored.map(entry => entry.score))
      return scored.find(entry => entry.score === max)
    }
  }
}

/** Pick a catalog model by an explicit non-anchor policy mode. */
function pickByMode(
  models: readonly { id: string }[],
  mode: 'cheapest' | 'strongest',
): { id: string; score: number } | undefined {
  return mode === 'cheapest'
    ? pickModel(models, 'trivial')
    : pickModel(models, 'complex')
}

/** Pick the first model from an ordered candidate list that the catalog carries. */
function pickFromOrdered(
  models: readonly { id: string }[],
  candidates: readonly string[],
): { id: string; score: number } | undefined {
  const catalog = new Set(models.map(model => model.id))
  for (const id of candidates) {
    if (catalog.has(id)) return { id, score: modelScore(id) }
  }
  return undefined
}

/**
 * Pick the first ordered candidate that any healthy provider advertises, in
 * provider priority order (configured order first, then registry order).
 * Returns the model id and the provider that carries it. `skip` names a
 * provider to exclude (the one already tried).
 */
async function pickFromOrderedAcrossProviders(
  llm: { listModels(provider: string): Promise<Array<{ id: string; name: string }>> },
  routes: readonly { id: string }[],
  health: RouteHealthStore,
  config: ResolvedModelPickerConfig,
  candidates: readonly string[],
  skip?: string,
): Promise<{ model: string; provider: string } | undefined> {
  const order = [
    ...(config.autoProviderOrder ?? []),
    ...routes.map(route => route.id),
  ]
  const deduped = order.filter((id, index) => order.indexOf(id) === index)
  for (const providerId of deduped) {
    if (providerId === skip || !health.isHealthy(providerId)) continue
    let models: Array<{ id: string; name: string }>
    try {
      models = await llm.listModels(providerId)
    } catch {
      continue // provider unusable right now — try the next one
    }
    const pick = pickFromOrdered(models, candidates)
    if (pick !== undefined) return { model: pick.id, provider: providerId }
  }
  return undefined
}

/** One-tier escalation ladder; the top tier has no next tier. */
const NEXT_TIER: Record<AutoTier, AutoTier | undefined> = {
  trivial: 'light',
  light: 'standard',
  standard: 'complex',
  complex: undefined,
}

/** Append the audit line for an auto decision to a tool render. */
function autoRender(auto: AutoDecision | undefined): string {
  if (auto === undefined) return ''
  const anchor = auto.anchored === true ? ' anchored' : ''
  const escalation = auto.escalatedFrom === undefined ? '' : ` (escalated from ${auto.escalatedFrom})`
  const reroute = auto.reroutedFrom === undefined ? '' : ` (rerouted from ${auto.reroutedFrom}: ${auto.rerouteReason ?? 'unhealthy route'})`
  return `\n[auto] provider=${auto.provider} model=${auto.model} tier=${auto.tier}${anchor}${escalation}${reroute}\nreason: ${auto.reason}`
}

/** Output-schema fragment for the auditable auto decision. */
const AUTO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string', required: true },
    model: { type: 'string', required: true },
    tier: { type: 'string', required: true },
    reason: { type: 'string', required: true },
    escalatedFrom: { type: 'string' },
    anchored: { type: 'boolean' },
    reroutedFrom: { type: 'string' },
    rerouteReason: { type: 'string' },
  },
} as const

/**
 * Resolve `model: "auto"` against the provider catalog. The provider is the
 * explicit argument, else the calling agent's own route (`parent.options`).
 *
 * The choice is ANCHORED to the calling agent by default: when the parent's
 * options name a model on the resolved provider, that model is used as-is
 * unless the task classifies `complex` and the parent's model is not a strong
 * one (then the strongest catalog model is picked). Only when no parent model
 * is available does the policy fall back to catalog tier picks. Escalation
 * never downgrades: the next tier is used only when it scores strictly
 * stronger than the current choice.
 *
 * Health-aware: a parent route the health store has marked unhealthy (quota
 * exhausted, credentials broken, or a recent transient burst) is a DEAD
 * anchor — pinning children to it would just fail again. When the resolved
 * provider is unhealthy, the policy drops the anchor, picks a healthy provider
 * from the catalog (preferring one with a model matching the tier), and marks
 * the decision with `reroutedFrom` so the caller sees the route change.
 *
 * Catalog membership is advisory, so the resolved id is only a pick: the
 * provider still owns rejection, exactly as with an explicit model.
 */
async function resolveAutoSelection(
  ctx: Context,
  args: { readonly provider?: string; readonly description: string; readonly prompt: string },
  parentProvider: string | undefined,
  parentModel: string | undefined,
  toolName: string,
  health: RouteHealthStore,
  config: ResolvedModelPickerConfig,
): Promise<AutoSelection> {
  const llm = ctx.get('llm')
  if (llm === undefined) {
    throw new Error(`${toolName}: model "auto" requires the llm service (no ctx.llm registered)`)
  }
  const routes = llm.listProviders()
  const routeIds = new Set(routes.map(route => route.id))

  // ---- provider resolution ----
  // Priority: explicit `provider` arg > parent route > configured provider
  // order (first healthy, in-catalog) > registry order (first healthy).
  // Unhealthy routes are skipped everywhere: a dead anchor must not win.
  const explicitProvider = args.provider
  if (explicitProvider !== undefined && !routeIds.has(explicitProvider)) {
    const known = routes.map(route => route.id).join(', ')
    throw new Error(
      `${toolName}: model "auto": unknown provider "${explicitProvider}" — registered provider routes: ${known || '(none)'}`,
    )
  }
  const tier = classifyTier(args.description, args.prompt)
  // The anchor is the parent's own model, valid only on the parent's own
  // provider — an explicit `provider` argument switches groups, so the
  // parent's model no longer belongs there.
  const anchorCandidate = parentModel !== undefined && parentModel.length > 0
    ? parentModel
    : undefined

  // Resolve the working provider (possibly rerouted away from an unhealthy
  // anchor). `explicit` overrides the parent's route; otherwise the parent's
  // route is the anchor group, falling back to config order / registry order.
  let effectiveProvider: string
  let reroute: { from: string; reason: string } | undefined

  const pickFirstHealthy = (ids: readonly string[]): string | undefined =>
    ids.find(id => routeIds.has(id) && health.isHealthy(id))

  /** One-line reason for a route being unhealthy, for the reroute audit note. */
  const unhealthyReason = (provider: string): string =>
    `route unhealthy (${failureLabel(health.health(provider).failingClass ?? 'other')})`

  if (explicitProvider !== undefined) {
    if (!health.isHealthy(explicitProvider)) {
      // Explicit provider is unhealthy — reroute to the next healthy option.
      const alternative = pickFirstHealthy([
        ...(config.autoProviderOrder ?? []),
        ...routes.map(route => route.id).filter(id => id !== explicitProvider),
      ])
      if (alternative !== undefined) {
        effectiveProvider = alternative
        reroute = { from: explicitProvider, reason: unhealthyReason(explicitProvider) }
      } else {
        effectiveProvider = explicitProvider
      }
    } else {
      effectiveProvider = explicitProvider
    }
  } else {
    // No explicit provider: parent route, else configured order, else registry.
    if (parentProvider !== undefined && routeIds.has(parentProvider) && health.isHealthy(parentProvider)) {
      effectiveProvider = parentProvider
    } else {
      const configuredOrder = config.autoProviderOrder ?? []
      if (configuredOrder.length > 0) {
        // The user expressed a provider priority — use its first healthy option.
        const deduped = configuredOrder.filter((id, index) => configuredOrder.indexOf(id) === index)
        const chosen = pickFirstHealthy(deduped)
        if (chosen !== undefined) {
          effectiveProvider = chosen
          if (parentProvider !== undefined && parentProvider !== chosen) {
            reroute = { from: parentProvider, reason: `${unhealthyReason(parentProvider)} or not preferred` }
          }
        } else {
          // Configured order has no healthy route — fall back to the parent
          // route (or the first registered) so the provider itself surfaces
          // the error.
          effectiveProvider = parentProvider !== undefined && routeIds.has(parentProvider)
            ? parentProvider
            : configuredOrder.find(id => routeIds.has(id)) ?? routes[0]?.id
          if (effectiveProvider === undefined) {
            throw new Error(
              `${toolName}: model "auto" needs a provider route — pass "provider" explicitly, or call from an agent `
              + 'whose options name one (parent.options.provider)',
            )
          }
        }
      } else {
        // No configured order and no parent route — the caller must say which
        // provider to use (matches the historical contract).
        if (parentProvider === undefined) {
          throw new Error(
            `${toolName}: model "auto" needs a provider route — pass "provider" explicitly, or call from an agent `
            + 'whose options name one (parent.options.provider)',
          )
        }
        // Parent route exists but is unhealthy or unknown: fall back to the
        // first registered healthy route.
        const fallback = routes.map(route => route.id).find(id => health.isHealthy(id))
        if (fallback !== undefined) {
          effectiveProvider = fallback
          reroute = { from: parentProvider, reason: unhealthyReason(parentProvider) }
        } else {
          effectiveProvider = parentProvider
        }
      }
    }
  }

  // ---- model selection across the effective provider ----
  let models: Array<{ id: string; name: string }>
  try {
    models = await llm.listModels(effectiveProvider)
  } catch (cause) {
    throw new Error(`${toolName}: model "auto" could not list models for provider "${effectiveProvider}": ${String(cause)}`)
  }

  // Model-level anchor: the parent model id may exist on the effective
  // provider even though the parent's own provider differs (e.g. parent on
  // "cline-pass" but the model "deepseek-v4-flash" is also available on
  // "teamorouter"). When the model id is present, we can anchor to it
  // regardless of the provider mismatch — this is stronger than falling
  // through to the tier heuristic.
  const modelOnProvider = anchorCandidate !== undefined
    && models.some(m => m.id === anchorCandidate)

  // The anchor is only usable when it sits on the effective (possibly
  // rerouted) provider AND that provider is healthy. An explicit `provider`
  // that differs from the parent's route drops the anchor (the parent's model
  // no longer belongs to that group).
  const anchorUsable = anchorCandidate !== undefined
    && parentProvider !== undefined
    && parentProvider === effectiveProvider
    && health.isHealthy(effectiveProvider)
  const effectiveAnchor = anchorUsable ? anchorCandidate : undefined
  const effectiveAnchorScore = effectiveAnchor === undefined ? undefined : modelScore(effectiveAnchor)

  let pick: { id: string; score: number } | undefined
  let anchored = false
  let policyUsed = 'heuristic'

  // Layer 1: explicit per-tier candidate list (fully overrides). The list is
  // a GLOBAL model priority resolved in provider-priority order
  // (`autoProviderOrder` first, then registry order): the first candidate any
  // healthy provider advertises wins, so a pick may land on a different
  // provider than the one resolved above.
  const tierPicks = config.autoTierPicks?.[tier]
  if (tierPicks !== undefined && tierPicks.length > 0) {
    const across = await pickFromOrderedAcrossProviders(llm, routes, health, config, tierPicks)
    if (across !== undefined) {
      pick = { id: across.model, score: modelScore(across.model) }
      const previousProvider = effectiveProvider
      effectiveProvider = across.provider
      policyUsed = 'picks'
      if (reroute === undefined && previousProvider !== across.provider) {
        reroute = {
          from: previousProvider,
          reason: `autoTierPicks placed "${across.model}" on provider "${across.provider}" (provider order)`,
        }
      }
      if (previousProvider !== across.provider) {
        try {
          models = await llm.listModels(across.provider)
        } catch {
          // The pick is already resolved; with no fresh catalog, the
          // escalation ladder below has nothing to climb (empty models).
          models = []
        }
      }
    }
    // No healthy provider advertises any candidate: fall through to the next layer.
  }
  if (pick === undefined) {
    // Layer 2: per-tier policy mode.
    const mode = config.autoTierPolicy?.[tier]
    if (mode !== undefined) {
      if (mode === 'anchor' && effectiveAnchor !== undefined) {
        pick = { id: effectiveAnchor, score: effectiveAnchorScore! }
        anchored = true
        policyUsed = 'anchor'
      } else if (mode === 'cheapest' || mode === 'strongest') {
        pick = pickByMode(models, mode)
        policyUsed = mode
      } else {
        // 'anchor' with no usable anchor → fall through to heuristic.
        pick = undefined
        policyUsed = 'heuristic'
      }
    }
  }
  if (pick === undefined) {
    // Layer 3: built-in heuristic (anchor first, then tier pick), preserving
    // the historical behavior.
    policyUsed = 'heuristic'
    if (effectiveAnchor !== undefined && (tier !== 'complex' || effectiveAnchorScore! >= 1)) {
      pick = { id: effectiveAnchor, score: effectiveAnchorScore! }
      anchored = true
    } else if (modelOnProvider && (tier !== 'complex' || modelScore(anchorCandidate!) >= 1)) {
      // Model-level anchor: the parent model id exists on the effective
      // provider even though the parent's own provider differs. This is
      // stronger than the tier heuristic — it preserves the parent's model
      // choice across provider boundaries.
      pick = { id: anchorCandidate!, score: modelScore(anchorCandidate!) }
      anchored = true
    } else {
      pick = pickModel(models, tier)
    }
  }
  if (pick === undefined) {
    throw new Error(`${toolName}: model "auto": provider "${effectiveProvider}" advertises no models`)
  }

  const rerouteNote = reroute === undefined
    ? ''
    : `; rerouted from "${reroute.from}" because its route is unhealthy (${reroute.reason})`
  const reason = anchored
    ? `auto policy: task classified "${tier}" (${tierNote(tier)}); policy=${policyUsed}; defaulted to the parent's own model "${pick.id}" on provider "${effectiveProvider}"${rerouteNote}`
    : effectiveAnchor !== undefined
      ? `auto policy: task classified "${tier}" (${tierNote(tier)}); policy=${policyUsed}; upgraded from the parent's model "${effectiveAnchor}" to "${pick.id}" on provider "${effectiveProvider}"${rerouteNote}`
      : reroute !== undefined
        ? `auto policy: task classified "${tier}" (${tierNote(tier)}); policy=${policyUsed}; rerouted from "${reroute.from}" (${reroute.reason}) to "${pick.id}" on provider "${effectiveProvider}"`
        : `auto policy: task classified "${tier}" (${tierNote(tier)}); policy=${policyUsed}; picked "${pick.id}" from provider "${effectiveProvider}"`
  const decision: AutoDecision = {
    provider: effectiveProvider,
    model: pick.id,
    tier,
    reason,
    ...anchored ? { anchored: true } : {},
    ...reroute !== undefined ? { reroutedFrom: reroute.from, rerouteReason: reroute.reason } : {},
  }
  // Build the escalation ladder: walk the tier chain (trivial → standard →
  // complex), keeping only steps that pick a strictly stronger model than the
  // current choice. Each step's model may repeat if the catalog has no
  // stronger pick at that tier, so we also require a strictly stronger model
  // than the previous step.
  const ladder: Array<{ id: string; tier: AutoTier; reason: string }> = []
  {
    let currentTier = tier
    let currentPick = pick.id
    let currentScore = pick.score
    while (true) {
      const nextTier = NEXT_TIER[currentTier]
      if (nextTier === undefined) break
      const nextPick = pickModel(models, nextTier)
      if (nextPick !== undefined && nextPick.id !== currentPick && nextPick.score > currentScore) {
        ladder.push({
          id: nextPick.id,
          tier: nextTier,
          reason: `auto escalation: retry on "${nextPick.id}" (${nextTier} tier) after a failed foreground run`,
        })
        currentTier = nextTier
        currentPick = nextPick.id
        currentScore = nextPick.score
      } else {
        // No strictly stronger model at this tier — stop climbing (never
        // downgrade).
        break
      }
    }
  }
  const escalationPath = ladder
  return { decision, escalationPath }
}

/** Collect and release one foreground run without letting disposal replace an independent result failure. */
async function settleForegroundRun(
  run: SubagentRun,
  health: RouteHealthStore | undefined,
  provider: string,
): Promise<ForegroundToolResult> {
  const [execution] = await Promise.allSettled([
    run.result.then((result): ForegroundToolResult => {
      const error = stopReasonError(result)
      if (error !== undefined) {
        // The seam compresses model/transport failure into `stopReason: 'error'`
        // without a cause. The `diagnostic` field may still carry the raw
        // business error (e.g. a 402 quota-exhausted message); classify it from
        // that text so a quota failure triggers autoReroute instead of a
        // transient 'other' that expires in 5 minutes.
        const evidence = extractFailureEvidenceFromResult(result.diagnostic, result.output)
        // The execution.rejected block below also calls health.record with
        // extractFailureEvidence(execution.reason). To make that call find the
        // correct classification, embed the evidence class as a code the
        // failure classifier can route on.
        const cause: Record<string, unknown> = { ...evidence }
        if (evidence.cls === 'quota') cause.code = 'QUOTA'
        else if (evidence.cls === 'auth') cause.code = 'AUTH'
        health?.record(provider, evidence)
        throw new Error(withPartialText(error, result.output), { cause })
      }
      return {
        kind: 'foreground',
        runId: run.id,
        output: result.output as unknown as JsonValue[],
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    // The run.result rejection carries the infrastructure cause — record the
    // failure class and surface the sanitized detail to the caller. Preserve
    // the cause so the caller can still classify and route on it.
    health?.record(provider, extractFailureEvidence(execution.reason))
    const detail = failureDetail(execution.reason)
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${detail}; dispose failed: ${sanitizeFailureDetail(disposal.reason)}`,
      )
    }
    throw new Error(`subagent run failed: ${detail}`, { cause: execution.reason })
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/** Resolve the model's optional scheduling request into one execution route. */
function resolveDelegationRun(
  request: { readonly run_in_background?: boolean },
  options: { readonly backgroundEnabled: boolean; readonly continuable: boolean },
): { readonly runInBackground: boolean } {
  if (!options.backgroundEnabled) {
    // The schema permits undeclared keys, so omission also needs execution-time enforcement.
    if (request.run_in_background === true) {
      throw new Error('run_in_background is disabled for this tool instance (enableRunInBackground: false)')
    }
    return { runInBackground: false }
  }
  return {
    runInBackground: request.run_in_background ?? options.continuable,
  }
}

/**
 * Reroute a failed auto run to a healthy provider route. Picks the first
 * healthy provider other than the failed one, resolves a model on it (honoring
 * the user's `autoTierPicks` / `autoTierPolicy` config when present), restarts
 * the child there via the `start` thunk, and returns the settled result with
 * an updated audit decision.
 *
 * Returns `undefined` only when no healthy alternative provider exists (the
 * caller then reports the original failure). Any failure during the reroute
 * itself (listModels / start / settle) THROWS with the reroute reason, so the
 * caller sees why the recovery attempt failed instead of a silent fallback.
 */
async function rerouteToHealthy(
  ctx: Context,
  config: ResolvedModelPickerConfig,
  start: (agentOptions: Record<string, unknown>) => Promise<SubagentRun>,
  autoSelection: AutoSelection,
  signal: AbortSignal,
  health: RouteHealthStore,
  failureCls: FailureClass,
): Promise<ForegroundToolResult | undefined> {
  if (signal.aborted) throw new Error('subagent reroute aborted before starting')
  const llm = ctx.get('llm')
  if (llm === undefined) {
    throw new Error('subagent reroute skipped: llm service unavailable')
  }
  const failedProvider = autoSelection.decision.provider
  const routes = llm.listProviders()
  const candidate = routes.find(route => route.id !== failedProvider && health.isHealthy(route.id))
  if (candidate === undefined) {
    // No healthy alternative — the caller reports the original failure.
    return undefined
  }
  let models: Array<{ id: string; name: string }>
  try {
    models = await llm.listModels(candidate.id)
  } catch (cause) {
    throw new Error(
      `subagent reroute could not list models for provider "${candidate.id}": ${sanitizeFailureDetail(cause)}`,
      { cause },
    )
  }
  // Honor the user's routing config on the rerouted provider: explicit
  // per-tier picks first, then the per-tier policy mode, else the tier pick.
  const tier = autoSelection.decision.tier
  let pick: { id: string; score: number } | undefined
  const tierPicks = config.autoTierPicks?.[tier]
  if (tierPicks !== undefined && tierPicks.length > 0) {
    pick = pickFromOrdered(models, tierPicks)
  }
  if (pick === undefined) {
    const mode = config.autoTierPolicy?.[tier]
    if (mode === 'cheapest' || mode === 'strongest') {
      pick = pickByMode(models, mode)
    }
  }
  if (pick === undefined) {
    pick = pickModel(models, tier)
  }
  if (pick === undefined) {
    throw new Error(`subagent reroute: provider "${candidate.id}" advertises no models for tier "${tier}"`)
  }
  let retry: SubagentRun
  try {
    retry = await start({ provider: candidate.id, model: pick.id })
  } catch (cause) {
    if (signal.aborted) throw cause
    throw new Error(
      `subagent reroute to "${candidate.id}/${pick.id}" could not start: ${sanitizeFailureDetail(cause)}`,
      { cause },
    )
  }
  try {
    const settled = await settleForegroundRun(retry, health, candidate.id)
    const rerouteReason = `route ${failedProvider} failed (${failureLabel(failureCls)}); rerouted to healthy provider`
    return {
      ...settled,
      auto: {
        ...autoSelection.decision,
        provider: candidate.id,
        model: pick.id,
        reroutedFrom: failedProvider,
        rerouteReason,
        reason: `${autoSelection.decision.reason} → ${rerouteReason}`,
      },
    }
  } catch (cause) {
    if (signal.aborted) throw cause
    throw new Error(
      `subagent reroute to "${candidate.id}/${pick.id}" failed: ${sanitizeFailureDetail(cause)}`,
      { cause },
    )
  }
}

/** Build the aggregate error for a failed delegation, listing every attempt. */
function buildFailureAggregate(
  toolName: string,
  failures: readonly unknown[],
  attemptLabels: readonly { model: string; provider: string; detail: string }[],
): AggregateError {
  return new AggregateError(
    failures,
    `${toolName}: subagent run failed after ${attemptLabels.length} attempt(s): ${attemptLabels.map((a, i) => `attempt ${i + 1} on "${a.model}" (${a.provider}): ${a.detail}`).join('; ')}`,
  )
}

/**
 * Run a foreground delegation once with auto-recovery. The `start` thunk is
 * re-invocable, so both a start rejection AND a run failure enter the same
 * recovery flow:
 *
 *   - terminal failure class (quota / auth): retrying the same provider is
 *     pointless — reroute to a healthy provider route and restart there
 *     (only when autoReroute is enabled).
 *   - transient class (rate-limit / server / timeout / transport / other):
 *     retry on the next auto tier (same provider, stronger model), bounded by
 *     `autoEscalationTiers` — the original single-step `autoEscalate`
 *     behavior, now parameterized.
 *   - every failed attempt is recorded in the health store so the NEXT auto
 *     decision sees the route as (temporarily) unhealthy.
 */
async function runForegroundWithRecovery(
  ctx: Context,
  config: ResolvedModelPickerConfig,
  start: (agentOptions: Record<string, unknown>) => Promise<SubagentRun>,
  autoSelection: AutoSelection | undefined,
  initialAgentOptions: Record<string, unknown>,
  signal: AbortSignal,
  health: RouteHealthStore,
): Promise<ForegroundToolResult & { auto?: AutoDecision }> {
  const failures: unknown[] = []
  const attemptLabels: Array<{ model: string; provider: string; detail: string }> = []
  const labelFor = (options: Record<string, unknown>): { model: string; provider: string } => ({
    model: String(options.model ?? autoSelection?.decision.model ?? '(inherited)'),
    provider: String(options.provider ?? autoSelection?.decision.provider ?? fixedConfig.subagentProvider),
  })
  const recordAttempt = (options: Record<string, unknown>, error: unknown): void => {
    failures.push(error)
    attemptLabels.push({ ...labelFor(options), detail: failureDetail(error) })
  }

  let run: SubagentRun
  try {
    run = await start(initialAgentOptions)
  } catch (firstError) {
    if (signal.aborted) throw firstError
    const cls = classifyFailure(firstError)
    recordAttempt(initialAgentOptions, firstError)
    health.record(labelFor(initialAgentOptions).provider, extractFailureEvidence(firstError))
    // Terminal class → reroute to a healthy provider route. A reroute failure
    // throws (it is NOT a silent fallback) — surface it with the original.
    if (autoSelection !== undefined && config.autoReroute && (cls === 'quota' || cls === 'auth')) {
      try {
        const rerouted = await rerouteToHealthy(ctx, config, start, autoSelection, signal, health, cls)
        if (rerouted !== undefined) return rerouted
      } catch (rerouteError) {
        if (signal.aborted) throw rerouteError
        failures.push(rerouteError)
        attemptLabels.push({
          model: `reroute`,
          provider: labelFor(initialAgentOptions).provider,
          detail: failureDetail(rerouteError),
        })
      }
    }
    throw buildFailureAggregate(fixedConfig.toolName, failures, attemptLabels)
  }

  try {
    return await settleForegroundRun(run, health, labelFor(initialAgentOptions).provider)
  } catch (firstError) {
    if (signal.aborted) throw firstError
    const cls = classifyFailure(firstError)
    recordAttempt(initialAgentOptions, firstError)
    // Terminal class → reroute to a healthy provider route. A reroute failure
    // throws (it is NOT a silent fallback) — surface it with the original.
    if (autoSelection !== undefined && config.autoReroute && (cls === 'quota' || cls === 'auth')) {
      try {
        const rerouted = await rerouteToHealthy(ctx, config, start, autoSelection, signal, health, cls)
        if (rerouted !== undefined) return rerouted
      } catch (rerouteError) {
        if (signal.aborted) throw rerouteError
        failures.push(rerouteError)
        attemptLabels.push({
          model: 'reroute',
          provider: labelFor(initialAgentOptions).provider,
          detail: failureDetail(rerouteError),
        })
      }
    }
    // Transient class → escalate along the ladder on the same provider (bounded).
    if (autoSelection !== undefined && config.autoEscalate && autoSelection.escalationPath.length > 0) {
      const path = autoSelection.escalationPath
      const maxAttempts = Math.min(config.autoEscalationTiers, path.length)
      let currentDecision = autoSelection.decision
      let attempts = 0
      while (attempts < maxAttempts) {
        const step = path[attempts]!
        attempts += 1
        const options: Record<string, unknown> = { ...initialAgentOptions, model: step.id }
        try {
          const retry = await start(options)
          const settled = await settleForegroundRun(retry, health, currentDecision.provider)
          return {
            ...settled,
            auto: {
              ...currentDecision,
              model: step.id,
              tier: step.tier,
              escalatedFrom: currentDecision.model,
            },
          }
        } catch (retryError) {
          if (signal.aborted) throw retryError
          recordAttempt(options, retryError)
          const retryCls = classifyFailure(retryError)
          if (retryCls === 'quota' || retryCls === 'auth') {
            // The escalated model hit a terminal failure too — stop
            // escalating on this provider.
            break
          }
          currentDecision = { ...currentDecision, model: step.id, tier: step.tier }
        }
      }
    }
    throw buildFailureAggregate(fixedConfig.toolName, failures, attemptLabels)
  }
}

/**
 * Register the model-facing tools into `ctx.tools`. Returns the disposer that
 * unregisters both, owned by the caller's fiber.
 */
export function registerModelPickerTools(
  ctx: Context,
  getConfig: () => ResolvedModelPickerConfig,
): () => void {
  // Registration-time knobs are fixed module constants (`fixedConfig` in
  // config.ts): tool names, background semantics (continuable by default,
  // matching the harness-native subagent tool), and feature toggles. Live
  // decisions read `getConfig()` on every call so a settings write
  // (设置 → 插件配置) takes effect without re-registering.
  const backgroundEnabled = fixedConfig.enableRunInBackground
  const continuable = fixedConfig.backgroundMode === 'continuable'
  const maxDepth = typeof fixedConfig.maxDepth === 'number' ? fixedConfig.maxDepth : undefined
  const enableAuto = fixedConfig.enableAuto
  const health = new RouteHealthStore()
  const recommendCache = new LruCache<string, RecommendationCore>(RECOMMEND_CACHE_CAPACITY)
  const scopeStore = new ScopeStore()
  const disposers: Array<() => void> = []

  // The selection scope is derived from the live catalog; invalidate it whenever
  // the provider topology changes so the next recommendation recomputes it.
  disposers.push(ctx.on('llm/adapters-updated', () => scopeStore.invalidate()))

  // Record the parent agent's own model-request failures into the health store
  // so the auto policy sees a dead anchor even when the parent's route goes
  // unhealthy (quota, auth, rate-limit, etc.). This is a waterfall event: we
  // must call next() and return its result so the retry policy is not blocked.
  // ⚠️ If scoped propagation prevents ctx.on from receiving this event,
  // switch to ctx.any() or ctx.root.on().
  disposers.push(ctx.on('agent/request-error', async (payload, next) => {
    health.record(payload.provider, extractFailureEvidence(payload.failure))
    // In the real agent-loop, next() is always provided by the emitter.
    // Guard against undefined for unit-test environments where ctx.emit
    // may not supply the waterfall chain.
    if (typeof next === 'function') return next()
  }))

  disposers.push(ctx.tools.register(defineTool({
    name: fixedConfig.toolName,
    description: 'Delegate a self-contained task to a subagent (a separate agent that works in its own '
      + 'context) and choose the LLM route the child runs on. Unlike the plain subagent tool, the child '
      + 'does not have to inherit this agent\'s model: pass `provider` (an LLM provider route) and `model` '
      + '(a model id that provider accepts) to run the child on any registered model; omitted fields '
      + 'inherit this agent\'s route. Pass `model: "auto"` to delegate model choice to the built-in auto '
      + 'policy: it defaults to this agent\'s own model when one is named (anchored), upgrades to the '
      + 'strongest catalog model only when the task is heavy and the parent model is not a strong one, '
      + 'records the decision with its reason on the result, and retries once on the next tier after a '
      + 'failed foreground run. The policy is health-aware: routes that recently failed with quota/auth '
      + 'are treated as unhealthy — the anchor is dropped and the child reroutes to a healthy provider '
      + 'instead of repeatedly failing on the broken route. Failure details are classified and sanitized '
      + 'into the result (e.g. "provider rate-limited", "provider quota exhausted"). Query `' + fixedConfig.modelsToolName + '` for the live provider '
      + 'routes and their model catalogs before choosing. The child returns its result, not its '
      + 'intermediate steps. Give it a complete, standalone prompt: it does not see this conversation.'
      + (backgroundEnabled
        ? continuable
          ? ' This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends the parent a notice containing its outcome and any final assistant message; `send_message` starts a later turn in the same child conversation. Set `run_in_background: false` only when your next action depends on receiving the result.'
          : ' This call waits for the result by default. Set `run_in_background: true` to return a job id; collect with `job_output` and stop with `job_kill`.'
        : ' This call waits for the subagent and returns its result.'),
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.',
      },
      provider: {
        type: 'string',
        description: 'LLM provider route the child runs on (e.g. deepseek-official). Defaults to this agent\'s provider. Must be a registered route; query ' + fixedConfig.modelsToolName + ' for the live list.',
      },
      model: {
        type: 'string',
        description: 'Model id the child runs on (e.g. deepseek-v4-flash), or `"auto"` to let the built-in auto policy choose (requires the llm service): it defaults to this agent\'s own model, upgrading to a stronger catalog model only for heavy tasks on a weak parent model, and records its reason on the result. Defaults to this agent\'s model. Must be a model the chosen provider accepts; query ' + fixedConfig.modelsToolName + ' for the provider\'s catalog.',
      },
      max_tokens: {
        type: 'integer',
        description: 'Optional output token cap for the child (positive integer). Omitted caps inherit the parent\'s route.',
      },
      ...backgroundEnabled ? {
        run_in_background: {
          type: 'boolean' as const,
          description: continuable
            ? 'Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.'
            : 'Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill.',
        },
      } : {},
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              jobId: { type: 'string', required: true },
              auto: AUTO_SCHEMA,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'continuable' },
              subagentId: { type: 'string', required: true },
              auto: AUTO_SCHEMA,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              runId: { type: 'string', required: true },
              output: { type: 'array', required: true, items: { type: 'json' } },
              auto: AUTO_SCHEMA,
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.kind === 'background'
          ? `started background subagent task ${value.jobId}`
          : value.kind === 'continuable'
            ? `started subagent ${value.subagentId}`
            : outputValueText(value.output))
          + autoRender(value.auto as AutoDecision | undefined),
      }],
    },
    // Children never mutate the parent session; the one parent-owned write
    // (tasks.start) is a synchronous commutative insertion.
    isConcurrencySafe: () => true,
    async execute(args: {
      description: string
      prompt: string
      provider?: string
      model?: string
      max_tokens?: number
      run_in_background?: boolean
    }, exec): Promise<DelegationToolResult> {
      const parent = exec.agent
      if (!parent) {
        throw new Error(`${fixedConfig.toolName} tool requires a calling agent (exec.agent was undefined)`)
      }
      // Live config: read the latest settings-backed value on every call so a
      // 设置 → 插件配置 write takes effect without re-registering the tool.
      const liveConfig = getConfig()

      // ---- per-call model route ----
      const agentOptions: { provider?: string; model?: string; maxTokens?: number } = {}
      let autoSelection: AutoSelection | undefined
      if (args.model === 'auto') {
        if (!enableAuto) {
          throw new Error(`${fixedConfig.toolName}: model "auto" is disabled on this instance (enableAuto: false)`)
        }
        autoSelection = await resolveAutoSelection(
          ctx,
          args,
          parent.options?.provider,
          parent.options?.model,
          fixedConfig.toolName,
          health,
          liveConfig,
        )
        agentOptions.provider = autoSelection.decision.provider
        agentOptions.model = autoSelection.decision.model
      } else {
        if (args.provider !== undefined) {
          const llm = ctx.get('llm')
          if (llm === undefined) {
            throw new Error(`${fixedConfig.toolName}: provider selection requires the llm service (no ctx.llm registered)`)
          }
          const routes = llm.listProviders()
          if (!routes.some(route => route.id === args.provider)) {
            const known = routes.map(route => route.id).join(', ')
            throw new Error(
              `${fixedConfig.toolName}: unknown provider "${args.provider}" — registered provider routes: ${known || '(none)'}`,
            )
          }
          agentOptions.provider = args.provider
        }
        if (args.model !== undefined) {
          if (args.model.length === 0) throw new Error(`${fixedConfig.toolName}: model must be a non-empty string`)
          agentOptions.model = args.model
        }
      }
      if (args.max_tokens !== undefined) {
        if (!Number.isSafeInteger(args.max_tokens) || args.max_tokens <= 0) {
          throw new Error(`${fixedConfig.toolName}: max_tokens must be a positive integer`)
        }
        agentOptions.maxTokens = args.max_tokens
      }

      const request = {
        label: args.description,
        prompt: [{ type: 'text', text: args.prompt }] as ContentBlock[],
        parent,
        agentOptions,
        ...maxDepth !== undefined ? { maxDepth } : {},
      }

      const runSpec = resolveDelegationRun(args, { backgroundEnabled, continuable })
      const auto = autoSelection?.decision
      if (runSpec.runInBackground) {
        if (continuable) {
          // Resolves at inbox acceptance: the child owns its own turns from
          // there, so this call neither waits for nor collects a result.
          const started = await ctx.subagents.startContinuable({
            provider: fixedConfig.subagentProvider,
            label: args.description,
            request,
            signal: exec.signal,
          })
          return {
            kind: 'continuable',
            subagentId: String(started.childId),
            ...auto !== undefined ? { auto } : {},
          }
        }
        const jobs = ctx.get('jobs')
        if (jobs === undefined) {
          throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        }
        const id = jobs.start({
          kind: 'subagent',
          label: args.description,
          owner: parent,
          run: () => {
            const controller = new AbortController()
            const start = ctx.subagents.start(fixedConfig.subagentProvider, { ...request, signal: controller.signal })
            return {
              cancel: (reason?: string) => {
                controller.abort(reason ?? 'background subagent task killed')
              },
              done: settleStart(start, controller.signal, health, fixedConfig.subagentProvider),
            }
          },
        })
        return { kind: 'background', jobId: id, ...auto !== undefined ? { auto } : {} }
      }

      // ---- foreground run with auto failure recovery ----
      const attempt = await runForegroundWithRecovery(
        ctx,
        liveConfig,
        (options: Record<string, unknown>) => ctx.subagents.start(fixedConfig.subagentProvider, {
          ...request,
          agentOptions: { ...request.agentOptions, ...options },
          signal: exec.signal,
        }),
        autoSelection,
        request.agentOptions,
        exec.signal,
        health,
      )
      // The recovery flow may have escalated or rerouted, which updates the
      // audit decision — prefer that over the original decision.
      const recoveredAuto = attempt.auto
      return {
        kind: attempt.kind,
        runId: attempt.runId,
        output: attempt.output,
        ...recoveredAuto !== undefined ? { auto: recoveredAuto } : auto !== undefined ? { auto } : {},
      }
    },
  })))

  if (fixedConfig.enableModelList) {
    disposers.push(ctx.tools.register(defineTool({
      name: fixedConfig.modelsToolName,
      description: 'List the live LLM provider routes registered on this harness and, for each, the model '
        + 'catalog its adapter advertises, annotated with derived metadata (cost/speed/strength/specialty, '
        + 'and contextWindow when the model id is known). Advisory: catalog membership never gates requests '
        + '— a provider may still accept model ids outside its listing — but this is the authoritative way '
        + 'to see what `' + fixedConfig.toolName + '` can target. Pass `provider` to narrow to one route.',
      parameters: {
        provider: {
          type: 'string',
          description: 'Only list this provider route; omit to list every registered route.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => true,
      async execute(args: { provider?: string }): Promise<JsonValue> {
        const llm = ctx.get('llm')
        if (llm === undefined) {
          return { providers: [], note: 'llm service unavailable on this harness' }
        }
        type ProviderCatalogEntry = {
          provider: string
          name: string
          models: Array<{ id: string; name: string; cost: string; speed: string; strength: string; specialty: string[]; contextWindow?: string }>
          error?: string
          health?: string
          failingClass?: string
          retryAfterSec?: number
        }
        const routes = llm.listProviders()
        const wanted = args.provider
        const providers: ProviderCatalogEntry[] = []
        for (const route of routes) {
          if (wanted !== undefined && route.id !== wanted) continue
          let models: ProviderCatalogEntry['models'] = []
          let error: string | undefined
          try {
            models = (await llm.listModels(route.id)).map(model => ({
              id: model.id,
              name: model.name,
              ...modelMeta(model.id),
            }))
          } catch (cause) {
            error = String(cause)
          }
          const routeHealth = health.health(route.id)
          providers.push({
            provider: route.id,
            name: route.name,
            models,
            ...error !== undefined ? { error } : {},
            ...!routeHealth.healthy
              ? {
                  health: 'unhealthy',
                  ...routeHealth.failingClass !== undefined ? { failingClass: routeHealth.failingClass } : {},
                  ...routeHealth.retryAfterSec !== undefined ? { retryAfterSec: routeHealth.retryAfterSec } : {},
                }
              : { health: 'healthy' },
          })
        }
        if (wanted !== undefined && providers.length === 0) {
          const known = routes.map(route => route.id).join(', ')
          return { providers: [], note: `unknown provider "${wanted}" — registered provider routes: ${known || '(none)'}` }
        }
        return { providers }
      },
    })))
  }

  // recommend tool (ROADMAP 2a): task → ranked provider/model suggestion.
  disposers.push(ctx.tools.register(defineTool({
    name: fixedConfig.recommendToolName,
    description: 'Recommend the most suitable LLM provider/model routes for a task. Prefers a lightweight '
      + 'classifier (best-effort: a one-shot LLM call choosing from the live catalog) and degrades to a '
      + 'naming heuristic when the catalog is empty or the classifier times out/fails — it never throws on '
      + 'a classifier fault. Returns a ranked list (default top 3) with a per-pick reason plus derived '
      + 'cost/speed/strength/specialty metadata, a `source` field (`llm` or `heuristic`), and an optional '
      + '`note` explaining any degradation. Pass `provider` to restrict candidates to one route; pass `n` '
      + `to change the result count. Advisory only: feed the top pick's provider/model into `
      + `'${fixedConfig.toolName}'.`,
    parameters: {
      task: {
        type: 'string',
        required: true,
        description: 'A description of the task you want to delegate (e.g. "refactor this TypeScript module" or "summarize a long PDF"). Used to match model capabilities.',
      },
      provider: {
        type: 'string',
        description: 'Restrict candidates to this single LLM provider route; omit to consider every registered route.',
      },
      n: {
        type: 'integer',
        description: 'How many ranked recommendations to return (default 3, max 10).',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args: { task: string; provider?: string; n?: number }, exec) {
      return recommend(ctx, args, exec, health, getConfig, recommendCache, scopeStore)
    },
  })))

  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}
