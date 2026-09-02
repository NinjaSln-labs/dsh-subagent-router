/**
 * dsh-subagent-router — mount smoke test.
 *
 * Mounts the built plugin the way the harness LOADER does (cordis-plugin-loader
 * unwrapExports: `module.default ?? module`, then `ctx.plugin(...)`) and
 * verifies the wiring: the three tools register, and a live handler run on the
 * read-only `subagent_models` catalog tool works against a stubbed `llm`.
 *
 * Regression guard: the plugin default export MUST be an object with `apply`
 * (loader pitfall — a factory function default is called as the plugin body
 * and its returned `{ apply }` is silently ignored: no error, entry ACTIVE,
 * apply never runs). If apply does not run, the registrations below stay
 * empty → this test fails.
 *
 *   npm run build && node scripts/mount.mjs
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'

const registrations = { tools: [], routes: [] }

const ctx = new Context()
ctx.provide('tools', {
  register: tool => {
    registrations.tools.push(tool)
    return () => {}
  },
  get: name => registrations.tools.find(tool => tool.name === name),
})
// The subagent provider is fixed to `spawn` (fixedConfig.subagentProvider);
// mount registers the delegation tool only after a provider under that name
// appears. Scripted stub mirrors the in-tree test provider (ScriptedProvider).
const provider = {
  name: 'spawn',
  inheritsParentContext: false,
  capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
  prepareContinuable: async () => ({ childId: 'cont-spawn' }),
  startContinuable: spec => ({ childId: spec.childId }),
}
ctx.provide('subagents', {
  getProvider: name => (name === 'spawn' ? provider : undefined),
})
ctx.provide('systemPrompt', { section: () => {} })
// webServer stub captures the catalog RPC route so this test can drive it.
ctx.provide('webServer', {
  register: route => {
    registrations.routes.push(route)
    return () => {}
  },
})
// Stub llm: two provider routes, one of which advertises a strong model — so
// the `subagent_models` catalog tool has real data to render.
ctx.provide('llm', {
  listProviders: () => [
    { id: 'deepseek-official', name: 'DeepSeek Official' },
    { id: 'pi-ai-cn', name: 'Pi-AI CN' },
  ],
  listModels: async id => {
    if (id === 'deepseek-official') {
      return [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ]
    }
    if (id === 'pi-ai-cn') return [{ id: 'pi-3-maxi', name: 'Pi 3 Maxi' }]
    throw new Error(`no route "${id}"`)
  },
})

// The exact loader normalization path (cordis-plugin-loader unwrapExports).
const mod = await import('../lib/index.js')
const plugin = mod.default ?? mod
assert.equal(typeof plugin, 'object', 'plugin must be an OBJECT, not a factory function')
assert.equal(typeof plugin.apply, 'function', 'plugin object must carry apply')
assert.equal(plugin.name, 'dsh-subagent-router')
assert.ok(plugin.Config, 'plugin object must carry Config')

await ctx.plugin(plugin).await()
// Let the ctx.inject children and provider-mount wiring settle.
await new Promise(resolve => setTimeout(resolve, 50))

try {
  // 1) apply RAN (the loader-pitfall guard): the three tools registered.
  const names = registrations.tools.map(tool => tool.name)
  assert.ok(names.includes('subagent_model'), `subagent_model registered (apply ran), got: ${names.join(', ') || '(none)'}`)
  assert.ok(names.includes('subagent_models'), `subagent_models registered, got: ${names.join(', ') || '(none)'}`)
  assert.ok(names.includes('subagent_recommend'), `subagent_recommend registered, got: ${names.join(', ') || '(none)'}`)
  console.log('  ok  apply ran: subagent_model / subagent_models / subagent_recommend registered')

  // 2) read-only catalog tool runs against the stubbed llm.
  const catalogTool = registrations.tools.find(tool => tool.name === 'subagent_models')
  const value = await catalogTool.execute({}, {
    agent: { id: 'parent-1', session: { header: {} } },
    signal: new AbortController().signal,
  })
  assert.equal(Array.isArray(value.providers), true)
  assert.equal(value.providers.length, 2, 'catalog lists both provider routes')
  assert.equal(value.providers[0].provider, 'deepseek-official')
  assert.equal(value.providers[0].models.length, 2)
  assert.equal(value.providers[1].provider, 'pi-ai-cn')
  assert.equal(value.providers[1].models[0].id, 'pi-3-maxi')
  console.log('  ok  subagent_models catalog tool execute runs against the stub llm')

  // 3) unknown-provider narrowing reports the registered routes.
  const unknown = await catalogTool.execute({ provider: 'nope' }, {
    agent: { id: 'parent-1', session: { header: {} } },
    signal: new AbortController().signal,
  })
  assert.equal(unknown.providers.length, 0)
  assert.ok(String(unknown.note).includes('deepseek-official'))
  console.log('  ok  unknown provider narrowing reports the registered routes')

  // 4) the config-panel catalog RPC route is registered and serves the same
  // provider+model directory over the webServer seam (fix: the panel no longer
  // depends on a non-existent `llm.models` Remote).
  const catalogRoute = registrations.routes.find(r => r.path === '/subagent-router-rpc')
  assert.ok(catalogRoute, 'catalog RPC route registered')
  assert.equal(catalogRoute.kind, 'exact')
  const res = { status: null, body: null, writeHead(s, h) { this.status = s; this.headers = h }, end(b) { this.body = b } }
  const req = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
  }
  req[Symbol.asyncIterator] = async function* () { yield JSON.stringify({ method: 'catalog' }) }
  await catalogRoute.handler(req, res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.ok, true)
  const groups = payload.result.groups
  assert.equal(groups.length, 2, 'catalog RPC lists both provider routes')
  assert.equal(groups[0].id, 'deepseek-official')
  assert.equal(groups[0].models.length, 2)
  assert.equal(groups[1].id, 'pi-ai-cn')
  assert.equal(groups[1].models[0].id, 'pi-3-maxi')
  console.log('  ok  /subagent-router-rpc catalog route serves the provider/model directory')

  // 5) non-loopback peer is refused (fail-closed).
  const evil = { status: null, body: null, writeHead(s) { this.status = s }, end(b) { this.body = b } }
  const evilReq = { method: 'POST', socket: { remoteAddress: '203.0.113.5' }, headers: { host: 'evil.com' } }
  evilReq[Symbol.asyncIterator] = async function* () { yield '{}' }
  await catalogRoute.handler(evilReq, evil)
  assert.equal(evil.status, 403, 'non-loopback catalog RPC is refused')
  console.log('  ok  catalog RPC refuses non-loopback peers')

  console.log('\nmount smoke passed')
  process.exit(0)
} catch (err) {
  console.error('mount smoke FAILED')
  console.error(err)
  process.exit(1)
}
