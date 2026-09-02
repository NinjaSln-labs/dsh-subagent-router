/**
 * dsh-subagent-router — Host-side model-directory RPC.
 *
 * The browser config panel needs the live provider routes + their model
 * catalogs to populate the 提供方优先级 (autoProviderOrder) and 分档候选模型
 * (autoTierPicks) pickers. A bundle client cannot call the host `llm` service
 * directly (the host exposes only listProviders / listConfigurableProviders /
 * discoverModels as Remotes — there is no bulk "providers with models" Remote),
 * so this host half aggregates the directory itself and serves it over the
 * same webServer route seam dsh-context-compass / dsh-imgdraw established:
 *
 *   POST /subagent-router-rpc  { method: 'catalog' }
 *   → { ok: true, result: { groups: [{ id, name, models: [{ id, name }] }] } }
 *
 * Loopback-only (the directory is private to this machine); 405 on non-POST,
 * 403 on non-loopback peers, 400 on malformed JSON / unknown method.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Route this half registers on the host webServer. */
export const CATALOG_RPC_PATH = '/subagent-router-rpc'

/** Catalog entry the client pickers render from. */
export interface CatalogGroup {
  id: string
  name: string
  models: Array<{ id: string; name: string }>
}

/** Register the catalog RPC route; disposed with the caller's fiber. */
export function registerCatalogRpc(ctx: Context): () => void {
  let dispose: (() => void) | undefined
  ctx.inject(['webServer'], (wsCtx) => {
    const webServer = (wsCtx as unknown as {
      webServer: { register(route: unknown): () => void }
    }).webServer
    const d = webServer.register({
      kind: 'exact',
      path: CATALOG_RPC_PATH,
      handler: (req: IncomingMessage, res: ServerResponse) => handleCatalogRpc(req, res, wsCtx),
    })
    dispose = () => { try { d() } catch { /* ignore */ } }
  })
  return () => { try { dispose?.() } catch { /* ignore */ } }
}

/** Loopback-only guard: the model directory stays on the machine. */
function isLoopback(req: IncomingMessage): boolean {
  const addr = (req.socket as { remoteAddress?: string } | undefined)?.remoteAddress
  if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') return false
  const host = String(req.headers?.host ?? '')
  return /^(127\.0\.0\.1|\[::1\]|::1|localhost)(:\d+)?$/i.test(host)
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

const MAX_BODY_BYTES = 16 * 1024

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('request body too large'), { status: 413 })
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** The `llm` service faces this half reads. */
type LlmFace = {
  listProviders(): Array<{ id: string; name: string }>
  listModels(provider: string): Promise<Array<{ id: string; name: string }>>
}

async function handleCatalogRpc(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'POST only' })
    return
  }
  if (!isLoopback(req)) {
    sendJson(res, 403, { ok: false, error: 'loopback only' })
    return
  }
  let call: { method?: string }
  try {
    call = JSON.parse(await readBody(req)) as { method?: string }
  } catch (e) {
    const status = e instanceof Error && (e as { status?: number }).status === 413 ? 413 : 400
    sendJson(res, status, { ok: false, error: status === 413 ? 'request body too large' : 'invalid json' })
    return
  }
  if (call.method !== 'catalog') {
    sendJson(res, 400, { ok: false, error: `unknown method: ${String(call.method)}` })
    return
  }
  const llm = ctx.get('llm') as LlmFace | undefined
  if (llm === undefined) {
    sendJson(res, 200, { ok: true, result: { groups: [] } })
    return
  }
  const groups: CatalogGroup[] = []
  for (const provider of llm.listProviders()) {
    let models: Array<{ id: string; name: string }> = []
    try {
      models = await llm.listModels(provider.id)
    } catch { /* a provider that cannot list models still appears with an empty catalog */ }
    groups.push({ id: provider.id, name: provider.name, models })
  }
  sendJson(res, 200, { ok: true, result: { groups } })
}
