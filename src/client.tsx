/**
 * dsh-subagent-router — Client half.
 *
 * Renders the plugin's configuration card in the settings Plugins section
 * (`settings.plugin.item`, key `subagent-router`), bound to the host-side
 * settings namespace of the same name. Editing a field writes it to the user
 * layer through the settings scope (`set`/`unset`); the host plugin's
 * `installSettingsSection` re-resolves on `settings/updated`, so a saved edit
 * takes effect on the next `subagent_model` call without a restart.
 *
 * Data flow: the card is a selector over the shared settings describe mirror
 * (`ctx.settingsScope.bind`). No host RPC, no polling — the scope pushes
 * snapshot replacements on committed document changes.
 */
import * as React from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

// Side-effect type import: pulls the augmented module into the program so the
// `declare module` below can merge into its SlotMap interface. Under
// `skipLibCheck` TS does not chase the .d.ts imports that reference this
// module (e.g. dsh-client-runtime's slots types), so without this import the
// augmentation fails with TS2664 "module cannot be found" in a clean install.
// Type-only -> erased at bundle time; ui-slots stays external at runtime.
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One plugin's card inside the plugin configuration section (key = settings namespace). */
    'settings.plugin.item': {
      kind: 'keyed'
      scope: 'root'
      owner: { children?: never }
    }
  }
}

/** Serialized config shape the host namespace resolves (mirrors src/config.ts — live fields only). */
type Section = {
  autoEscalate?: boolean
  autoReroute?: boolean
  autoEscalationTiers?: number
  autoProviderOrder?: string[]
  autoTierPolicy?: Partial<Record<'trivial' | 'standard' | 'complex', 'anchor' | 'cheapest' | 'strongest'>>
  autoTierPicks?: Partial<Record<'trivial' | 'standard' | 'complex', string[]>>
  recommendTimeoutMs?: number
}

/** Host model-directory RPC (aggregated host-side; see src/catalog.ts). */
const CATALOG_RPC_PATH = '/subagent-router-rpc'

/** Loaded directory snapshot handed to the pickers. */
type Catalog = {
  status: 'loading' | 'ready' | 'error'
  /** Provider groups (id → name + models). */
  groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>
}

/** Fetch the live provider/model directory from the host RPC route. */
async function fetchCatalog(signal: AbortSignal): Promise<Catalog> {
  const res = await fetch(CATALOG_RPC_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'catalog' }),
    signal,
  })
  const data = await res.json() as { ok?: boolean; result?: { groups?: Catalog['groups'] }; error?: string }
  if (!data.ok) throw new Error(data.error ?? 'catalog rpc failed')
  return { status: 'ready', groups: data.result?.groups ?? [] }
}

/**
 * Normalize a model id so cross-provider spelling variants of the same model
 * collapse: lowercase, strip a leading provider prefix (`deepseek/xxx` → `xxx`),
 * and fold any separator run to a single `-`. `-free`/`-vision` suffixes stay,
 * so distinct tiers/variants are NOT merged.
 */
function canonicalModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/^[^/]*\//, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

const CSS = `
.sr-card{display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-3,#353638);border:1px solid var(--dsw-alias-border-l2,#ffffff1f);border-radius:12px;box-sizing:border-box;width:100%;overflow:hidden}
.sr-header{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:14px 16px;background:transparent;border:none;cursor:pointer;color:var(--dsw-alias-label-primary,#f9fafb);text-align:left;font:inherit}
.sr-header:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.06))}
.sr-header:focus-visible{outline:2px solid var(--dsw-alias-state-business,#4c8dff);outline-offset:-2px;border-radius:12px}
.sr-headText{display:flex;flex-direction:column;gap:2px;min-width:0}
.sr-name{font-size:15px;font-weight:600;line-height:21px;color:var(--dsw-alias-label-primary,#f9fafb)}
.sr-description{font-size:13px;font-weight:400;line-height:19.5px;color:var(--dsw-alias-label-secondary,#adb2b8)}
.sr-chevron{flex:none;width:16px;height:16px;color:var(--dsw-alias-label-tertiary,#999);transition:transform .15s ease;transform:rotate(0deg)}
.sr-open .sr-chevron{transform:rotate(90deg)}
.sr-body{display:none;padding:0 0 16px;border-top:1px solid var(--dsw-alias-border-l2,#ffffff1f)}
.sr-open .sr-body{display:flex;flex-direction:column;padding:16px 16px 16px}
.sr-field{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}
.sr-field:last-of-type{margin-bottom:0}
.sr-label{font-size:13px;font-weight:500;line-height:19.5px;color:var(--dsw-alias-label-secondary,#adb2b8)}
.sr-hint{font-size:13px;font-weight:400;line-height:19px;color:var(--dsw-alias-label-tertiary,#8a8f96)}
.sr-group{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700;line-height:21px;color:var(--dsw-alias-label-primary,#f9fafb);margin-top:20px;margin-bottom:12px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l2,#ffffff1f)}
.sr-group::before{content:'';flex:none;width:3px;height:16px;border-radius:2px;background:var(--dsw-alias-state-business,#4c8dff)}
.sr-group:first-of-type{margin-top:0;padding-top:0;border-top:none}
.sr-control{display:flex;align-items:center;gap:8px}
.sr-input{flex:1;min-width:0;height:36px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,#ffffff1f);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#353638);color:var(--dsw-alias-label-primary,#f9fafb);font-size:13px;font-weight:400;box-sizing:border-box}
.sr-input:focus-visible{outline:2px solid var(--dsw-alias-state-business,#4c8dff);outline-offset:1px;border-color:var(--dsw-alias-state-business,#4c8dff)}
.sr-check{accent-color:var(--dsw-alias-state-business,#4c8dff);width:16px;height:16px}
.sr-check:focus-visible{outline:2px solid var(--dsw-alias-state-business,#4c8dff);outline-offset:2px}
.sr-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.sr-note{font-size:13px;font-weight:400;line-height:19px;color:var(--dsw-alias-label-secondary,#adb2b8);margin-bottom:4px}
.sr-note-dirty{color:var(--dsw-alias-state-warn,#e2a33c)}
.sr-note-done{color:var(--dsw-alias-state-success,#4cc38a)}
.sr-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.sr-btn{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 16px;border-radius:8px;font-size:13px;font-weight:500;line-height:19.5px;cursor:pointer;box-sizing:border-box;transition:background .12s ease,filter .12s ease}
.sr-btn:disabled{opacity:.45;cursor:not-allowed}
.sr-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business,#4c8dff);outline-offset:2px}
.sr-btn-default{background:transparent;border:1px solid var(--dsw-alias-border-l2,#ffffff1f);color:var(--dsw-alias-label-secondary,#cfd3d6)}
.sr-btn-default:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.06))}
.sr-btn-primary{background:var(--dsw-alias-label-primary,#f9fafb);border:1px solid transparent;color:var(--dsw-alias-bg-layer-3,#353638)}
.sr-btn-primary:hover:not(:disabled){filter:brightness(0.92)}
.sr-btn-primary:active:not(:disabled){filter:brightness(0.85)}
.sr-unavailable{font-size:13px;font-weight:400;line-height:19px;color:var(--dsw-alias-label-secondary,#adb2b8);padding:14px 16px}
.sr-picker{display:flex;flex-direction:column;gap:8px}
.sr-picker-row{display:flex;gap:8px;align-items:center}
.sr-picker-row .sr-input{flex:1}
.sr-chip-list{display:flex;flex-wrap:wrap;gap:6px}
.sr-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 8px 0 10px;border-radius:13px;background:var(--dsw-alias-bg-layer-4,#2a2b2d);border:1px solid var(--dsw-alias-border-l2,#ffffff1f);color:var(--dsw-alias-label-primary,#f9fafb);font-size:12px;font-weight:400}
.sr-chip-remove{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f96);cursor:pointer;border-radius:50%;padding:0}
.sr-chip-remove:hover{color:var(--dsw-alias-label-primary,#f9fafb);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.08))}
.sr-btn-add{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 14px;border-radius:8px;background:transparent;border:1px solid var(--dsw-alias-border-l2,#ffffff1f);color:var(--dsw-alias-label-primary,#f9fafb);font-size:13px;font-weight:500;cursor:pointer}
.sr-btn-add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.06))}
.sr-btn-add:disabled{opacity:.45;cursor:not-allowed}
`

/** Form grouping: recovery = failure handling, scope = model selection range, tier = per-tier strategy. */
type FieldGroup = 'recovery' | 'scope'

/** One typed field: id, label, kind, group, and the render control's value type. */
type Field =
  | { id: keyof Section; group: FieldGroup; label: string; hint?: string; kind: 'number'; min?: number; max?: number; get: (s: Section) => number | undefined; set: (s: Section, v: number) => Section }
  | { id: keyof Section; group: FieldGroup; label: string; hint?: string; kind: 'boolean'; default?: boolean; get: (s: Section) => boolean | undefined; set: (s: Section, v: boolean) => Section }
  | { id: keyof Section; group: FieldGroup; label: string; hint?: string; kind: 'text'; get: (s: Section) => string | undefined; set: (s: Section, v: string) => Section }

/** Declarative field list — single source for the form (mirrors src/config.ts). */
const FIELDS: Field[] = [
  { id: 'autoEscalate', group: 'recovery', label: '失败时升级', hint: '前台运行失败后沿下一档自动重试一次。', kind: 'boolean', default: true, get: s => s.autoEscalate, set: (s, v) => ({ ...s, autoEscalate: v }) },
  { id: 'autoReroute', group: 'recovery', label: '终态失败换路', hint: '配额/鉴权失败时切换到健康提供方。', kind: 'boolean', default: true, get: s => s.autoReroute, set: (s, v) => ({ ...s, autoReroute: v }) },
  { id: 'autoEscalationTiers', group: 'recovery', label: '升级档数上限', hint: '同一提供方最多升级几步（0 表示不升级）。', kind: 'number', min: 0, get: s => s.autoEscalationTiers, set: (s, v) => ({ ...s, autoEscalationTiers: v }) },
  { id: 'recommendTimeoutMs', group: 'scope', label: '推荐分类超时', hint: 'subagent_recommend 分类器的一次 LLM 调用超时（毫秒，范围 1000–60000，默认 8000）；超时自动降级到命名启发式。', kind: 'number', min: 1000, max: 60000, get: s => s.recommendTimeoutMs, set: (s, v) => ({ ...s, recommendTimeoutMs: v }) },
]

/** Group titles, in render order. */
const GROUPS: Array<{ id: FieldGroup | 'tier'; title: string }> = [
  { id: 'recovery', title: '失败恢复' },
  { id: 'scope', title: '模型选型范围' },
  { id: 'tier', title: '分档策略' },
]

const TIER_LABELS: Array<['trivial' | 'standard' | 'complex', string]> = [
  ['trivial', '琐碎'],
  ['standard', '普通'],
  ['complex', '复杂'],
]
const MODE_OPTIONS = ['', 'anchor', 'cheapest', 'strongest', 'fixed']
const MODE_LABELS: Record<string, string> = {
  '': '默认（内置启发式）',
  anchor: '锚定父模型',
  cheapest: '最便宜',
  strongest: '最强',
  fixed: '固定（手动选候选模型）',
}

/** Free-editing numeric input: keeps a local draft while typing so the field
 *  never freezes mid-edit, and commits on blur only when the value is a valid
 *  number within [min, max] (out-of-range/invalid input snaps back). */
function NumberControl(props: {
  id: string
  disabled: boolean
  min?: number
  max?: number
  current: number | undefined
  onCommit: (n: number) => void
}): React.ReactElement {
  const { id, disabled, min, max, current, onCommit } = props
  const [draft, setDraft] = React.useState<string | null>(null)
  const display = draft !== null ? draft : current === undefined ? '' : String(current)
  const commit = (): void => {
    const text = draft
    setDraft(null)
    if (text === null || text === '') return
    const n = Number(text)
    if (Number.isNaN(n)) return
    if (min !== undefined && n < min) return
    if (max !== undefined && n > max) return
    onCommit(n)
  }
  return React.createElement('input', {
    id,
    className: 'sr-input',
    type: 'number',
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    value: display,
    disabled,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() },
  })
}

/** Render one control for a field; edits flow to the parent via `onEdit`. */
function FieldControl(props: {
  field: Field
  value: Section
  disabled: boolean
  onEdit: (patch: Section) => void
}): React.ReactElement {
  const { field, value, disabled, onEdit } = props
  const hint = field.hint === undefined ? null : React.createElement('div', { className: 'sr-hint' }, field.hint)
  switch (field.kind) {
    case 'text': {
      const current = field.get(value) ?? ''
      return React.createElement('div', { className: 'sr-field' },
        React.createElement('label', { className: 'sr-label', htmlFor: `sr-${String(field.id)}` }, field.label),
        React.createElement('div', { className: 'sr-control' },
          React.createElement('input', {
            id: `sr-${String(field.id)}`,
            className: 'sr-input',
            value: current,
            disabled,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => onEdit(field.set(value, e.target.value)),
          }),
        ),
        hint,
      )
    }
    case 'number': {
      return React.createElement('div', { className: 'sr-field' },
        React.createElement('label', { className: 'sr-label', htmlFor: `sr-${String(field.id)}` }, field.label),
        React.createElement('div', { className: 'sr-control' },
          React.createElement(NumberControl, {
            id: `sr-${String(field.id)}`,
            disabled,
            min: field.min,
            max: field.max,
            current: field.get(value),
            onCommit: (n) => onEdit(field.set(value, n)),
          }),
        ),
        hint,
      )
    }
    case 'boolean': {
      const current = field.get(value) ?? field.default ?? false
      return React.createElement('div', { className: 'sr-row' },
        React.createElement('label', { className: 'sr-label', htmlFor: `sr-${String(field.id)}` }, field.label),
        React.createElement('div', { className: 'sr-control' },
          React.createElement('input', {
            id: `sr-${String(field.id)}`,
            className: 'sr-check',
            type: 'checkbox',
            checked: current,
            disabled,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => onEdit(field.set(value, e.target.checked)),
          }),
          hint,
        ),
      )
    }
  }
}

/** Order-preserving multi-select: a <select> + add button feeding a removable chip list. */
function OrderedPicker(props: {
  candidates: Array<{ id: string; label: string }>
  selected: string[]
  onChange: (next: string[]) => void
  disabled: boolean
  placeholder: string
  max?: number
}): React.ReactElement {
  const { candidates, selected, onChange, disabled, placeholder, max } = props
  const [pending, setPending] = React.useState('')
  const available = candidates.filter(candidate => !selected.includes(candidate.id))
  const atMax = max !== undefined && selected.length >= max
  const add = (): void => {
    if (pending === '' || atMax) return
    onChange([...selected, pending])
    setPending('')
  }
  const remove = (id: string): void => {
    onChange(selected.filter(item => item !== id))
  }
  return React.createElement('div', { className: 'sr-picker' },
    React.createElement('div', { className: 'sr-picker-row' },
      React.createElement('select', {
        className: 'sr-input',
        value: pending,
        disabled: disabled || available.length === 0 || atMax,
        onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setPending(e.target.value),
      },
        React.createElement('option', { value: '' }, disabled || atMax ? placeholder + '（已达上限）' : available.length === 0 ? '无可选项' : placeholder),
        ...available.map(candidate => React.createElement('option', { key: candidate.id, value: candidate.id }, candidate.label)),
      ),
      React.createElement('button', {
        className: 'sr-btn-add',
        type: 'button',
        disabled: disabled || pending === '' || atMax,
        onClick: add,
      }, '添加'),
    ),
    selected.length > 0
      ? React.createElement('div', { className: 'sr-chip-list' },
        ...selected.map(id => {
          const label = candidates.find(candidate => candidate.id === id)?.label ?? id
          return React.createElement('span', { className: 'sr-chip', key: id },
            label,
            React.createElement('button', {
              className: 'sr-chip-remove',
              type: 'button',
              disabled,
              'aria-label': `移除 ${label}`,
              onClick: () => remove(id),
            }, '×'),
          )
        }),
      )
      : null,
  )
}

/** The settings Plugins-section card for dsh-subagent-router. */
function SettingsCard(props: { scope: SettingsScope<Section> }): React.ReactElement {
  const { scope } = props
  const [snapshot, setSnapshot] = React.useState<SettingsScopeSnapshot<Section>>(scope.getSnapshot())
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState<Section | null>(null)
  const [saved, setSaved] = React.useState(false)
  const [catalog, setCatalog] = React.useState<Catalog>({ status: 'loading', groups: [] })
  React.useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope])
  React.useEffect(() => {
    const controller = new AbortController()
    let alive = true
    void fetchCatalog(controller.signal).then(
      (loaded) => { if (alive) setCatalog(loaded) },
      () => { if (alive) setCatalog({ status: 'error', groups: [] }) },
    )
    return () => { alive = false; controller.abort() }
  }, [])
  const committed = snapshot.value ?? ({} as Section)
  // Editing view = draft when present (unsaved edits), else the committed value.
  const value = draft ?? committed
  const dirty = draft !== null
  const disabled = !snapshot.writable || snapshot.status !== 'ready'
  if (snapshot.status === 'unavailable') {
    return React.createElement('div', { className: 'sr-card' },
      React.createElement('style', null, CSS),
      React.createElement('div', { className: 'sr-unavailable' },
        'subagent-router：此部署不可用该设置命名空间。'),
    )
  }
  const onEdit = (patch: Section): void => {
    setSaved(false)
    setDraft(prev => ({ ...(prev ?? committed), ...patch }))
  }
  const onTierEdit = (tier: 'trivial' | 'standard' | 'complex', mode: string): void => {
    setDraft(prev => {
      const base = prev ?? committed
      const policy = { ...(base.autoTierPolicy ?? {}) }
      const picks = { ...(base.autoTierPicks ?? {}) }
      if (mode === 'fixed') {
        // 固定：保留/初始化该档候选清单，选型模式留空（候选清单完全覆盖）。
        if (picks[tier] === undefined) picks[tier] = []
        delete policy[tier]
      } else {
        // 其它模式（默认/锚定/最便宜/最强）：设 policy，清除该档候选清单。
        if (mode === '') delete policy[tier]
        else policy[tier] = mode as 'anchor' | 'cheapest' | 'strongest'
        delete picks[tier]
      }
      return {
        ...base,
        autoTierPolicy: Object.keys(policy).length > 0 ? policy : undefined,
        autoTierPicks: Object.keys(picks).length > 0 ? picks : undefined,
      }
    })
  }
  const onTierPicksEdit = (tier: 'trivial' | 'standard' | 'complex', parts: string[]): void => {
    setDraft(prev => {
      const base = prev ?? committed
      const current = base.autoTierPicks ?? {}
      const next = { ...current }
      if (parts.length === 0) {
        delete next[tier]
      } else {
        next[tier] = parts
      }
      return { ...base, autoTierPicks: Object.keys(next).length > 0 ? next : undefined }
    })
  }
  const onSave = (): void => {
    if (draft === null) return
    const isEmptyObject = (value: unknown): boolean =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && Object.values(value as Record<string, unknown>).every(entry => Array.isArray(entry) && entry.length === 0)
    void (async () => {
      for (const key of Object.keys(draft) as Array<keyof Section>) {
        const next = draft[key]
        if (next === undefined || (Array.isArray(next) && next.length === 0) || isEmptyObject(next)) {
          await scope.unset(key as string)
        } else {
          await scope.set(key as string, next as unknown)
        }
      }
      setDraft(null)
      setSaved(true)
    })()
  }
  const onCancel = (): void => { setDraft(null); setSaved(false) }
  // Catalog-derived candidates for the pickers (provider ids and model ids).
  // Free-tier routes/models (name or id carrying "free"/"免费") sort first.
  const isFree = (s: string): boolean => /(free|免费)/i.test(s)
  const providerCandidates = catalog.groups
    .map(group => ({ id: group.id, label: group.name, free: isFree(group.name) || isFree(group.id) }))
    .sort((a, b) => (a.free === b.free ? a.label.localeCompare(b.label) : a.free ? -1 : 1))
    .map(({ id, label }) => ({ id, label }))
  // Models collapsed by canonical id (autoTierPicks stores model ids, not
  // provider-bound selections): spelling variants across providers
  // (`deepseek-v4-flash` / `DeepSeek-V4-Flash` / `deepseek/deepseek-v4-flash`)
  // merge into one candidate. The label is the normalized id (provider prefix
  // stripped, lowercase) — cross-provider spelling collapsed, provider hidden.
  // The stored value is the first-seen original id of the group.
  const modelProviders = new Map<string, { name: string; providers: string[]; firstId: string }>()
  for (const group of catalog.groups) {
    for (const model of group.models) {
      const key = canonicalModelId(model.id)
      const entry = modelProviders.get(key)
      if (entry === undefined) {
        modelProviders.set(key, { name: model.name, providers: [group.name], firstId: model.id })
      } else if (!entry.providers.includes(group.name)) {
        entry.providers.push(group.name)
      }
    }
  }
  const modelCandidates = [...modelProviders]
    .map(([key, { providers, firstId }]) => ({
      id: firstId,
      label: key,
      free: providers.some(provider => isFree(provider)) || isFree(key) || isFree(firstId),
    }))
    .sort((a, b) => (a.free === b.free ? a.label.localeCompare(b.label) : a.free ? -1 : 1))
    .map(({ id, label }) => ({ id, label }))
  const chevron = React.createElement('svg', {
    className: 'sr-chevron',
    viewBox: '0 0 16 16',
    fill: 'none',
    'aria-hidden': true,
  },
    React.createElement('path', {
      d: 'M6 4l4 4-4 4',
      stroke: 'currentColor',
      strokeWidth: '1.5',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
  return React.createElement('div', {
    className: open ? 'sr-card sr-open' : 'sr-card',
  },
    React.createElement('style', null, CSS),
    React.createElement('button', {
      className: 'sr-header',
      type: 'button',
      'aria-expanded': open,
      onClick: () => setOpen(!open),
    },
      React.createElement('span', { className: 'sr-headText' },
        React.createElement('span', { className: 'sr-name' }, 'dsh-subagent-router'),
        React.createElement('span', { className: 'sr-description' },
          '子任务模型路由：每次委派选择 provider / model（auto 策略，健康感知换路）。'),
      ),
      chevron,
    ),
    React.createElement('div', { className: 'sr-body' },
      React.createElement('div', { className: 'sr-note' + (dirty ? ' sr-note-dirty' : saved ? ' sr-note-done' : '') },
        dirty ? '有未保存的修改。' : saved ? '已保存，下一次调用生效。' : '修改保存后，下一次 subagent_model 调用即生效（无需重启）。'),
      ...GROUPS.map(group => {
        const nodes: React.ReactNode[] = [
          React.createElement('div', { className: 'sr-group', key: `group-${group.id}` }, group.title),
        ]
        if (group.id === 'tier') {
          nodes.push(...TIER_LABELS.map(([tier, label]) => {
            // 一个档位一个「选型策略」下拉；选「固定」才展开候选模型选择器。
            const picks = value.autoTierPicks?.[tier]
            const current = picks !== undefined ? 'fixed' : (value.autoTierPolicy?.[tier] ?? '')
            return React.createElement('div', { className: 'sr-field', key: `tier-${tier}` },
              React.createElement('label', { className: 'sr-label', htmlFor: `sr-tier-${tier}` }, `${label}任务选型策略`),
              React.createElement('div', { className: 'sr-control' },
                React.createElement('select', {
                  id: `sr-tier-${tier}`,
                  className: 'sr-input',
                  value: current,
                  disabled,
                  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => onTierEdit(tier, e.target.value),
                }, MODE_OPTIONS.map(option =>
                  React.createElement('option', { key: option, value: option }, MODE_LABELS[option] ?? option))),
              ),
              React.createElement('div', { className: 'sr-hint' },
                current === 'fixed'
                  ? `${label}任务已固定候选模型：按下方清单顺序选第一个被健康提供方广告的模型（覆盖上方选型策略）。`
                  : `${label}任务的选型策略（默认 = 内置启发式；固定 = 手动选候选模型）。`),
              current === 'fixed'
                ? React.createElement(React.Fragment, null,
                    React.createElement(OrderedPicker, {
                      candidates: modelCandidates,
                      selected: value.autoTierPicks?.[tier] ?? [],
                      onChange: (next) => onTierPicksEdit(tier, next),
                      disabled,
                      placeholder: '选择候选模型',
                      max: 12,
                    }),
                    catalog.status === 'error'
                      ? React.createElement('div', { className: 'sr-hint' }, '目录不可用，无法列出模型。')
                      : null,
                  )
                : null,
            )
          }))
        } else {
          if (group.id === 'scope') {
            nodes.push(React.createElement('div', { className: 'sr-field', key: 'provider-order' },
              React.createElement('label', { className: 'sr-label' }, '提供方优先级'),
              React.createElement(OrderedPicker, {
                candidates: providerCandidates,
                selected: value.autoProviderOrder ?? [],
                onChange: (next) => onEdit({ autoProviderOrder: next }),
                disabled,
                placeholder: '选择提供方路由',
              }),
              React.createElement('div', { className: 'sr-hint' },
                catalog.status === 'error'
                  ? '目录不可用，无法列出提供方。'
                  : '在列表靠前的提供方优先使用；留空 = 按注册表顺序。'),
            ))
          }
          nodes.push(...FIELDS.filter(field => field.group === group.id).map(field => {
            // 联动灰显：关闭「失败时升级」后，升级档数上限无意义，禁用。
            const fieldDisabled = disabled
              || (field.id === 'autoEscalationTiers' && (value.autoEscalate ?? true) === false)
            return React.createElement(FieldControl, {
              key: String(field.id),
              field,
              value,
              disabled: fieldDisabled,
              onEdit,
            })
          }))
        }
        return nodes
      }),
      React.createElement('div', { className: 'sr-actions' },
        React.createElement('button', {
          className: 'sr-btn sr-btn-default',
          type: 'button',
          disabled: !dirty,
          onClick: onCancel,
        }, '放弃修改'),
        React.createElement('button', {
          className: 'sr-btn sr-btn-primary',
          type: 'button',
          disabled: !dirty || disabled,
          onClick: onSave,
        }, '保存'),
      ),
    ),
  )
}

export const name = 'dsh-subagent-router'

export const inject = ['slots', 'settingsScope']

/** Client entry: register the settings Plugins-section card for the namespace. */
export function apply(ctx: ClientContext): void {
  // `settingsScope` is a runtime Service provided by dsh-client-ui-settings
  // (no compile-time Context enhancement ships with it — assert the shape).
  const settingsScope = (ctx as unknown as {
    settingsScope: { bind(spec: { namespace: string }): SettingsScope<Section> }
  }).settingsScope
  const scope = settingsScope.bind({ namespace: 'subagent-router' })
  // The provider/model pickers fetch the live model directory from the host
  // RPC route (see src/catalog.ts) — a bundle client cannot call the host
  // `llm` service's bulk catalog directly.
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
    { name: 'settings.plugin.item', key: 'subagent-router' } as never,
    () => React.createElement(SettingsCard, { scope }),
  ) as never)
}
