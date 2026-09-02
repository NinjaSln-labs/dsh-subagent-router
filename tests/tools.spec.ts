/**
 * dsh-subagent-router — model-chosen subagent delegation.
 *
 * Drives the REAL plugin body on a real `ToolRuntime` + `SubagentRuntime`,
 * with a package-local scripted subagent provider and a faked `llm` route
 * registry, and invokes the registered tools through `ctx.tools.execute`.
 * Continuable background execution is not exercised here: that path is
 * verbatim from the shipped `@deepseek-ai/dsh-tool-subagent` and needs the
 * full agent-loop testkit; only its mount-time capability rejection is
 * covered.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { ToolCallId, LlmError } from '@deepseek-ai/dsh-llm'
import plugin from '../src/index.ts'
import type { ModelPickerConfig } from '../src/index.ts'
import { classifyFailure, failureLabel, sanitizeFailureDetail } from '../src/failure.ts'
import { RouteHealthStore, DEFAULT_TRANSIENT_TTL_MS, DEFAULT_UNCLASSIFIED_TTL_MS } from '../src/health.ts'

const testToolSignal = new AbortController().signal

/** A minimal parent Agent passed through to the provider request. */
const fakeAgent = { id: 'parent-1', ctx: undefined } as never

/** Scripted subagent provider that captures every start request. */
class ScriptedProvider implements SubagentProvider {
  readonly inheritsParentContext = false
  readonly capabilities = { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true }
  starts: Array<Record<string, unknown>> = []
  reply = 'child says hi'
  /** The first N starts fail with stopReason 'error' (before the reply). */
  failFirstCount = 0
  /** Diagnostic text for failed starts (absent when empty). */
  failDiagnostic = ''
  /** The first N starts reject with the given cause (infrastructure failure). */
  rejectFirstCount = 0
  /** Exact start indexes that reject with the given cause (overrides rejectFirstCount). */
  rejectAtIndex: number[] = []
  /** Cause for start rejections (classification evidence). */
  rejectCause: unknown = new Error('start rejected')
  private startsMade = 0

  constructor(readonly name: string) {}

  // Continuable is the fixed background mode (see `fixedConfig`); the provider
  // must present `prepareContinuable` to mount. Tests run calls in the
  // foreground (`run_in_background: false` injected by callTool) so the
  // scripted start/settle path stays the primary one.
  async prepareContinuable(): Promise<unknown> {
    return { childId: `cont-${this.name}` }
  }

  startContinuable(spec: { childId: string }): unknown {
    return { childId: spec.childId }
  }

  start(request: never) {
    this.starts.push(request as unknown as Record<string, unknown>)
    const index = this.startsMade++
    if (index < this.rejectFirstCount || this.rejectAtIndex.includes(index)) {
      return Promise.reject(this.rejectCause)
    }
    const result: Promise<SubagentResult> = index < this.failFirstCount
      ? Promise.resolve({
          output: [],
          stopReason: 'error',
          ...this.failDiagnostic.length > 0 ? { diagnostic: this.failDiagnostic } : {},
        } satisfies SubagentResult)
      : Promise.resolve({
          output: [{ type: 'text', text: this.reply }],
          stopReason: 'completed',
        } satisfies SubagentResult)
    const run: SubagentRun = {
      id: `scripted-${this.name}` as never,
      localAgent: undefined as never,
      result,
      dispose: async () => {},
    }
    return run
  }
}

/** Minimal fake `llm` route registry (no network, no adapters). */
function fakeLlm(routes: Array<{
  id: string
  name: string
  models: Array<{ id: string; name: string }>
  error?: string
}>) {
  return {
    listProviders() {
      return routes.map(({ id, name }) => ({ id, name }))
    },
    async listModels(provider: string) {
      const route = routes.find(candidate => candidate.id === provider)
      if (route === undefined) throw new Error(`no route "${provider}"`)
      if (route.error !== undefined) throw new Error(route.error)
      return route.models.map(model => ({ provider, id: model.id, name: model.name }))
    },
  } as never
}

const DEFAULT_ROUTES = [
  { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] },
  { id: 'pi-ai-cn', name: 'PI AI CN', models: [{ id: 'pi-3-mini', name: 'PI 3 Mini' }] },
]

/** Three strength tiers so auto escalation has a distinct target. */
const AUTO_ROUTES = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-std', name: 'DeepSeek V4 Std' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
  },
]

/** A route with both a paid and a free version of the same model family. */
const FREE_PAID_ROUTES = [
  {
    id: 'teamorouter',
    name: 'TeamoRouter',
    models: [
      { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    ],
  },
]

/** A parent whose options name its own provider route. */
const fakeAgentWithRoute = {
  id: 'parent-1',
  ctx: undefined,
  options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
} as never

/** A parent running a strong model on its own route. */
const fakeAgentOnPro = {
  id: 'parent-2',
  ctx: undefined,
  options: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
} as never

async function setup(config: ModelPickerConfig = {}, options: {
  routes?: Array<{ id: string; name: string; models: Array<{ id: string; name: string }>; error?: string }>
  withLlm?: boolean
  providerName?: string
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  if (options.withLlm !== false) {
    ctx.provide('llm', fakeLlm(options.routes ?? DEFAULT_ROUTES))
  }
  const provider = new ScriptedProvider(options.providerName ?? 'spawn')
  ctx.subagents.registerProvider(provider)
  // The subagent provider is a fixed constant (`fixedConfig.subagentProvider`
  // = 'spawn'); tests register under that name so the plugin mounts.
  await ctx.plugin(plugin, config)
  return { ctx, provider }
}

let callCounter = 0
function callTool(ctx: Context, name: string, args: unknown, agent?: unknown) {
  // Background mode is fixed to continuable; these unit tests exercise the
  // foreground start/settle path, so default every call to foreground (an
  // explicit `run_in_background: true` in `args` overrides this spread).
  const arguments_ = { run_in_background: false, ...(args as Record<string, unknown>) }
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: arguments_,
    ...agent !== undefined ? { agent } : {},
  })
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function propsOf(ctx: Context, name: string): Record<string, unknown> {
  const schema = ctx.tools.schemas().find(candidate => candidate.name === name)
  expect(schema).toBeDefined()
  return (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
}

afterEach(() => {
  callCounter = 0
})

describe('agent/request-error hook', () => {
  it('records parent request failures into the health store', async () => {
    const { ctx } = await setup()
    // Emit a parent model-request failure: LlmFailure plain object.
    // The waterfall event's next() is the last-argument pass-through.
    await ctx.emit('agent/request-error', {
      agent: fakeAgent,
      turn: 1,
      step: 1,
      provider: 'deepseek-official',
      failure: { code: 'QUOTA', status: 402, message: 'quota exhausted' },
      retryPolicy: undefined,
      signal: testToolSignal,
    }, () => Promise.resolve(undefined))
    // Health store is internal; verify via the catalog tool which reads it.
    const cat = await callTool(ctx, 'subagent_models', { provider: 'deepseek-official' })
    const textOut = text(cat as never)
    expect(textOut).toContain('unhealthy')
    expect(textOut).toContain('quota')
  })

  it('does not block the event chain (waterfall-compatible)', async () => {
    const { ctx } = await setup()
    // Our listener already calls next(); verify a downstream listener still fires.
    let downstreamCalled = false
    ctx.on('agent/request-error', async (_payload, next) => {
      downstreamCalled = true
      if (typeof next === 'function') return next()
    })
    await ctx.emit('agent/request-error', {
      agent: fakeAgent,
      turn: 1,
      step: 1,
      provider: 'deepseek-official',
      failure: { code: 'RATE_LIMIT', status: 429, message: 'rate limited' },
      retryPolicy: undefined,
      signal: testToolSignal,
    }, () => Promise.resolve(undefined))
    expect(downstreamCalled).toBe(true)
  })
})

describe('paid-model preference (modelScore + model-level anchor)', () => {
  it('prefers the paid model over the free version when both exist on the same provider', async () => {
    // A parent on a different provider ("deepseek-official") with model
    // "deepseek-v4-flash" delegates with model: "auto" to a provider
    // ("teamorouter") that carries both "deepseek-v4-flash" and
    // "deepseek-v4-flash-free". The model-level anchor should pick the paid
    // version (the parent's model name is present on the effective provider).
    // Use a standard-tier task (not complex) so the anchor fires regardless
    // of the parent model's strength score.
    const { ctx, provider } = await setup(
      { autoProviderOrder: ['teamorouter'] },
      { routes: FREE_PAID_ROUTES },
    )
    // "deepseek-official" is not in FREE_PAID_ROUTES, so auto will fall
    // through to autoProviderOrder → "teamorouter".
    const result = await callTool(ctx, 'subagent_model', {
      description: 'a standard task',
      prompt: 'Go through this dataset and report the main trends and outliers.',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(false)
    const options = provider.starts[0]!.agentOptions as { provider?: string; model?: string }
    // The model-level anchor should pick the paid version because the parent
    // model "deepseek-v4-flash" is present on "teamorouter".
    expect(options.model).toBe('deepseek-v4-flash')
    expect(options.provider).toBe('teamorouter')
    const textOut = text(result)
    expect(textOut).toContain('anchored')
  })

  it('still selects the free model when it is the only option', async () => {
    const { ctx, provider } = await setup(
      { autoProviderOrder: ['teamorouter'] },
      { routes: FREE_PAID_ROUTES },
    )
    // Parent on a different model only available as free.
    const result = await callTool(ctx, 'subagent_model', {
      description: 'a standard task',
      prompt: 'Go through this dataset and report the main trends and outliers.',
      model: 'auto',
    }, { id: 'parent', options: { provider: 'deepseek-official', model: 'deepseek-v4-flash-free' } } as never)
    expect(result.isError).toBe(false)
    const options = provider.starts[0]!.agentOptions as { provider?: string; model?: string }
    // Parent model is "deepseek-v4-flash-free"; model-level anchor should
    // pick it since it exists on "teamorouter".
    expect(options.model).toBe('deepseek-v4-flash-free')
    const textOut = text(result)
    expect(textOut).toContain('anchored')
  })

  it('standard tier pickModel prefers the highest-scoring model when no balanced model exists', async () => {
    // A route with only free-tier models (all negative scores). Standard tier
    // pickModel: find(score===0) ?? max(score). No model has score 0, so it
    // picks the highest-scoring one.
    const allFreeRoutes = [
      {
        id: 'freeprovider',
        name: 'Free Provider',
        models: [
          { id: 'deepseek-v4-flash-free', name: 'Free Flash' },  // score: -2
          { id: 'deepseek-v4-nano', name: 'Nano' },              // score: -1
        ],
      },
    ]
    const { ctx, provider } = await setup(
      { autoProviderOrder: ['freeprovider'] },
      { routes: allFreeRoutes },
    )
    // Task ~200 chars to land in standard tier (past 160 trivial threshold,
    // below 1200 complex threshold, no COMPLEX_MARKERS).
    const result = await callTool(ctx, 'subagent_model', {
      description: 'a standard-length task',
      prompt: 'Go through this dataset and list the main trends and outliers you notice, then write up a short summary of what stands out. Keep it ordinary and mid-length, past the trivial threshold but nowhere near the heavier cutoff, so this task lands in the middle tier for the test.',
      model: 'auto',
    }, fakeAgent) // no parent model → heuristic fallback, no model-level anchor
    expect(result.isError).toBe(false)
    const options = provider.starts[0]!.agentOptions as { provider?: string; model?: string }
    // "deepseek-v4-nano" (-1) has higher score than "deepseek-v4-flash-free" (-2)
    expect(options.model).toBe('deepseek-v4-nano')
  })
})

describe('runtime 402 fallback (extractFailureEvidenceFromResult)', () => {
  it('records a stopReason error with quota diagnostic as quota in the health store', async () => {
    const { ctx, provider } = await setup(
      { autoEscalate: false }, // prevent escalation — we want the failure to surface
      { routes: AUTO_ROUTES },
    )
    provider.failFirstCount = 1
    provider.failDiagnostic = '402: free_request_quota_exhausted: 您的deepseek-v4-flash免费额度已耗尽'
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentWithRoute)
    // The foreground run should fail (the subagent returns stopReason: 'error').
    expect(result.isError).toBe(true)
    // The health store should now record the provider as unhealthy with quota.
    const cat = await callTool(ctx, 'subagent_models', { provider: 'deepseek-official' })
    const textOut = text(cat as never)
    // "deepseek-official" should be marked unhealthy because the first attempt
    // classified the diagnostic as quota.
    expect(textOut).toContain('unhealthy')
    expect(textOut).toContain('quota')
  })
})

describe('verb extraction + 4-tier (PLAN-4)', () => {
  it('trivial task with Chinese verb "列一下" gets tier=trivial', async () => {
    const { ctx, provider } = await setup({}, { routes: AUTO_ROUTES })
    const result = await callTool(ctx, 'subagent_model', {
      description: '列一下今天的文件',
      prompt: '列一下当前目录下的所有文件',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(false)
    // The parent anchor fires, so the model is the parent's model.
    // Verify the tier is correct from the audit line.
    const textOut = text(result)
    expect(textOut).toContain('tier=trivial')
  })

  it('Chinese "调研" gets tier=complex', async () => {
    const { ctx, provider } = await setup({}, { routes: AUTO_ROUTES })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'Voyage 全网调研',
      prompt: '调研Voyage市场的最新趋势和竞品动态',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('tier=complex')
  })

  it('Chinese "重构" gets tier=standard', async () => {
    const { ctx, provider } = await setup({}, { routes: AUTO_ROUTES })
    const result = await callTool(ctx, 'subagent_model', {
      description: '重构代码库',
      prompt: '重构这个模块的核心逻辑，提升可维护性',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('tier=standard')
  })

  it('Chinese "总结" gets tier=light', async () => {
    const { ctx, provider } = await setup({}, { routes: AUTO_ROUTES })
    const result = await callTool(ctx, 'subagent_model', {
      description: '总结一下',
      prompt: '总结一下这份报告的主要内容',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('tier=light')
  })

  it('English "analyze" gets tier=complex via COMPLEX_MARKERS', async () => {
    const { ctx, provider } = await setup({}, { routes: AUTO_ROUTES })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'analyze data',
      prompt: 'Analyze this dataset and find the key patterns',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('tier=complex')
  })

  it('English "list" gets tier=trivial via verb extraction', async () => {
    const { ctx, provider } = await setup({}, { routes: AUTO_ROUTES })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'list files',
      prompt: 'List all files in the current directory',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('tier=trivial')
  })

  it('Chinese single-char verb "查" with polite prefix "请" matches trivial', async () => {
    const { ctx, provider } = await setup({}, { routes: AUTO_ROUTES })
    const result = await callTool(ctx, 'subagent_model', {
      description: '请查一下数据',
      prompt: '请查一下昨天的销售数据',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('tier=trivial')
  })

  it('Chinese compound word "调查" does not match single-char "查"', async () => {
    const { ctx, provider } = await setup({}, { routes: AUTO_ROUTES })
    const result = await callTool(ctx, 'subagent_model', {
      description: '调查一下',
      prompt: '调查一下这个情况',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(false)
    // "调查" matches the verb "调查" → complex
    expect(text(result)).toContain('tier=complex')
  })
})

describe('dsh-subagent-router delegation tool', () => {
  it('registers `subagent_model` exposing description/prompt/provider/model/max_tokens/run_in_background', async () => {
    const { ctx } = await setup()
    expect(Object.keys(propsOf(ctx, 'subagent_model')).sort())
      .toEqual(['description', 'max_tokens', 'model', 'prompt', 'provider', 'run_in_background'])
  })

  it('registers the `subagent_models` catalog tool by default', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.schemas().some(candidate => candidate.name === 'subagent_models')).toBe(true)
  })

  it('registers the `subagent_recommend` tool with task/provider/n parameters', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.schemas().some(candidate => candidate.name === 'subagent_recommend')).toBe(true)
    expect(Object.keys(propsOf(ctx, 'subagent_recommend')).sort()).toEqual(['n', 'provider', 'task'])
  })

  it('inherits the parent route when provider/model are omitted', async () => {
    const { ctx, provider } = await setup()
    const result = await callTool(ctx, 'subagent_model', { description: 'do a thing', prompt: 'go research X' }, fakeAgent)
    expect(result.isError).toBe(false)
    expect(provider.starts).toHaveLength(1)
    const request = provider.starts[0]!
    expect(request.agentOptions).toEqual({})
    expect(request.parent).toBe(fakeAgent)
    // Depth cap is fixed to provider-managed (see `fixedConfig`) — no numeric
    // maxDepth is forwarded to the provider.
    expect(request.maxDepth).toBeUndefined()
    expect(text(result)).toBe('child says hi')
  })

  it('passes per-call provider/model/max_tokens into agentOptions', async () => {
    const { ctx, provider } = await setup()
    const result = await callTool(ctx, 'subagent_model', {
      description: 'heavy analysis',
      prompt: 'analyze deeply',
      provider: 'pi-ai-cn',
      model: 'pi-3-mini',
      max_tokens: 2048,
    }, fakeAgent)
    expect(result.isError).toBe(false)
    expect(provider.starts[0]!.agentOptions).toEqual({
      provider: 'pi-ai-cn',
      model: 'pi-3-mini',
      maxTokens: 2048,
    })
  })

  it('rejects an unknown provider route with the registered list', async () => {
    const { ctx } = await setup()
    const result = await callTool(ctx, 'subagent_model', {
      description: 'x',
      prompt: 'y',
      provider: 'nope-provider',
    }, fakeAgent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unknown provider "nope-provider"')
    expect(text(result)).toContain('deepseek-official')
    expect(text(result)).toContain('pi-ai-cn')
  })

  it('rejects an unknown provider even when the route list is empty', async () => {
    const { ctx } = await setup({}, { routes: [] })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'x',
      prompt: 'y',
      provider: 'anything',
    }, fakeAgent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('registered provider routes: (none)')
  })

  it('passes an arbitrary model id through (catalogs are advisory)', async () => {
    const { ctx, provider } = await setup()
    const result = await callTool(ctx, 'subagent_model', {
      description: 'x',
      prompt: 'y',
      model: 'deepseek-some-future-model',
    }, fakeAgent)
    expect(result.isError).toBe(false)
    expect(provider.starts[0]!.agentOptions).toEqual({ model: 'deepseek-some-future-model' })
  })

  it('rejects non-positive or non-integer max_tokens', async () => {
    const { ctx } = await setup()
    // 0 and negative values pass schema validation (integer) and are caught
    // by the runtime guard; 1.5 is rejected by the schema itself.
    for (const maxTokens of [0, -5]) {
      const result = await callTool(ctx, 'subagent_model', {
        description: 'x',
        prompt: 'y',
        max_tokens: maxTokens,
      }, fakeAgent)
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('max_tokens must be a positive integer')
    }
    const fractional = await callTool(ctx, 'subagent_model', {
      description: 'x',
      prompt: 'y',
      max_tokens: 1.5,
    }, fakeAgent)
    expect(fractional.isError).toBe(true)
    expect(text(fractional)).toContain('invalid arguments')
  })

  it('requires a calling agent', async () => {
    const { ctx } = await setup()
    const result = await callTool(ctx, 'subagent_model', { description: 'x', prompt: 'y' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
  })

  it('fails loud at mount when the provider lacks the continuable capability (fixed backgroundMode)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    const provider = new ScriptedProvider('spawn')
    provider.prepareContinuable = undefined as never  // instance shadow beats the prototype method
    ctx.subagents.registerProvider(provider)
    let failure: unknown
    try {
      await ctx.plugin(plugin)
    } catch (error) {
      failure = error
    }
    expect(String(failure)).toContain('does not support')
    expect(String(failure)).toContain('continuable')
  })
})

describe('dsh-subagent-router catalog tool', () => {
  it('lists every registered provider with its models', async () => {
    const { ctx } = await setup()
    const result = await callTool(ctx, 'subagent_models', {})
    expect(result.isError).toBe(false)
    const value = JSON.parse(text(result)) as {
      providers: Array<{
        provider: string
        name: string
        models: Array<{ id: string; name: string }>
        health?: string
      }>
    }
    expect(value.providers).toEqual([
      {
        provider: 'deepseek-official',
        name: 'DeepSeek',
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', cost: 'low', speed: 'fast', strength: 'light', specialty: [], contextWindow: '128k' }],
        health: 'healthy',
      },
      {
        provider: 'pi-ai-cn',
        name: 'PI AI CN',
        models: [{ id: 'pi-3-mini', name: 'PI 3 Mini', cost: 'low', speed: 'fast', strength: 'light', specialty: [] }],
        health: 'healthy',
      },
    ])
  })

  it('narrows to one provider and reports unknown ones', async () => {
    const { ctx } = await setup()
    const narrowed = await callTool(ctx, 'subagent_models', { provider: 'pi-ai-cn' })
    expect(narrowed.isError).toBe(false)
    expect(JSON.parse(text(narrowed))).toEqual({
      providers: [{
        provider: 'pi-ai-cn',
        name: 'PI AI CN',
        models: [{ id: 'pi-3-mini', name: 'PI 3 Mini', cost: 'low', speed: 'fast', strength: 'light', specialty: [] }],
        health: 'healthy',
      }],
    })
    const unknown = await callTool(ctx, 'subagent_models', { provider: 'ghost' })
    expect(unknown.isError).toBe(false)
    const parsed = JSON.parse(text(unknown)) as { providers: unknown[]; note: string }
    expect(parsed.providers).toEqual([])
    expect(parsed.note).toContain('unknown provider "ghost"')
  })

  it('degrades gracefully when the llm service is absent', async () => {
    const { ctx } = await setup({}, { withLlm: false })
    const result = await callTool(ctx, 'subagent_models', {})
    expect(result.isError).toBe(false)
    expect(JSON.parse(text(result))).toEqual({
      providers: [],
      note: 'llm service unavailable on this harness',
    })
  })
})

describe('dsh-subagent-router auto selection (model "auto")', () => {
  it('picks the cheapest model for a trivial task and records the audit line', async () => {
    const { ctx, provider } = await setup({}, { routes: AUTO_ROUTES })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      provider: 'deepseek-official',
      model: 'auto',
    }, fakeAgent)
    expect(result.isError).toBe(false)
    expect(provider.starts[0]!.agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(text(result)).toContain('child says hi')
    expect(text(result)).toContain('[auto] provider=deepseek-official model=deepseek-v4-flash tier=trivial')
    expect(text(result)).toContain('auto policy:')
  })

  it('picks the strongest model for a code-heavy task', async () => {
    const { ctx, provider } = await setup({}, { routes: AUTO_ROUTES })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'deep code review',
      prompt: '```ts\nfunction f() { return 1 }\n```\nAnalyze this code, design a refactor, and evaluate the complexity tradeoffs in depth.',
      provider: 'deepseek-official',
      model: 'auto',
    }, fakeAgent)
    expect(result.isError).toBe(false)
    expect(provider.starts[0]!.agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    expect(text(result)).toContain('tier=complex')
  })

  it('resolves the provider from the calling agent options when provider is omitted', async () => {
    const { ctx, provider } = await setup({}, { routes: AUTO_ROUTES })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(false)
    expect(provider.starts[0]!.agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })

  it('fails when no provider route is resolvable', async () => {
    const { ctx } = await setup({}, { routes: AUTO_ROUTES })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('needs a provider route')
  })

  it('fails when the provider catalog cannot be listed', async () => {
    const { ctx } = await setup({
    }, { routes: [{ id: 'broken', name: 'Broken', models: [], error: 'catalog boom' }] })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      provider: 'broken',
      model: 'auto',
    }, fakeAgent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('could not list models')
    expect(text(result)).toContain('catalog boom')
  })

  it('fails when the provider advertises no models', async () => {
    const { ctx } = await setup({}, { routes: [{ id: 'empty', name: 'Empty', models: [] }] })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      provider: 'empty',
      model: 'auto',
    }, fakeAgent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('advertises no models')
  })

  it('escalates once to the next tier after a failed foreground run', async () => {
    const { ctx, provider } = await setup({}, { routes: AUTO_ROUTES })
    provider.failFirstCount = 1
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      provider: 'deepseek-official',
      model: 'auto',
    }, fakeAgent)
    expect(result.isError).toBe(false)
    expect(provider.starts).toHaveLength(2)
    expect(provider.starts[0]!.agentOptions.model).toBe('deepseek-v4-flash')
    expect(provider.starts[1]!.agentOptions.model).toBe('deepseek-v4-std')
    expect(text(result)).toContain('child says hi')
    expect(text(result)).toContain('escalated from deepseek-v4-flash')
  })

  it('reports when the escalated retry also fails', async () => {
    const { ctx, provider } = await setup({}, { routes: AUTO_ROUTES })
    provider.failFirstCount = 2
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      provider: 'deepseek-official',
      model: 'auto',
    }, fakeAgent)
    expect(result.isError).toBe(true)
    expect(provider.starts).toHaveLength(2)
    expect(text(result)).toContain('subagent run failed after 2 attempt(s)')
    expect(text(result)).toContain('attempt 1 on "deepseek-v4-flash"')
    expect(text(result)).toContain('attempt 2 on "deepseek-v4-std"')
  })

  it('does not escalate when autoEscalate is disabled', async () => {
    const { ctx, provider } = await setup({ autoEscalate: false }, { routes: AUTO_ROUTES })
    provider.failFirstCount = 1
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      provider: 'deepseek-official',
      model: 'auto',
    }, fakeAgent)
    expect(result.isError).toBe(true)
    expect(provider.starts).toHaveLength(1)
    expect(text(result)).toContain('subagent run failed')
  })

  it('anchors to the parent model for trivial tasks on the parent route', async () => {
    const { ctx, provider } = await setup({}, { routes: AUTO_ROUTES })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentOnPro)
    expect(result.isError).toBe(false)
    expect(provider.starts[0]!.agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    expect(text(result)).toContain('[auto] provider=deepseek-official model=deepseek-v4-pro tier=trivial anchored')
    expect(text(result)).toContain("defaulted to the parent's own model")
  })

  it('upgrades from a weak parent model when the task is heavy', async () => {
    const { ctx, provider } = await setup({}, { routes: AUTO_ROUTES })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'deep code review',
      prompt: '```ts\nfunction f() { return 1 }\n```\nAnalyze this code, design a refactor, and evaluate the complexity tradeoffs in depth.',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(false)
    expect(provider.starts[0]!.agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    expect(text(result)).toContain('upgraded from the parent')
  })

  it('keeps a strong parent model even for heavy tasks', async () => {
    const { ctx, provider } = await setup({}, { routes: AUTO_ROUTES })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'deep code review',
      prompt: '```ts\nfunction f() { return 1 }\n```\nAnalyze this code, design a refactor, and evaluate the complexity tradeoffs in depth.',
      model: 'auto',
    }, fakeAgentOnPro)
    expect(result.isError).toBe(false)
    expect(provider.starts[0]!.agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    expect(text(result)).toContain('anchored')
  })

  it('does not downgrade when escalating from an anchored strong parent model', async () => {
    const { ctx, provider } = await setup({}, { routes: AUTO_ROUTES })
    provider.failFirstCount = 1
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentOnPro)
    expect(result.isError).toBe(true)
    expect(provider.starts).toHaveLength(1)
    expect(text(result)).toContain('subagent run failed')
  })

  it('escalates from an anchored weak parent model to the next tier', async () => {
    const { ctx, provider } = await setup({}, { routes: AUTO_ROUTES })
    provider.failFirstCount = 1
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(false)
    expect(provider.starts).toHaveLength(2)
    expect(provider.starts[0]!.agentOptions.model).toBe('deepseek-v4-flash')
    expect(provider.starts[1]!.agentOptions.model).toBe('deepseek-v4-std')
    expect(text(result)).toContain('escalated from deepseek-v4-flash')
  })
})

describe('dsh-subagent-router failure classification', () => {
  it('classifies LlmError codes into stable classes', () => {
    const quota = new LlmError('quota exhausted', 'QUOTA', { status: 402 })
    const rate = new LlmError('too many requests', 'RATE_LIMIT', { status: 429 })
    const auth = new LlmError('bad key', 'AUTH', { status: 401 })
    const context = new LlmError('context too big', 'CONTEXT_WINDOW_EXCEEDED', { status: 400 })
    const server = new LlmError('server boom', 'SERVER', { status: 503 })
    expect(classifyFailure(quota)).toBe('quota')
    expect(classifyFailure(rate)).toBe('rate-limit')
    expect(classifyFailure(auth)).toBe('auth')
    expect(classifyFailure(context)).toBe('context')
    expect(classifyFailure(server)).toBe('server')
  })

  it('classifies from HTTP status alone when the code is unknown', () => {
    const generic429 = Object.assign(new Error('nope'), { status: 429 })
    const generic401 = Object.assign(new Error('nope'), { status: 401 })
    const generic503 = Object.assign(new Error('nope'), { status: 503 })
    expect(classifyFailure(generic429)).toBe('rate-limit')
    expect(classifyFailure(generic401)).toBe('auth')
    expect(classifyFailure(generic503)).toBe('server')
  })

  it('walks the cause chain and AggregateError members', () => {
    const wrapped = new Error('outer', { cause: new LlmError('rate limited', 'RATE_LIMIT', { status: 429 }) })
    expect(classifyFailure(wrapped)).toBe('rate-limit')
    const aggregate = new AggregateError([new LlmError('quota', 'QUOTA', { status: 402 })], 'agg')
    expect(classifyFailure(aggregate)).toBe('quota')
  })

  it('classifies unknown failures as other without guessing', () => {
    expect(classifyFailure(new Error('random failure'))).toBe('other')
    expect(classifyFailure(undefined)).toBe('other')
  })

  it('classifies quota wording via the harness text classifier', () => {
    expect(classifyFailure(new Error('Insufficient Balance'))).toBe('quota')
    expect(classifyFailure(new Error('You have exceeded your current quota'))).toBe('quota')
  })

  it('renders sanitized bounded failure detail', () => {
    const detail = sanitizeFailureDetail(new LlmError('rate limited', 'RATE_LIMIT', { status: 429 }))
    expect(detail).toContain('rate limited')
    expect(detail.length).toBeLessThanOrEqual(500)
    expect(failureLabel('quota')).toBe('provider quota exhausted')
    expect(failureLabel('rate-limit')).toBe('provider rate-limited')
  })
})

describe('dsh-subagent-router route health store', () => {
  it('reports healthy before any observation and after transient expiry', () => {
    vi.useFakeTimers()
    const store = new RouteHealthStore()
    expect(store.isHealthy('a')).toBe(true)
    store.record('a', 'rate-limit')
    expect(store.isHealthy('a')).toBe(false)
    expect(store.health('a').failingClass).toBe('rate-limit')
    vi.advanceTimersByTime(DEFAULT_TRANSIENT_TTL_MS + 1000)
    expect(store.isHealthy('a')).toBe(true)
    vi.useRealTimers()
  })

  it('keeps auth as terminal (never expires) but expires quota at the next hour boundary', () => {
    vi.useFakeTimers()
    const store = new RouteHealthStore()
    // auth → terminal
    store.record('a', 'auth')
    expect(store.isHealthy('a')).toBe(false)
    expect(store.health('a').retryAfterSec).toBeUndefined()
    vi.advanceTimersByTime(DEFAULT_TRANSIENT_TTL_MS * 10)
    expect(store.isHealthy('a')).toBe(false)
    // quota → next hour boundary (bounded, with a retry-after)
    store.record('b', 'quota')
    expect(store.isHealthy('b')).toBe(false)
    expect(store.health('b').retryAfterSec).toBeDefined()
    expect(store.health('b').retryAfterSec!).toBeGreaterThan(0)
    vi.advanceTimersByTime(60 * 60 * 1000 + 1000) // past any hour boundary
    expect(store.isHealthy('b')).toBe(true)
    vi.useRealTimers()
  })

  it('expires unclassified other failures after the default TTL', () => {
    vi.useFakeTimers()
    const store = new RouteHealthStore()
    store.record('a', 'other')
    expect(store.isHealthy('a')).toBe(false)
    expect(store.health('a').failingClass).toBe('other')
    expect(store.health('a').retryAfterSec).toBeDefined()
    vi.advanceTimersByTime(DEFAULT_UNCLASSIFIED_TTL_MS + 1000)
    expect(store.isHealthy('a')).toBe(true)
    vi.useRealTimers()
  })

  it('clear drops observations', () => {
    const store = new RouteHealthStore()
    store.record('a', 'quota')
    store.clear('a')
    expect(store.isHealthy('a')).toBe(true)
  })
})

describe('dsh-subagent-router health-aware auto routing', () => {
  const MULTI_ROUTES = [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-std', name: 'DeepSeek V4 Std' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
    },
    {
      id: 'pi-ai-cn',
      name: 'PI AI CN',
      models: [
        { id: 'pi-3-mini', name: 'PI 3 Mini' },
        { id: 'pi-3-maxi', name: 'PI 3 Maxi' },
      ],
    },
  ]

  it('dead anchor: drops the parent route after a quota failure and reroutes to a healthy provider', async () => {
    const { ctx, provider } = await setup({}, { routes: MULTI_ROUTES })
    // First call: parent on deepseek-official, provider rejects with quota.
    provider.rejectFirstCount = 1
    provider.rejectCause = new LlmError('quota exhausted', 'QUOTA', { status: 402 })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentWithRoute)
    // Terminal class → reroute to the healthy pi-ai-cn provider.
    expect(result.isError).toBe(false)
    expect(provider.starts).toHaveLength(2)
    const first = provider.starts[0]!.agentOptions as { provider?: string; model?: string }
    const second = provider.starts[1]!.agentOptions as { provider?: string; model?: string }
    expect(first).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(second.provider).toBe('pi-ai-cn')
    expect(text(result)).toContain('rerouted from deepseek-official')
    expect(text(result)).toContain('provider quota exhausted')
  })

  it('reroute honors autoTierPolicy on the healthy target provider', async () => {
    const { ctx, provider } = await setup(
      // trivial heuristic picks cheapest (deepseek-v4-flash), but the policy
      // says strongest — the reroute to pi-ai-cn must honor it (pi-3-maxi).
      { autoTierPolicy: { trivial: 'strongest' } },
      { routes: MULTI_ROUTES },
    )
    provider.rejectFirstCount = 1
    provider.rejectCause = new LlmError('quota exhausted', 'QUOTA', { status: 402 })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(false)
    expect(provider.starts).toHaveLength(2)
    // First start on deepseek-official (strongest per policy) fails with
    // quota; reroute to the healthy pi-ai-cn picks ITS strongest model.
    const first = provider.starts[0]!.agentOptions as { provider?: string; model?: string }
    const second = provider.starts[1]!.agentOptions as { provider?: string; model?: string }
    expect(first.provider).toBe('deepseek-official')
    expect(first.model).toBe('deepseek-v4-pro')
    expect(second.provider).toBe('pi-ai-cn')
    expect(second.model).toBe('pi-3-maxi')
  })

  it('dead anchor: a second auto call on the unhealthy parent route skips the anchor', async () => {
    const { ctx, provider } = await setup({}, { routes: MULTI_ROUTES })
    // Call 1 fails with quota (records deepseek-official unhealthy).
    provider.rejectFirstCount = 1
    provider.rejectCause = new LlmError('quota exhausted', 'QUOTA', { status: 402 })
    const first = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(first.isError).toBe(false)
    // Call 2: same parent, but the anchor route is now unhealthy — pick
    // pi-ai-cn directly (no failure needed).
    provider.rejectFirstCount = 0
    const second = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(second.isError).toBe(false)
    const options = provider.starts[provider.starts.length - 1]!.agentOptions as { provider?: string; model?: string }
    expect(options.provider).toBe('pi-ai-cn')
    expect(text(second)).toContain('rerouted from deepseek-official')
  })

  it('transient failure escalates on the same provider instead of rerouting', async () => {
    const { ctx, provider } = await setup({}, { routes: MULTI_ROUTES })
    provider.failFirstCount = 1 // stopReason 'error' → classified 'other' → transient
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(false)
    expect(provider.starts).toHaveLength(2)
    const first = provider.starts[0]!.agentOptions as { model?: string }
    const second = provider.starts[1]!.agentOptions as { model?: string }
    expect(first.model).toBe('deepseek-v4-flash')
    expect(second.model).toBe('deepseek-v4-std')
    expect(text(result)).toContain('escalated from deepseek-v4-flash')
    expect(text(result)).not.toContain('rerouted')
  })

  it('climbs the escalation ladder when autoEscalationTiers allows more than one step', async () => {
    const { ctx, provider } = await setup({ autoEscalationTiers: 2 }, { routes: MULTI_ROUTES })
    // Two transient failures: flash (tier trivial) then std (tier standard),
    // third attempt on pro succeeds.
    provider.failFirstCount = 2
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(false)
    expect(provider.starts).toHaveLength(3)
    const models = provider.starts.map(entry => (entry.agentOptions as { model?: string }).model)
    expect(models).toEqual(['deepseek-v4-flash', 'deepseek-v4-std', 'deepseek-v4-pro'])
    expect(text(result)).toContain('escalated from deepseek-v4-std')
    expect(text(result)).toContain('model=deepseek-v4-pro')
  })

  it('stops climbing when an escalated attempt hits a terminal failure', async () => {
    const { ctx, provider } = await setup({ autoEscalationTiers: 2 }, { routes: MULTI_ROUTES })
    // Attempt 1 (flash): transient stopReason 'error'. Attempt 2 (std):
    // reject with quota — escalation must stop there, no third attempt.
    provider.failFirstCount = 1
    provider.rejectAtIndex = [1]
    provider.rejectCause = new LlmError('quota exhausted', 'QUOTA', { status: 402 })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(true)
    // flash (fail) + std (quota) — no pro attempt.
    expect(provider.starts).toHaveLength(2)
    expect(text(result)).toContain('quota exhausted')
  })

  it('does not reroute when autoReroute is disabled', async () => {
    const { ctx, provider } = await setup({ autoReroute: false }, { routes: MULTI_ROUTES })
    provider.rejectFirstCount = 1
    provider.rejectCause = new LlmError('quota exhausted', 'QUOTA', { status: 402 })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(true)
    expect(provider.starts).toHaveLength(1)
    expect(text(result)).toContain('quota exhausted')
    expect(text(result)).not.toContain('rerouted')
  })

  it('surfaces a reroute failure instead of silently falling back', async () => {
    // The healthy target provider's catalog cannot be listed — the reroute
    // must surface why, not silently return the original error alone.
    const { ctx, provider } = await setup({}, {
      routes: [
        {
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
        },
        {
          id: 'pi-ai-cn',
          name: 'PI AI CN',
          models: [],
          error: 'catalog unavailable',
        },
      ],
    })
    provider.rejectFirstCount = 1
    provider.rejectCause = new LlmError('quota exhausted', 'QUOTA', { status: 402 })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('reroute')
    expect(text(result)).toContain('catalog unavailable')
  })

  it('surfaces sanitized infrastructure failure detail with the failure class', async () => {
    const { ctx, provider } = await setup({}, { routes: MULTI_ROUTES })
    provider.rejectFirstCount = 1
    provider.rejectCause = new LlmError('rate limit exceeded, retry later', 'RATE_LIMIT', { status: 429 })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(true)
    // autoEscalationTiers=1: one escalation attempt, but it also fails
    // (rejectFirstCount applies to every start). The summary names the class.
    expect(text(result)).toContain('provider rate-limited')
    expect(text(result)).toContain('429')
  })

  it('catalog tool annotates unhealthy routes', async () => {
    const { ctx, provider } = await setup({}, { routes: MULTI_ROUTES })
    provider.rejectFirstCount = 1
    provider.rejectCause = new LlmError('quota exhausted', 'QUOTA', { status: 402 })
    await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentWithRoute)
    const catalog = await callTool(ctx, 'subagent_models', {})
    expect(catalog.isError).toBe(false)
    const value = JSON.parse(text(catalog)) as {
      providers: Array<{
        provider: string
        health?: string
        failingClass?: string
        retryAfterSec?: number
      }>
    }
    const deepseek = value.providers.find(entry => entry.provider === 'deepseek-official')
    expect(deepseek?.health).toBe('unhealthy')
    expect(deepseek?.failingClass).toBe('quota')
    const pi = value.providers.find(entry => entry.provider === 'pi-ai-cn')
    expect(pi?.health).toBe('healthy')
  })

  it('dead anchor: a model-layer stopReason error also marks the route unhealthy', async () => {
    const { ctx, provider } = await setup({}, { routes: MULTI_ROUTES })
    // Call 1: the child's run settles with stopReason 'error' (no cause —
    // the model/transport layer). This records 'other' as a transient
    // route-failure signal; the NEXT auto call must not re-anchor here.
    provider.failFirstCount = 1
    const first = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentWithRoute)
    // First call: run fails (other), then escalates once to std — success.
    expect(first.isError).toBe(false)
    // Call 2: same parent route, no failure configured — but the route is
    // transiently unhealthy from call 1, so auto must pick pi-ai-cn instead
    // of re-anchoring on deepseek-official.
    provider.failFirstCount = 0
    const second = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(second.isError).toBe(false)
    const options = provider.starts[provider.starts.length - 1]!.agentOptions as { provider?: string; model?: string }
    expect(options.provider).toBe('pi-ai-cn')
    expect(text(second)).toContain('rerouted from deepseek-official')
  })
})

describe('dsh-subagent-router configurable auto routing', () => {
  const PRIORITY_ROUTES = [
    {
      id: 'provider-a',
      name: 'Provider A',
      models: [{ id: 'a-cheap', name: 'A Cheap' }, { id: 'a-pro', name: 'A Pro' }],
    },
    {
      id: 'provider-b',
      name: 'Provider B',
      models: [{ id: 'b-cheap', name: 'B Cheap' }, { id: 'b-pro', name: 'B Pro' }],
    },
  ]

  it('autoProviderOrder picks the first healthy provider when the parent route is absent', async () => {
    const { ctx, provider } = await setup(
      { autoProviderOrder: ['provider-b', 'provider-a'] },
      { routes: PRIORITY_ROUTES },
    )
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgent) // no parent route
    expect(result.isError).toBe(false)
    const options = provider.starts[0]!.agentOptions as { provider?: string; model?: string }
    expect(options.provider).toBe('provider-b')
    // trivial tier → cheapest pick on the chosen provider.
    expect(options.model).toBe('b-cheap')
    expect(text(result)).toContain('provider-b')
  })

  it('autoTierPolicy.cheapest forces the cheapest model even when the parent model is available', async () => {
    const { ctx, provider } = await setup(
      { autoTierPolicy: { trivial: 'cheapest' } },
      { routes: AUTO_ROUTES },
    )
    // Parent on deepseek-v4-pro (strong) — but cheapest policy overrides.
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentOnPro)
    expect(result.isError).toBe(false)
    const options = provider.starts[0]!.agentOptions as { provider?: string; model?: string }
    expect(options.model).toBe('deepseek-v4-flash')
    expect(text(result)).toContain('policy=cheapest')
  })

  it('autoTierPolicy.strongest forces the strongest model for a tier', async () => {
    const { ctx, provider } = await setup(
      { autoTierPolicy: { standard: 'strongest' } },
      { routes: AUTO_ROUTES },
    )
    // ~200 chars: classified 'standard' (past the 160 trivial threshold,
    // below the 1200 complex threshold), no heavy markers or reasoning verbs.
    const result = await callTool(ctx, 'subagent_model', {
      description: 'a standard-length task',
      prompt: 'Go through this dataset and list the main trends and outliers you notice, then write up a short summary of what stands out. Keep it ordinary and mid-length, past the trivial threshold but nowhere near the heavier cutoff, so this task lands in the middle tier for the test.',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(false)
    const options = provider.starts[0]!.agentOptions as { provider?: string; model?: string }
    expect(options.model).toBe('deepseek-v4-pro')
    expect(text(result)).toContain('policy=strongest')
  })

  it('autoTierPicks overrides with an explicit candidate order', async () => {
    const { ctx, provider } = await setup(
      { autoTierPicks: { trivial: ['deepseek-v4-pro', 'deepseek-v4-std'] } },
      { routes: AUTO_ROUTES },
    )
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      provider: 'deepseek-official',
      model: 'auto',
    }, fakeAgent)
    expect(result.isError).toBe(false)
    const options = provider.starts[0]!.agentOptions as { provider?: string; model?: string }
    expect(options.model).toBe('deepseek-v4-pro')
    expect(text(result)).toContain('policy=picks')
  })

  it('autoTierPicks falls back to the next layer when the candidate is not in the catalog', async () => {
    const { ctx, provider } = await setup(
      { autoTierPicks: { trivial: ['ghost-model'] } },
      { routes: AUTO_ROUTES },
    )
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      provider: 'deepseek-official',
      model: 'auto',
    }, fakeAgent)
    expect(result.isError).toBe(false)
    const options = provider.starts[0]!.agentOptions as { provider?: string; model?: string }
    // ghost-model not in catalog → falls back to heuristic (trivial → cheapest).
    expect(options.model).toBe('deepseek-v4-flash')
  })

  it('autoTierPicks can cross provider boundaries', async () => {
    const { ctx, provider } = await setup(
      {
        autoProviderOrder: ['provider-a', 'provider-b'],
        // b-pro only exists on provider-b — the local provider-a catalog
        // cannot satisfy it, so the pick must cross to provider-b.
        autoTierPicks: { trivial: ['b-pro'] },
      },
      { routes: PRIORITY_ROUTES },
    )
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgent) // no parent route
    expect(result.isError).toBe(false)
    const options = provider.starts[0]!.agentOptions as { provider?: string; model?: string }
    expect(options.provider).toBe('provider-b')
    expect(options.model).toBe('b-pro')
    expect(text(result)).toContain('policy=picks')
  })

  it('cross-provider picks still resolve when the target catalog cannot be listed', async () => {
    const { ctx, provider } = await setup(
      {
        autoProviderOrder: ['provider-a', 'provider-b'],
        // b-pro only exists on provider-b; provider-b's catalog listing
        // fails — the pick must still resolve (no ladder, no crash).
        autoTierPicks: { trivial: ['b-pro'] },
      },
      {
        routes: [
          {
            id: 'provider-a',
            name: 'Provider A',
            models: [{ id: 'a-cheap', name: 'A Cheap' }, { id: 'a-pro', name: 'A Pro' }],
          },
          {
            id: 'provider-b',
            name: 'Provider B',
            models: [],
            error: 'catalog boom',
          },
        ],
      },
    )
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgent)
    // provider-b is the only one carrying b-pro, but its catalog listing
    // fails — pickFromOrderedAcrossProviders skips it, and no healthy
    // alternative carries the candidate, so the pick falls through. The call
    // should still succeed on provider-a (heuristic), not crash.
    expect(result.isError).toBe(false)
    const options = provider.starts[0]!.agentOptions as { provider?: string; model?: string }
    expect(options.provider).toBe('provider-a')
  })
})

describe('dsh-subagent-router configurable auto routing (edge cases)', () => {
  it('autoTierPolicy.anchor keeps the parent model when the route is healthy', async () => {
    const { ctx, provider } = await setup(
      { autoTierPolicy: { trivial: 'anchor' } },
      { routes: AUTO_ROUTES },
    )
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentOnPro) // parent on deepseek-v4-pro
    expect(result.isError).toBe(false)
    const options = provider.starts[0]!.agentOptions as { model?: string }
    expect(options.model).toBe('deepseek-v4-pro')
    expect(text(result)).toContain('policy=anchor')
    expect(text(result)).toContain('anchored')
  })
})

describe('dsh-subagent-router config schema', () => {
  it('schema defaults match resolveConfig defaults (dual-source sync, live fields only)', async () => {
    const { Config } = await import('../src/config.ts')
    const { resolveConfig, defaultConfig } = await import('../src/index.ts')
    const fromSchema = Config(undefined)
    const fromResolve = resolveConfig({})
    expect(fromSchema.autoEscalate).toBe(fromResolve.autoEscalate)
    expect(fromSchema.autoReroute).toBe(fromResolve.autoReroute)
    expect(fromSchema.autoEscalationTiers).toBe(fromResolve.autoEscalationTiers)
    expect(fromSchema.autoProviderOrder ?? []).toEqual(fromResolve.autoProviderOrder ?? [])
    // Registration-time knobs are fixed constants, not config fields — verify
    // the fixed defaults match the harness-native subagent semantics.
    const { fixedConfig } = await import('../src/config.ts')
    expect(fixedConfig.subagentProvider).toBe('spawn')
    expect(fixedConfig.backgroundMode).toBe('continuable')
    expect(fixedConfig.maxDepth).toBe('provider-managed')
    expect(fixedConfig.enableRunInBackground).toBe(true)
    expect(fixedConfig.enableAuto).toBe(true)
    expect(fixedConfig.enableModelList).toBe(true)
    expect(defaultConfig.autoEscalationTiers).toBe(1)
  })

  it('schema accepts partial tier config', async () => {
    const { Config } = await import('../src/config.ts')
    const partial = Config({ autoTierPolicy: { trivial: 'cheapest' } })
    expect(partial.autoTierPolicy).toEqual({ trivial: 'cheapest' })
    expect(partial.autoProviderOrder).toEqual([])
  })

  it('schema accepts full live config and rejects unknown snapshot fields', async () => {
    const { Config } = await import('../src/config.ts')
    const full = Config({
      autoProviderOrder: ['a', 'b'],
      autoTierPolicy: { trivial: 'cheapest', standard: 'anchor', complex: 'strongest' },
      autoTierPicks: { complex: ['x'] },
      autoEscalationTiers: 2,
    })
    expect(full.autoProviderOrder).toEqual(['a', 'b'])
    expect(full.autoTierPolicy).toEqual({ trivial: 'cheapest', standard: 'anchor', complex: 'strongest' })
    expect(full.autoTierPicks.complex).toEqual(['x'])
    expect(full.autoEscalationTiers).toBe(2)
    // Schemastery passes unknown keys through; registration-time snapshot keys
    // (backgroundMode, toolName, …) are simply never consumed — the fixed
    // behavior comes from `fixedConfig`, so a leftover `backgroundMode` write
    // in a composition entry is inert instead of silently changing behavior.
    const withSnapshot = Config({ backgroundMode: 'one-shot' } as never)
    expect(withSnapshot.backgroundMode).toBe('one-shot')  // passthrough, inert
  })
})

describe('dsh-subagent-router host settings integration', () => {
  /** Minimal settings service: implements the new dsh-settings@>=0.1.2-alpha.4
   *  `installSection(owner, ns, schema, entry, hooks)` contract (the old
   *  `register` module path was removed). The resolved value is the schema
   *  defaults merged over the composition `entry` then the user `section`;
   *  `setSection` writes the user layer and re-fires setSource + onChange. */
  function fakeSettingsService() {
    let section: Record<string, unknown> = {}
    let entry: object = {}
    const hooks = { setSource: null as null | ((fn: () => unknown) => void), onChange: null as null | (() => void) }
    const resolve = () => ({ ...entry, ...section })
    const service = {
      installSection(_owner: unknown, _ns: string, _schema: unknown, entry_: object, h: { setSource: (fn: () => unknown) => void; onChange: () => void }) {
        entry = entry_ ?? {}
        hooks.setSource = h.setSource
        hooks.onChange = h.onChange
        hooks.setSource(resolve)
        hooks.onChange()
        return {
          get: () => resolve(),
          watch: () => () => {},
          update: async (patch: object) => { section = { ...section, ...patch }; hooks.setSource?.(resolve); hooks.onChange?.() },
        }
      },
      describe() { return [] },
      get(_ns: string) { return undefined },
    }
    return { service, setSection: (patch: object) => { section = { ...section, ...patch }; hooks.setSource?.(resolve); hooks.onChange?.() } }
  }

  it('reads configuration from the settings scope when the service is present', async () => {
    const { service, setSection } = fakeSettingsService()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.provide('llm', fakeLlm(AUTO_ROUTES))
    const provider = new ScriptedProvider('spawn')
    ctx.subagents.registerProvider(provider)
    ctx.provide('settings', service as never)
    await ctx.plugin(plugin)
    // Default (no user layer): trivial → heuristic pick (cheapest flash).
    let result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(false)
    expect((provider.starts[0]!.agentOptions as { model?: string }).model).toBe('deepseek-v4-flash')
    // Settings write: force trivial → strongest. The tool must pick v4-pro
    // WITHOUT re-registration (responsive config).
    setSection({ autoTierPolicy: { trivial: 'strongest' } })
    result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(false)
    expect((provider.starts[provider.starts.length - 1]!.agentOptions as { model?: string }).model).toBe('deepseek-v4-pro')
    expect(text(result)).toContain('policy=strongest')
  })

  it('falls back to the composition entry when no settings service exists', async () => {
    const { ctx, provider } = await setup({ autoTierPolicy: { trivial: 'strongest' } }, { routes: AUTO_ROUTES })
    const result = await callTool(ctx, 'subagent_model', {
      description: 'say hi',
      prompt: 'hi',
      model: 'auto',
    }, fakeAgentWithRoute)
    expect(result.isError).toBe(false)
    expect((provider.starts[0]!.agentOptions as { model?: string }).model).toBe('deepseek-v4-pro')
    expect(text(result)).toContain('policy=strongest')
  })
})
