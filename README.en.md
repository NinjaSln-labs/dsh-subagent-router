# dsh-subagent-router

[简体中文](README.md) | English

[![npm version](https://img.shields.io/npm/v/dsh-subagent-router)](https://www.npmjs.com/package/dsh-subagent-router)
[![GitHub stars](https://img.shields.io/github/stars/NinjaSln-labs/dsh-subagent-router?style=social)](https://github.com/NinjaSln-labs/dsh-subagent-router)

Model-routed subagent delegation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The shipped `subagent` tool inherits the parent's model route; this plugin adds a sibling tool that lets the delegating model pick the child's LLM **provider**, **model**, and **output cap** per call (or hand the choice to the built-in `model: "auto"` routing policy) — while everything else about the delegation (depth accounting, delegation policy, continuable background children, results) stays exactly on the standard `ctx.subagents` seam.

## Tools

| Tool | Purpose |
|---|---|
| `subagent_model` | Delegate a task to a subagent with per-call `provider` / `model` / `max_tokens`. Omitted fields inherit the calling agent's route. Pass `model: "auto"` to delegate model choice to the built-in auto policy. |
| `subagent_models` | Read-only catalog of the live LLM provider routes (`ctx.llm.listProviders()`) and each provider's advertised model listing, annotated per model with derived metadata (`cost` tier / `speed` tier / `strength` tier / `specialty` / `contextWindow` for known ids) plus each route's `health` status. |
| `subagent_recommend` | Intelligent recommendation: a task description → a ranked provider/model suggestion (top-n, default 3). Prefers a one-shot lightweight LLM classifier (`ctx.llm.stream()`, anchored to the parent model with multi-candidate retry) over a bounded **selection scope** (≤12 = cheapest/medium/strong/best × 3, version-normalized, deduped by provider priority); a classifier fault degrades to the naming heuristic with a reason. The result carries `recommended` (the system default pick) and `tier`. |

### How model selection works

- **`provider`** is hard-validated against the routes registered on `ctx.llm` (e.g. `deepseek-official`, or any pi-ai route your settings declare). An unknown route fails immediately with the list of registered ones.
- **`model`** is passed through untouched. The harness treats model catalogs as advisory: the DeepSeek adapter accepts arbitrary model ids, while a pi-ai route rejects models its profile does not configure — so the provider itself owns model rejection, exactly as it does for your own session. `subagent_models` exists to make an informed choice possible.
- **`max_tokens`** caps the child's output (positive integer), forwarded as `agentOptions.maxTokens`.
- The child is created through `ctx.subagents.start()` / `startContinuable()` with `agentOptions = { provider, model, maxTokens }`. `resolveChildAgentOptions` in the harness merges per-child overrides over the parent's route, so an omitted field inherits.

### Auto selection (`model: "auto"`)

Delegating model choice to a deterministic, auditable policy — no extra LLM calls:

1. **Resolve the provider**: the explicit `provider` argument, else the calling agent's own route (`parent.options.provider`). Requires the `llm` service.
2. **Classify the task** into a tier: `trivial` (short task, ≤160 chars, no heavy markers), `complex` (≥1200 chars, or code fences / structured-output asks / reasoning verbs like analyze, design, debug, refactor, evaluate), else `standard`.
3. **Anchor to the parent by default**: when the calling agent's options name a model on the resolved provider, that model is the choice — for `trivial`/`standard` tasks always, and for `complex` tasks when it already scores as a strong model (`pro` / `max` / `reason` / `think` / `ultra` / `code` / `turbo` / `large` / `deep`). Only two situations fall back to catalog picks (naming score: strong signals +1, cheap signals `flash`/`mini`/`lite`/`fast`/`small`/`quick`/`nano`/`light` −1; `trivial` takes the lowest, `complex` the highest, `standard` the first neutral): the parent names no model, or the task is `complex` and the parent's model is not a strong one (then the strongest catalog model is picked). An explicit `provider` that differs from the parent's route also drops the anchor (the parent's model no longer belongs to that group).
4. **Audit**: every auto call records `auto: { provider, model, tier, reason, anchored?, escalatedFrom?, reroutedFrom?, rerouteReason? }` on the tool result, and the rendered text carries a `[auto]` line (with an `anchored` mark when the parent's own model was kept) — you can always ask why that model.
5. **Failure recovery** (foreground calls only):
   - **Transient-failure escalation** (`autoEscalate` + `autoEscalationTiers`): on `rate-limit` / `server` / `timeout` / `transport` / unclassified failures, retry with the next tier up (`trivial → standard → complex`, at most `autoEscalationTiers` times, default 1) — but only when that pick scores **strictly stronger** than the current choice, so escalation never downgrades an anchored strong parent model. The retry result reports `escalatedFrom`. Background/continuable calls skip escalation (the failure is not visible to the call site).
   - **Terminal-failure reroute** (`autoReroute`): on `quota` / `auth` (quota exhausted / broken credentials), retrying the same provider is pointless — the child reroutes to the first healthy provider route in the catalog (`reroutedFrom` + `rerouteReason`). Escalation stops on that provider when an escalated attempt hits a terminal failure too.
6. **Health-aware dead-anchor detection**: the plugin tracks per-provider failure classes in-session. Once the parent's route is judged unhealthy, later `model: "auto"` calls **drop the anchor** and pick a healthy provider instead — children are no longer pinned to a broken route. Expiry is **per failure kind**: `auth` terminal (never expires) · model-not-found 24h · `rate-limit` uses retry-after (else ~35s, RPM assumed) · `quota` next hour boundary · `server`/`timeout`/`transport`/`context` 60s · unclassified default 5min. The `subagent_models` catalog tool annotates each provider with `health: healthy/unhealthy` + `failingClass` + `retryAfterSec`.
7. **Failure-detail passthrough**: a failed child no longer reduces to "subagent run failed" — observable failures (`start` rejections, infrastructure faults) are classified (quota / rate-limit / auth / context / server / timeout / transport) and **sanitized** into the tool result (including HTTP status and retry-after), so the caller sees "provider rate-limited (http 429)" instead of misjudging a quota problem as an execution failure.

The policy is deliberately conservative: it stays on the calling agent's own model by default, upgrades only when the task clearly demands more than a weak parent model can offer, never hides its reasoning — and reroutes decisively once a route is proven unhealthy instead of blindly retrying.

## Install

```bash
dsh plugin add dsh-subagent-router
```

The bundle inserts one composition row (`subagent-router`). It consumes the host `tools` / `subagents` / `llm` registries and publishes nothing, so it belongs on the host plane (or in a preset's loose rows) and needs no isolate realm.

## Configuration

**Settings UI**: the plugin ships a client half, so its configuration can be
edited directly under **Settings → Plugins** (the `subagent-router` card).
**Every configurable field is live** — edits write to the user settings layer
(`subagent-router` section of `~/.dsh/settings.yaml`) and the next
`subagent_model` call picks them up **without a restart**; clearing a field
falls back to the composition-row value below.

Alternatively, configure via the composition row's `config` (the base layer,
overridden by the settings UI user layer):

| Field | Default | Meaning |
|---|---|---|
| `autoEscalate` | `true` | After a failed foreground run, retry on the next auto tier. |
| `autoReroute` | `true` | On a terminal failure (quota/auth), reroute to a healthy provider route. |
| `autoEscalationTiers` | `1` | Max escalation steps on the same provider after transient failures (`0` disables escalation). |
| `autoProviderOrder` | — | **Provider priority**: `model: "auto"` resolves the provider in this order (unlisted ones sort after); it also backs the parent route when unhealthy or absent. Default: registry order. |
| `autoTierPolicy` | — | **Per-tier selection mode**: `{ trivial\|standard\|complex: 'anchor'\|'cheapest'\|'strongest' }`. `anchor` keeps the parent model when its route is healthy; `cheapest`/`strongest` pick by naming score. Omitted tiers keep the built-in heuristic. |
| `autoTierPicks` | — | **Per-tier explicit candidate order**: `{ trivial\|standard\|complex: [modelId, ...] }`, fully overrides that tier; candidates are a global model priority resolved in provider-priority order — the first one a healthy provider advertises wins (may cross providers). |
| `recommendTimeoutMs` | `8000` | Timeout in milliseconds for `subagent_recommend`'s one-shot LLM classification call (range 1000–60000); past it the tool degrades to the naming heuristic with a reason. |

**Fixed defaults (not configurable)**: registration-time behavior is fixed to
sane defaults and no longer exposed as config — earlier versions made these
fields configurable but their "saves" did not take effect (registration
snapshot), a trap:

| Slot | Fixed value | Why |
|---|---|---|
| Subagent provider | `spawn` | The dsh default continuable subagent provider. |
| Tool names | `subagent_model` / `subagent_models` | Standard naming; renaming has no use case. |
| Background mode | `continuable` | Matches the harness-native subagent semantics: **background by default, immediately returns a durable subagent id, same-session continuation**; pass `run_in_background: false` to wait for the result. Requires the provider's `prepareContinuable` (fail-loud at mount otherwise). |
| Feature toggles | all on (`run_in_background` / `model: "auto"` / catalog tool) | No use case for disabling. |
| Depth cap | `provider-managed` | Leaves the recursion budget to the provider — any provider mounts (no `depthLimit` capability requirement). |

Example row:

```yaml
- id: subagent-router
  name: 'dsh-subagent-router'
```

With model-routing priorities (configure to your own provider preferences):

```yaml
- id: subagent-router
  name: 'dsh-subagent-router'
  config:
    autoProviderOrder: [deepseek-official, pi-ai-cn]   # provider priority
    autoTierPolicy:
      trivial: cheapest        # trivial tasks always use the cheapest model
      standard: anchor         # ordinary tasks follow the parent model
      complex: strongest       # heavy tasks use the strongest model
    autoTierPicks:
      complex: [deepseek-v4-pro, pi-3-maxi]  # optional: explicit heavy-task candidates
```

## Example model flow

1. `subagent_models` → lists `deepseek-official` (with its catalog) and any pi-ai routes.
2. `subagent_model` with `{ description: "compare pricing", prompt: "...", provider: "deepseek-official", model: "deepseek-r1", max_tokens: 4000 }` → runs the child on that exact route and returns its output.
3. `subagent_model` with `{ description: "say hi", prompt: "hi", provider: "deepseek-official", model: "auto" }` → stays on the calling agent's own model when it belongs to that provider (anchored, marked `anchored` in the `[auto]` line); otherwise the auto policy falls back to catalog picks and records `[auto] ...` with its reason.
4. Omit `provider`/`model` to keep the child on your own route.

## Development

```bash
npm install --legacy-peer-deps
npm test       # vitest: schema shape, route validation, agentOptions pass-through, catalog tool, auto policy + escalation, health rerouting
npm run build  # tsc -> lib/ + esbuild client bundle
```

The test suite drives the real plugin body on a real `ToolRuntime` + `SubagentRuntime` with a scripted subagent provider and a faked `llm` route registry; no network or credentials are touched.

## Roadmap

Planned work for the auto-routing policy (catalog metadata, recommend tool, feedback loop, budgets): see [docs/ROADMAP.md](./docs/ROADMAP.md); release history in [PUBLISHING.md](./PUBLISHING.md). Handoff notes (HANDOFF.md) are a local-private file and are not in the repo or the npm package.

## License

MIT
