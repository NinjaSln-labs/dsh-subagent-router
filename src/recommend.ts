/**
 * dsh-subagent-router — model recommendation (ROADMAP 2a).
 *
 * `subagent_recommend` turns a task description into a ranked provider/model
 * recommendation. It prefers a lightweight LLM classifier — a one-shot
 * `ctx.llm.stream()` call on the cheapest healthy model the catalog advertises
 * — and degrades gracefully to the naming heuristic in `meta.ts` when the
 * catalog is unusable, the classifier times out, or its reply cannot be
 * validated against the catalog.
 *
 * Recommendation is an enhancement, never a hard dependency: the tool never
 * throws on a classifier fault. It degrades and reports why, so a broken
 * classifier never blocks the delegating model from getting *a* suggestion.
 *
 * Honesty rule (matches meta.ts): metadata is derived and advisory. The
 * classifier only ever selects from the live catalog; any provider/model id it
 * returns that is not in the catalog is dropped, never forwarded.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ModelMeta } from './meta.ts'
import { classifyFailure, failureLabel, sanitizeFailureDetail } from './failure.ts'
import type { RouteHealthStore } from './health.ts'
import type { ResolvedModelPickerConfig } from './index.ts'
import { buildSelectionScope, normalizeModelId } from './selection.ts'
import type { SelectionEntry, SelectionTier } from './selection.ts'

/** The slice of the `llm` service this module consumes. */
type LlmService = {
  listProviders(): Array<{ id: string; name: string }>
  listModels(provider: string): Promise<Array<{ id: string; name: string }>>
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** One ranked recommendation returned to the caller. */
export type Recommendation = {
  readonly provider: string
  readonly model: string
  readonly tier: SelectionTier
  readonly reason: string
  readonly cost: ModelMeta['cost']
  readonly speed: ModelMeta['speed']
  readonly strength: ModelMeta['strength']
  readonly specialty: ModelMeta['specialty']
  readonly contextWindow?: string
}

/** The cached half of a result (source + picks, without any per-call note). */
export type RecommendationCore = {
  readonly source: 'llm' | 'heuristic'
  /** The system's default pick — the single best recommendation (== `recommendations[0]`); omitted when no candidate exists. */
  readonly recommended?: Recommendation
  /** The full ranked list (top-n), ordered best-first. */
  readonly recommendations: Recommendation[]
}

/** The tool result: the core plus an optional audit/degradation note. */
export type RecommendResult = RecommendationCore & {
  readonly note?: string
}

/** A classifier reply pick, pre-validation. */
type RawPick = {
  readonly provider: string
  readonly model: string
  readonly reason: string
}

/** Default number of recommendations. */
export const DEFAULT_RECOMMEND_COUNT = 3

/** Upper bound on the caller-requested count (prevents catalog-sized replies). */
export const MAX_RECOMMEND_COUNT = 10

/** In-session LRU capacity for normalized-task cache entries. */
export const RECOMMEND_CACHE_CAPACITY = 128

/** Cost-tier priority for classifier selection (cheapest first). */
const COST_ORDER: Record<ModelMeta['cost'], number> = { low: 0, mid: 1, high: 2 }

/** Task signals for each specialty the metadata derivation recognizes. */
const SPECIALTY_SIGNALS: ReadonlyArray<{ specialty: ModelMeta['specialty'][number]; pattern: RegExp }> = [
  { specialty: 'code', pattern: /\b(code|coder|coding|program|refactor|debug|implement|function|bug|repo|git|api|script|类型|代码|编程|重构|调试|函数|实现)\b/i },
  { specialty: 'reasoning', pattern: /\b(reason|think|analyz|analy[sz]e|logic|proof|derive|推理|分析|证明|逻辑|思考)\b/i },
  { specialty: 'vision', pattern: /\b(image|vision|photo|picture|screenshot|diagram|ocr|图片|图像|视觉|截图|识别)\b/i },
  { specialty: 'math', pattern: /\b(math|calculus|algebra|equation|geometry|数学|计算|方程|几何|微积分)\b/i },
]

/** Fixed classifier instruction; the reply must be strict JSON in `picks`. */
const RECOMMEND_SYSTEM_PROMPT =
  'You are a model-selection assistant. Given a task description and a list of candidate '
  + 'models (each with a provider, model id, cost tier, speed tier, strength tier, and '
  + 'optional specialties), choose the most suitable models for the task. Respond with ONLY '
  + 'a JSON object in this exact shape: {"picks":[{"provider":"...","model":"...","reason":"one short reason"}]}. '
  + 'Select only from the provided candidates — never invent a provider or model id. Order picks best-first.'

/**
 * Normalize a task into a stable cache key: trim, lowercase, collapse
 * whitespace, and bound length so pathological tasks cannot bloat the key.
 */
export function normalizeTask(task: string): string {
  return task.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 500)
}

/** A tiny FIFO-eviction cache (insertion order = recency). */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>()

  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }
}

/**
 * Collect the candidate models from the live catalog, honoring an optional
 * provider filter and the route health store (unhealthy routes are excluded:
 * recommending a dead route would just fail again).
 */
async function collectScope(
  llm: LlmService,
  providerFilter: string | undefined,
  providerOrder: readonly string[],
): Promise<SelectionEntry[]> {
  const models: Array<{ id: string; name: string; provider: string }> = []
  for (const route of llm.listProviders()) {
    if (providerFilter !== undefined && route.id !== providerFilter) continue
    let listed: Array<{ id: string; name: string }>
    try {
      listed = await llm.listModels(route.id)
    } catch {
      continue // provider unusable right now — skip it
    }
    for (const model of listed) {
      models.push({ id: model.id, name: model.name, provider: route.id })
    }
  }
  return buildSelectionScope(models, providerOrder)
}

/** Bounded selection-scope cache, invalidated when the provider topology changes. */
export class ScopeStore {
  private scope: SelectionEntry[] | undefined

  get(): SelectionEntry[] | undefined {
    return this.scope
  }

  set(value: SelectionEntry[]): void {
    this.scope = value
  }

  invalidate(): void {
    this.scope = undefined
  }
}

/** Models too light to reliably emit structured JSON — skip as the classifier host. */
const TOO_LIGHT = /\b(lite|mini|nano|tiny|micro|small)\b/i

/**
 * Rank classifier-host candidates: the cheapest tier, preferring providers the
 * caller lists first in `providerOrder`, skipping ultra-light models (which
 * often return empty text). Returns up to `limit` candidates so the caller can
 * retry a stronger/faster model when a cheap one comes back empty.
 */
export function pickClassifiers(
  candidates: readonly SelectionEntry[],
  providerOrder: readonly string[] = [],
  limit = 3,
): Array<{ provider: string; model: string }> {
  // Prefer mid/strong models over light ones for the classifier host: a light
  // model on a free route is fast but unreliable (empty replies / latency
  // spikes), while a mid model on a paid route is stable enough for a one-shot
  // 512-token structured reply. Ultra-light names are always excluded.
  const eligible = candidates.filter(candidate =>
    candidate.meta.strength !== 'light' && !TOO_LIGHT.test(candidate.model))
  const pool = eligible.length > 0 ? eligible : candidates
  const order = [...providerOrder, ...pool.map(candidate => candidate.provider)]
  const rank = new Map<string, number>()
  order.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index)
  })
  return [...pool]
    .sort((a, b) => {
      // cost first (mid before strong), then provider order, then model id.
      if (COST_ORDER[a.meta.cost] !== COST_ORDER[b.meta.cost]) {
        return COST_ORDER[a.meta.cost] - COST_ORDER[b.meta.cost]
      }
      const ra = rank.get(a.provider) ?? Number.MAX_SAFE_INTEGER
      const rb = rank.get(b.provider) ?? Number.MAX_SAFE_INTEGER
      if (ra !== rb) return ra - rb
      return a.model.localeCompare(b.model)
    })
    .slice(0, limit)
    .map(candidate => ({ provider: candidate.provider, model: candidate.model }))
}

/** The single best classifier-host candidate (first of {@link pickClassifiers}). */
export function pickClassifier(
  candidates: readonly SelectionEntry[],
  providerOrder: readonly string[] = [],
): { provider: string; model: string } | undefined {
  return pickClassifiers(candidates, providerOrder, 1)[0]
}

/** Per-candidate heuristic score (higher = more suitable). */
function heuristicScore(task: string, candidate: SelectionEntry): number {
  const meta = candidate.meta
  let score = meta.strength === 'strong' ? 2 : meta.strength === 'mid' ? 1 : 0
  for (const signal of SPECIALTY_SIGNALS) {
    if (signal.pattern.test(task) && meta.specialty.includes(signal.specialty)) score += 2
  }
  return score
}

/** One-line reason for a heuristic pick. */
function heuristicReason(task: string, candidate: SelectionEntry): string {
  const parts: string[] = []
  parts.push(candidate.meta.strength === 'strong' ? 'strong tier' : candidate.meta.strength === 'mid' ? 'mid tier' : 'light/fast tier')
  for (const signal of SPECIALTY_SIGNALS) {
    if (signal.pattern.test(task) && candidate.meta.specialty.includes(signal.specialty)) {
      parts.push(`matches ${signal.specialty} specialty`)
    }
  }
  return parts.join('; ')
}

/** Render a candidate into a Recommendation leaf. */
function toRecommendation(candidate: SelectionEntry, reason: string): Recommendation {
  const { meta } = candidate
  return {
    provider: candidate.provider,
    model: candidate.model,
    tier: candidate.tier,
    reason,
    cost: meta.cost,
    speed: meta.speed,
    strength: meta.strength,
    specialty: meta.specialty,
    ...meta.contextWindow !== undefined ? { contextWindow: meta.contextWindow } : {},
  }
}

/** Heuristic fallback: rank candidates by naming signal, take the top n. */
export function heuristicRecommend(task: string, candidates: readonly SelectionEntry[], n: number): Recommendation[] {
  const scored = candidates
    .map(candidate => ({ candidate, score: heuristicScore(task, candidate) }))
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, n).map(({ candidate }) => toRecommendation(candidate, heuristicReason(task, candidate)))
}

/** Extract `picks` from a classifier reply, tolerating fenced/markdown JSON. */
export function parsePicks(text: string): RawPick[] | undefined {
  const extract = (value: unknown): RawPick[] | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const picks = (value as { picks?: unknown }).picks
    if (!Array.isArray(picks)) return undefined
    const out: RawPick[] = []
    for (const entry of picks) {
      if (typeof entry !== 'object' || entry === null) continue
      const { provider, model, reason } = entry as { provider?: unknown; model?: unknown; reason?: unknown }
      if (typeof provider === 'string' && typeof model === 'string' && typeof reason === 'string') {
        out.push({ provider, model, reason })
      }
    }
    return out.length > 0 ? out : undefined
  }

  const trimmed = text.trim()
  try {
    const parsed = extract(JSON.parse(trimmed))
    if (parsed !== undefined) return parsed
  } catch { /* keep trying */ }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence !== null) {
    try {
      const parsed = extract(JSON.parse(fence[1].trim()))
      if (parsed !== undefined) return parsed
    } catch { /* keep trying */ }
  }
  const braceStart = trimmed.indexOf('{')
  const braceEnd = trimmed.lastIndexOf('}')
  if (braceStart >= 0 && braceEnd > braceStart) {
    try {
      const parsed = extract(JSON.parse(trimmed.slice(braceStart, braceEnd + 1)))
      if (parsed !== undefined) return parsed
    } catch { /* fall through */ }
  }
  return undefined
}

/** Validate classifier picks against the catalog; drop any hallucinated ids. */
function validatePicks(
  picks: readonly RawPick[],
  candidates: readonly SelectionEntry[],
  n: number,
): Recommendation[] {
  // Two indexes: the exact provider/model key, and a lenient key (provider
  // case-insensitive + model normalized) so a classifier that echoes the model
  // with different casing or a version suffix still matches.
  const byKey = new Map<string, SelectionEntry>()
  for (const candidate of candidates) {
    byKey.set(`${candidate.provider}\u0000${candidate.model}`, candidate)
    byKey.set(`${candidate.provider.toLowerCase()}\u0000${normalizeModelId(candidate.model)}`, candidate)
  }
  const out: Recommendation[] = []
  for (const pick of picks) {
    const candidate = byKey.get(`${pick.provider}\u0000${pick.model}`)
      ?? byKey.get(`${pick.provider.toLowerCase()}\u0000${normalizeModelId(pick.model)}`)
    if (candidate === undefined) continue // id not in catalog — drop, never forward
    out.push(toRecommendation(candidate, pick.reason))
    if (out.length >= n) break
  }
  return out
}

/** A dedicated timeout marker so the caller can label the degradation precisely. */
class TimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`recommend classifier timed out after ${timeoutMs}ms`)
    this.name = 'TimeoutError'
  }
}

/** Run the one-shot classifier call and parse its reply. Throws on fault/timeout. */
async function classifyViaLlm(
  llm: LlmService,
  task: string,
  candidates: readonly SelectionEntry[],
  classifier: { provider: string; model: string },
  timeoutMs: number,
  execSignal: AbortSignal | undefined,
): Promise<{ picks: RawPick[] | undefined; raw: string }> {
  const compact = candidates.map(candidate => ({
    provider: candidate.provider,
    model: candidate.model,
    tier: candidate.tier,
    cost: candidate.meta.cost,
    speed: candidate.meta.speed,
    strength: candidate.meta.strength,
    ...candidate.meta.specialty.length > 0 ? { specialty: candidate.meta.specialty } : {},
    ...candidate.meta.contextWindow !== undefined ? { contextWindow: candidate.meta.contextWindow } : {},
  }))
  const message = createUserMessage({
    content: [{ type: 'text', text: JSON.stringify({ task, candidates: compact }, null, 2) }],
    // 0.2.0-rc.2：MessageSource 收紧了——不再有通用 `plugin` kind（每个 producer
    // 在自己的模块声明 kind）。这是本插件发起的一次性分类调用，作为用笺内容进入
    // agent loop，用 `user` kind 即可（消费端对未知 kind 一律 fall through）。
    source: { kind: 'user' },
  })

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const onExecAbort = (): void => controller.abort()
  if (execSignal !== undefined) execSignal.addEventListener('abort', onExecAbort)
  try {
    let text = ''
    for await (const chunk of llm.stream({
      provider: classifier.provider,
      model: classifier.model,
      messages: [message],
      system: RECOMMEND_SYSTEM_PROMPT,
      temperature: 0,
      maxTokens: 512,
      signal: controller.signal,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'aborted' || chunk.reason.kind === 'error') {
          const failure = chunk.reason.failure
          throw new Error(
            `recommend classifier finished abnormally (${chunk.reason.kind})`
            + `${failure.code !== undefined ? ` [${failure.code}]` : ''}`,
          ) as Error & { code?: string }
        }
      }
    }
    return { picks: parsePicks(text), raw: text }
  } catch (error) {
    if (timedOut) throw new TimeoutError(timeoutMs)
    throw error
  } finally {
    clearTimeout(timer)
    if (execSignal !== undefined) execSignal.removeEventListener('abort', onExecAbort)
  }
}

/** Assemble a degradation note from a classifier fault, honoring the timeout marker. */
function degradationNote(error: unknown, timeoutMs: number, timeoutError: boolean): string {
  if (timeoutError) return `classifier timed out after ${timeoutMs}ms; fell back to heuristic`
  const cls = classifyFailure(error)
  if (cls === 'other') {
    const detail = sanitizeFailureDetail(error)
    return `classifier unavailable (${detail}); fell back to heuristic`
  }
  return `${failureLabel(cls)}; fell back to heuristic`
}

/** Build a core result, stamping the top pick as the explicit `recommended` default. */
function buildCore(source: 'llm' | 'heuristic', recommendations: Recommendation[]): RecommendationCore {
  return {
    source,
    ...recommendations.length > 0 ? { recommended: recommendations[0] } : {},
    recommendations,
  }
}

/**
 * Recommend provider/model routes for a task.
 *
 * Degradation ladder: catalog empty → empty heuristic result → classifier
 * fault / timeout / unvalidatable reply → naming heuristic.
 */
export async function recommend(
  ctx: Context,
  args: { task: string; provider?: string; n?: number },
  exec: { signal?: AbortSignal; agent?: { options?: { provider?: string; model?: string } } },
  health: RouteHealthStore,
  getConfig: () => ResolvedModelPickerConfig,
  cache: LruCache<string, RecommendationCore>,
  scopeStore: ScopeStore,
): Promise<RecommendResult> {
  const config = getConfig()
  const n = args.n !== undefined && Number.isSafeInteger(args.n) && args.n > 0
    ? Math.min(args.n, MAX_RECOMMEND_COUNT)
    : DEFAULT_RECOMMEND_COUNT
  if (args.task.trim().length === 0) {
    throw new Error('subagent_recommend: task must be a non-empty string')
  }

  const llm = ctx.get('llm') as LlmService | undefined
  if (llm === undefined) {
    return { source: 'heuristic', recommendations: [], note: 'llm service unavailable on this harness' }
  }

  // Resolve the bounded selection scope (cached for the unfiltered case,
  // invalidated on `llm/adapters-updated`), then drop unhealthy routes.
  let scope: SelectionEntry[]
  if (args.provider !== undefined) {
    scope = await collectScope(llm, args.provider, config.autoProviderOrder)
  } else {
    const cached = scopeStore.get()
    scope = cached ?? await collectScope(llm, undefined, config.autoProviderOrder)
    if (cached === undefined) scopeStore.set(scope)
  }
  const candidates = scope.filter(entry => health.isHealthy(entry.provider))
  if (candidates.length === 0) {
    return {
      source: 'heuristic',
      recommendations: [],
      note: args.provider !== undefined
        ? `no healthy candidates for provider "${args.provider}"`
        : 'no healthy candidate models in the catalog',
    }
  }

  const cacheKey = `${args.provider ?? '*'}\u0000${normalizeTask(args.task)}`
  const cached = cache.get(cacheKey)
  if (cached !== undefined) {
    return { ...cached, note: 'cached (normalized task)' }
  }

  const heuristic = (note: string): RecommendResult => ({
    ...buildCore('heuristic', heuristicRecommend(args.task, candidates, n)),
    note,
  })

  // Classifier hosts, anchored first: the calling agent's own model is always
  // healthy (it is running right now), so try it first — this reuses the
  // harness's "anchor to parent" auto semantics instead of hand-picking a
  // cheap model. Fall back to the bounded selection-scope candidates with
  // health-aware reroute after that.
  const parent = exec.agent?.options
  const classifiers: Array<{ provider: string; model: string }> = []
  if (typeof parent?.provider === 'string' && typeof parent?.model === 'string') {
    classifiers.push({ provider: parent.provider, model: parent.model })
  }
  const seen = new Set(classifiers.map(entry => `${entry.provider}\u0000${entry.model}`))
  for (const c of pickClassifiers(candidates, config.autoProviderOrder, 3)) {
    const key = `${c.provider}\u0000${c.model}`
    if (!seen.has(key)) {
      seen.add(key)
      classifiers.push(c)
    }
  }
  if (classifiers.length === 0) {
    return heuristic('no classifier model available; heuristic selection')
  }

  // Try each classifier-host candidate in rank order; the first that returns
  // a validated pick wins. An empty reply or a fault moves to the next host, so
  // a single cheap model that comes back empty does not sink the llm path.
  let lastRaw = ''
  let lastError: unknown
  for (const classifier of classifiers) {
    try {
      const { picks, raw } = await classifyViaLlm(llm, args.task, candidates, classifier, config.recommendTimeoutMs, exec.signal)
      lastRaw = raw
      if (picks !== undefined) {
        const recommendations = validatePicks(picks, candidates, n)
        if (recommendations.length > 0) {
          const core: RecommendationCore = buildCore('llm', recommendations)
          cache.set(cacheKey, core)
          return core
        }
      }
    } catch (error) {
      lastError = error
    }
  }
  if (lastError !== undefined) {
    return heuristic(degradationNote(lastError, config.recommendTimeoutMs, lastError instanceof TimeoutError))
  }
  return heuristic(`classifier reply failed validation; heuristic selection${rawSnippet(lastRaw)}`)
}

/** A bounded, whitespace-collapsed excerpt of the classifier's raw reply, for diagnostics. */
function rawSnippet(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ')
  if (trimmed.length === 0) return '（分类器无输出）'
  return `（分类器返回：${trimmed.slice(0, 160)}${trimmed.length > 160 ? '…' : ''}）`
}
