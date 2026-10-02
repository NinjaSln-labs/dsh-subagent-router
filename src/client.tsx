/**
 * dsh-subagent-router — Client half.
 *
 * Renders the plugin's configuration card on the Plugins settings page
 * (`plugins.item` / `plugins.bundle.config`), bound to the host-side settings
 * namespace of the same name (profile entry `subagent-router`). The card is
 * built from the host design system (`@deepseek-ai/dsh-client-ui-primitives`):
 * `SettingsForm` frame + `SettingsValueField` / `Checkbox` controls + `Menu`
 * dropdowns over an input-styled trigger — the same components in-tree plugin
 * config pages use, so it shares one React context and one set of CSS tokens
 * instead of a second self-drawn skin.
 *
 * Only a save writes. Drafts stay local until `保存`, which diffs the edited
 * top-level keys against the committed section and writes just those (never
 * re-writing the composition base with schema defaults).
 */
import * as React from 'react'
import { SettingsForm, SettingsValueField, Checkbox, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

// Side-effect type import: pulls the augmented module into the program so the
// `declare module` below can merge into its SlotMap interface. Under
// `skipLibCheck` TS does not chase the .d.ts imports that reference this
// module (e.g. dsh-client-ui-renderer's slot registry types), so without this
// import the augmentation fails with TS2664 "module cannot be found" in a clean
// install. Type-only -> erased at bundle time; ui-slots stays external at
// runtime (a kernel-seeded module, not a plugin graph row).
import type {} from '@deepseek-ai/dsh-client-ui-slots'

// Side-effect type import: pulls dsh-client-ui-renderer's `declare module
// '@deepseek-ai/cordis'` augmentation into the program — that is what types
// `ctx.slots` on the client Context. Same skipLibCheck blindness as ui-slots
// above: the renderer's registry types are only reachable through a .d.ts
// import chain TS will not chase, so without this import `ctx.slots` is
// reported missing. Type-only -> erased at bundle time.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * One plugin's config row in the Plugins settings page — the 0.2.0-rc.2 seat.
     * The old `settings.plugin.item` seat no longer exists in the shell's slot
     * registry; in-tree plugin configs (bash / subagent / web-search) register
     * here. The host supplies `view` ('summary' for the list row, 'page' for the
     * detail form) and the registrant must forward it, not hard-code one.
     */
    'plugins.item': {
      kind: 'list'
      scope: 'root'
      owner: { view: 'summary' | 'page' }
    }
    /** Config form on a bundle detail page, keyed by **package name**. */
    'plugins.bundle.config': {
      kind: 'keyed'
      scope: 'root'
      owner: { view: 'summary' | 'page' }
    }
  }
}

/** Serialized config shape the host namespace resolves (mirrors src/config.ts — live fields only). */
type Section = {
  autoEscalate?: boolean
  autoReroute?: boolean
  autoEscalationTiers?: number
  autoProviderOrder?: string[]
  autoTierPolicy?: Partial<Record<'trivial' | 'light' | 'standard' | 'complex', 'anchor' | 'cheapest' | 'strongest'>>
  autoTierPicks?: Partial<Record<'trivial' | 'light' | 'standard' | 'complex', string[]>>
  recommendTimeoutMs?: number
}

type TierKey = 'trivial' | 'light' | 'standard' | 'complex'

/** Host model-directory RPC (aggregated host-side; see src/catalog.ts). */
const CATALOG_RPC_PATH = '/subagent-router-rpc'

/** Loaded directory snapshot feeding the provider/model dropdowns. */
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

/** The host's settings-form copy (the same strings the in-tree cards use). */
const FORM_LABELS = {
  unavailable: '本插件的配置项当前不可用',
  readOnly: '配置文件为只读，无法保存',
  saveFailed: '保存未生效，修改仍保留在表单里',
  save: '保存',
  saving: '保存中…',
} as const
const FIELD_LABELS = { overridden: '已修改', reset: '恢复默认' } as const

/**
 * Minimal chrome for the dropdown rows (label / hint / chips) — the only pieces
 * the host primitives don't already provide. Tokenized with the same
 * `--dsw-alias-*` variables as the design system so it matches the surrounding
 * form in both themes.
 */
const CSS = `
.sr-dd{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.sr-switch{display:flex;align-items:center;padding:12px 0}
.sr-dd-head{display:flex;align-items:center;gap:8px}
.sr-dd-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary,#f9fafb)}
.sr-dd-badge{font-size:12px;line-height:18px;color:var(--dsw-alias-state-business-primary,#4c8dff)}
.sr-dd-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8a8f96)}
/* Trigger mirrors the host SettingsValueField input (fields.module.css .input). */
.sr-input{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;height:34px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l4,#ffffff2e);border-radius:var(--dsw-radius-md,6px);background:var(--dsw-alias-bg-layer-3,#1f2022);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#f9fafb);text-align:left;cursor:pointer}
.sr-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary,#4c8dff)}
.sr-input:disabled{color:var(--dsw-alias-label-tertiary,#8a8f96);cursor:default}
.sr-input--empty{color:var(--dsw-alias-label-tertiary,#8a8f96)}
.sr-dd-caret{flex:none;color:var(--dsw-alias-label-tertiary,#8a8f96)}
.sr-dd-chips{display:flex;flex-wrap:wrap;gap:6px}
.sr-dd-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 6px 0 8px;border-radius:12px;background:var(--dsw-alias-bg-layer-4,#2a2b2d);border:1px solid var(--dsw-alias-border-l2,#ffffff1f);color:var(--dsw-alias-label-primary,#f9fafb);font-size:12px;line-height:1}
.sr-dd-chip-x{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f96);cursor:pointer;padding:0;border-radius:50%}
.sr-dd-chip-x:hover:not(:disabled){color:var(--dsw-alias-label-primary,#f9fafb)}
`

/** One-line description for the Plugins list row and detail header (summary view). */
const CARD_SUMMARY = '子任务模型路由：每次委派选择 provider / model（auto 策略，健康感知换路）。'

type FieldGroup = 'recovery' | 'scope' | 'tier'
type Opt = { value: string; label: string }
type Result = { ok: true; value: unknown } | { ok: false; message: string }

type FieldCommon = { id: string; group: FieldGroup; label: string; hint: string; path: readonly string[] }

/**
 * One editable field. `switch` renders the host `Checkbox`; `text` the host
 * `SettingsValueField`; `dropdown` / `multiselect` a host `Menu` over a
 * trigger styled to match the field input. Every field writes through `apply`
 * (`v === undefined` = clear, so the field re-inherits the composition layer).
 */
type Field =
  | (FieldCommon & { control: 'switch'; bool: (s: Section) => boolean; apply: (s: Section, v: unknown) => Section })
  | (FieldCommon & { control: 'text'; numeric: boolean; text: (s: Section) => string; parse: (t: string) => Result; apply: (s: Section, v: unknown) => Section })
  | (FieldCommon & { control: 'dropdown'; options: readonly Opt[]; value: (s: Section) => string; apply: (s: Section, v: unknown) => Section })
  | (FieldCommon & { control: 'multiselect'; source: 'provider' | 'model'; value: (s: Section) => string[]; apply: (s: Section, v: unknown) => Section })

const TIERS: ReadonlyArray<{ key: TierKey; label: string }> = [
  { key: 'trivial', label: '琐碎' },
  { key: 'light', label: '轻量' },
  { key: 'standard', label: '普通' },
  { key: 'complex', label: '复杂' },
]

const TIER_MODE_OPTIONS: readonly Opt[] = [
  { value: '', label: '默认（内置启发式）' },
  { value: 'anchor', label: '锚定父模型' },
  { value: 'cheapest', label: '最便宜' },
  { value: 'strongest', label: '最强' },
  { value: 'fixed', label: '固定（手动选候选模型）' },
]

function switchField(id: 'autoEscalate' | 'autoReroute', label: string, hint: string, fallback: boolean): Field {
  return {
    id, group: 'recovery', label, hint, path: [id],
    control: 'switch',
    bool: s => (s[id] ?? fallback) === true,
    apply: (s, v) => { const next: Section = { ...s }; if (v === undefined) delete next[id]; else next[id] = v === true; return next },
  }
}

function numberField(id: 'autoEscalationTiers' | 'recommendTimeoutMs', group: FieldGroup, label: string, hint: string, min?: number, max?: number): Field {
  return {
    id, group, label, hint, path: [id],
    control: 'text', numeric: true,
    text: s => { const v = s[id]; return v === undefined ? '' : String(v) },
    parse: t => {
      const x = t.trim()
      if (x === '') return { ok: true, value: undefined }
      const n = Number(x)
      if (!Number.isFinite(n)) return { ok: false, message: '请输入有效数值' }
      if (min !== undefined && n < min) return { ok: false, message: `需 ≥ ${min}` }
      if (max !== undefined && n > max) return { ok: false, message: `需 ≤ ${max}` }
      return { ok: true, value: n }
    },
    apply: (s, v) => { const next: Section = { ...s }; if (v === undefined) delete next[id]; else next[id] = v as number; return next },
  }
}

/** Provider-order multiselect over the live provider ids. */
function providerOrderField(): Field {
  return {
    id: 'autoProviderOrder', group: 'scope', label: '提供方优先级',
    hint: '按顺序优先使用；越靠前越优先，全不选 = 按注册表顺序。',
    path: ['autoProviderOrder'],
    control: 'multiselect', source: 'provider',
    value: s => s.autoProviderOrder ?? [],
    apply: (s, v) => { const next: Section = { ...s }; const arr = v as string[] | undefined; if (arr === undefined || arr.length === 0) delete next.autoProviderOrder; else next.autoProviderOrder = arr; return next },
  }
}

/**
 * Per-tier strategy dropdown — one control per tier, combining the mode and the
 * explicit candidate list, exactly as before: `固定` means "use the candidate
 * list" (rendered below only in that mode). Choosing a non-`fixed` mode clears
 * the tier's picks; choosing `fixed` clears its policy and seeds an empty list.
 */
function tierModeField(key: TierKey, label: string): Field {
  return {
    id: `autoTierPolicy.${key}`, group: 'tier', label: `${label}任务 · 选型策略`,
    hint: '默认＝内置启发式；锚定＝健康时沿用父模型；最便宜/最强＝目录按命名分；固定＝下方手动选候选模型。',
    path: ['autoTierPolicy', key],
    control: 'dropdown', options: TIER_MODE_OPTIONS,
    value: s => (s.autoTierPicks?.[key] !== undefined ? 'fixed' : (s.autoTierPolicy?.[key] ?? '')),
    apply: (s, v) => {
      const p = { ...(s.autoTierPolicy ?? {}) }
      const picks = { ...(s.autoTierPicks ?? {}) }
      if (v === 'fixed') {
        if (picks[key] === undefined) picks[key] = []
        delete p[key]
      } else {
        if (v === undefined || v === '') delete p[key]
        else p[key] = v as 'anchor' | 'cheapest' | 'strongest'
        delete picks[key]
      }
      const next: Section = { ...s }
      if (Object.keys(p).length === 0) delete next.autoTierPolicy
      else next.autoTierPolicy = p
      if (Object.keys(picks).length === 0) delete next.autoTierPicks
      else next.autoTierPicks = picks
      return next
    },
  }
}

/** Per-tier explicit candidate multiselect over the live model ids. */
function tierPicksField(key: TierKey, label: string): Field {
  return {
    id: `autoTierPicks.${key}`, group: 'tier', label: `${label}任务 · 固定候选模型`,
    hint: '按顺序选候选模型；非空时覆盖该档选型策略。',
    path: ['autoTierPicks', key],
    control: 'multiselect', source: 'model',
    value: s => s.autoTierPicks?.[key] ?? [],
    apply: (s, v) => {
      const p = { ...(s.autoTierPicks ?? {}) }
      const arr = v as string[] | undefined
      if (arr === undefined || arr.length === 0) delete p[key]
      else p[key] = arr
      const next: Section = { ...s }
      if (Object.keys(p).length === 0) delete next.autoTierPicks
      else next.autoTierPicks = p
      return next
    },
  }
}

const FIELDS: readonly Field[] = [
  switchField('autoEscalate', '失败时升级', '前台运行失败后沿下一档自动重试一次。', true),
  switchField('autoReroute', '终态失败换路', '配额/鉴权失败时切换到健康提供方。', true),
  numberField('autoEscalationTiers', 'recovery', '升级档数上限', '同一提供方最多升级几步（0 表示不升级）。默认 1。', 0),
  providerOrderField(),
  numberField('recommendTimeoutMs', 'scope', '推荐分类超时', 'subagent_recommend 分类器的一次 LLM 调用超时（毫秒，范围 1000–60000，默认 8000）；超时自动降级到命名启发式。', 1000, 60000),
  ...TIERS.flatMap(({ key, label }) => [tierModeField(key, label), tierPicksField(key, label)]),
]

/** Group titles, in render order. */
const GROUPS: ReadonlyArray<{ id: FieldGroup; title: string }> = [
  { id: 'recovery', title: '失败恢复' },
  { id: 'scope', title: '模型选型范围' },
  { id: 'tier', title: '分档策略' },
]

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length === 0
  return false
}

/** Whether a user-layer object carries the field at `path` (override badge). */
function hasPath(user: unknown, path: readonly string[]): boolean {
  let cur: unknown = user
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null || !Object.hasOwn(cur, key)) return false
    cur = (cur as Record<string, unknown>)[key]
  }
  return true
}

/** Caret glyph for the dropdown anchors. */
function caret(): React.ReactElement {
  return React.createElement('svg', { className: 'sr-dd-caret', width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    React.createElement('path', { d: 'M4 6l4 4 4-4', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round' }))
}

/** A labelled host `Menu` dropdown (single value). */
function DropdownRow(props: {
  id: string; label: string; hint: string; disabled: boolean; overridden: boolean
  value: string; options: readonly Opt[]; onChange: (v: string) => void
}): React.ReactElement {
  const { id, label, hint, disabled, overridden, value, options, onChange } = props
  const [open, setOpen] = React.useState(false)
  const current = options.find(o => o.value === value)?.label ?? String(value)
  return React.createElement('div', { className: 'sr-dd' },
    React.createElement('div', { className: 'sr-dd-head' },
      React.createElement('span', { className: 'sr-dd-label' }, label),
      overridden ? React.createElement('span', { className: 'sr-dd-badge' }, FIELD_LABELS.overridden) : null,
    ),
    React.createElement(Menu, {
      open,
      portal: true,
      align: 'start',
      selectedId: value,
      items: options.map(o => ({ id: o.value, label: o.label })),
      onSelect: (v: string) => { onChange(v); setOpen(false) },
      onClose: () => setOpen(false),
      anchor: React.createElement('button', {
        id, type: 'button', className: 'sr-input', disabled,
        'aria-haspopup': 'menu', 'aria-expanded': open,
        onClick: () => setOpen(v => !v),
      }, React.createElement('span', null, current), caret()),
    }),
    React.createElement('span', { className: 'sr-dd-hint' }, hint),
  )
}

/** A labelled host `Menu` dropdown with multi-select semantics + a chip list. */
function MultiselectRow(props: {
  id: string; label: string; hint: string; disabled: boolean; overridden: boolean
  value: readonly string[]; options: readonly Opt[]; onChange: (v: string[]) => void
}): React.ReactElement {
  const { id, label, hint, disabled, overridden, value, options, onChange } = props
  const [open, setOpen] = React.useState(false)
  const toggle = (v: string): void => {
    onChange(value.includes(v) ? value.filter(x => x !== v) : [...value, v])
  }
  const labelOf = (v: string): string => options.find(o => o.value === v)?.label ?? v
  return React.createElement('div', { className: 'sr-dd' },
    React.createElement('div', { className: 'sr-dd-head' },
      React.createElement('span', { className: 'sr-dd-label' }, label),
      overridden ? React.createElement('span', { className: 'sr-dd-badge' }, FIELD_LABELS.overridden) : null,
    ),
    React.createElement(Menu, {
      open,
      portal: true,
      align: 'start',
      selectedIds: value,
      items: options.map(o => ({ id: o.value, label: o.label })),
      onSelect: (v: string) => { toggle(v) }, // stays open for multi-select
      onClose: () => setOpen(false),
      anchor: React.createElement('button', {
        id, type: 'button', className: value.length === 0 ? 'sr-input sr-input--empty' : 'sr-input', disabled,
        'aria-haspopup': 'menu', 'aria-expanded': open,
        onClick: () => setOpen(v => !v),
      }, React.createElement('span', null, value.length > 0 ? `已选 ${value.length} 项` : '选择…'), caret()),
    }),
    value.length > 0
      ? React.createElement('div', { className: 'sr-dd-chips' },
        ...value.map(v => React.createElement('span', { className: 'sr-dd-chip', key: v },
          labelOf(v),
          React.createElement('button', {
            type: 'button', className: 'sr-dd-chip-x', disabled, 'aria-label': `移除 ${labelOf(v)}`,
            onClick: () => toggle(v),
          }, '×'),
        )),
      )
      : null,
    React.createElement('span', { className: 'sr-dd-hint' }, hint),
  )
}

/** The settings Plugins-section card for dsh-subagent-router. */
function SettingsCard(props: { form: ConfigForm<Section>; view: 'summary' | 'page' }): React.ReactElement {
  const { form, view } = props
  // The host renders `plugins.item` TWICE on an item's detail page: once with
  // `view:'summary'` (the description line under the title) and once with
  // `view:'page'` (the form). Honoring `view` is what keeps the summary a
  // one-liner instead of a second full form.
  if (view === 'summary') return React.createElement(React.Fragment, null, CARD_SUMMARY)
  return React.createElement(SettingsCardBody, { form })
}

/** Detail-page form body (hooks isolated so the summary branch calls none). */
function SettingsCardBody({ form }: { form: ConfigForm<Section> }): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<ConfigFormSnapshot<Section>>(form.getSnapshot())
  const [textEdits, setTextEdits] = React.useState<Record<string, string>>({})
  const [boolEdits, setBoolEdits] = React.useState<Record<string, boolean>>({})
  const [selectEdits, setSelectEdits] = React.useState<Record<string, string>>({})
  const [listEdits, setListEdits] = React.useState<Record<string, string[]>>({})
  const [clears, setClears] = React.useState<readonly string[]>([])
  const [saving, setSaving] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [catalog, setCatalog] = React.useState<Catalog>({ status: 'loading', groups: [] })

  React.useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [form])
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
  const disabled = !snapshot.writable || snapshot.status !== 'ready'

  // Only routes that advertise at least one model are worth ordering: a route
  // with an empty catalog (e.g. `deepseek-account`) can never serve a pick.
  const providerOptions: readonly Opt[] = catalog.groups
    .filter(g => g.models.length > 0)
    .map(g => ({ value: g.id, label: g.name }))
  const modelOptions: readonly Opt[] = (() => {
    const seen = new Set<string>()
    const out: Opt[] = []
    for (const g of catalog.groups) for (const m of g.models) if (!seen.has(m.id)) { seen.add(m.id); out.push({ value: m.id, label: m.id }) }
    return out
  })()

  const textValue = (f: Extract<Field, { control: 'text' }>): string => {
    if (Object.hasOwn(textEdits, f.id)) return textEdits[f.id]!
    if (clears.includes(f.id)) return ''
    return f.text(committed)
  }
  const textError = (f: Extract<Field, { control: 'text' }>): string | undefined => {
    if (!Object.hasOwn(textEdits, f.id)) return undefined
    const r = f.parse(textEdits[f.id]!)
    return r.ok ? undefined : (r as { message: string }).message
  }

  const dirty = Object.keys(textEdits).length > 0 || Object.keys(boolEdits).length > 0
    || Object.keys(selectEdits).length > 0 || Object.keys(listEdits).length > 0 || clears.length > 0
  const invalid = FIELDS.some(f => f.control === 'text' && textError(f) !== undefined)

  const markEdited = (id: string): void => {
    setFailed(false)
    setClears(prev => prev.filter(x => x !== id))
  }
  const onEditText = (id: string, text: string): void => { markEdited(id); setTextEdits(prev => ({ ...prev, [id]: text })) }
  const onToggle = (id: string, checked: boolean): void => { markEdited(id); setBoolEdits(prev => ({ ...prev, [id]: checked })) }
  const onSelect = (id: string, v: string): void => { markEdited(id); setSelectEdits(prev => ({ ...prev, [id]: v })) }
  const onList = (id: string, v: string[]): void => { markEdited(id); setListEdits(prev => ({ ...prev, [id]: v })) }
  const onReset = (id: string): void => {
    setFailed(false)
    setTextEdits(prev => { const n = { ...prev }; delete n[id]; return n })
    setBoolEdits(prev => { const n = { ...prev }; delete n[id]; return n })
    setSelectEdits(prev => { const n = { ...prev }; delete n[id]; return n })
    setListEdits(prev => { const n = { ...prev }; delete n[id]; return n })
    setClears(prev => (prev.includes(id) ? prev : [...prev, id]))
  }
  const clearDrafts = (): void => {
    setTextEdits({}); setBoolEdits({}); setSelectEdits({}); setListEdits({}); setClears([]); setFailed(false)
  }
  const discard = (): void => { if (!saving) clearDrafts() }

  /** Committed value plus this form's staged edits — what a save would store. */
  const computeNext = (): Section => {
    let next: Section = { ...committed }
    for (const f of FIELDS) {
      if (f.control === 'switch') {
        if (Object.hasOwn(boolEdits, f.id)) next = f.apply(next, boolEdits[f.id])
      } else if (f.control === 'text') {
        if (Object.hasOwn(textEdits, f.id)) {
          const r = f.parse(textEdits[f.id]!)
          if (r.ok) next = f.apply(next, r.value)
        } else if (clears.includes(f.id)) next = f.apply(next, undefined)
      } else if (f.control === 'dropdown') {
        if (Object.hasOwn(selectEdits, f.id)) next = f.apply(next, selectEdits[f.id])
        else if (clears.includes(f.id)) next = f.apply(next, undefined)
      } else {
        if (Object.hasOwn(listEdits, f.id)) next = f.apply(next, listEdits[f.id])
        else if (clears.includes(f.id)) next = f.apply(next, undefined)
      }
    }
    return next
  }
  /** The strategy currently shown for one tier (drives the candidate picker's visibility). */
  const tierMode = (key: TierKey): string => {
    const s = computeNext()
    return s.autoTierPicks?.[key] !== undefined ? 'fixed' : (s.autoTierPolicy?.[key] ?? '')
  }

  const save = (): void => {
    if (saving) return
    if (FIELDS.some(f => f.control === 'text' && textError(f) !== undefined)) return // invalid blocks the save
    const next = computeNext()
    // The host only accepts writes to VOLATILE LEAF paths (see SettingsForms /
    // isVolatilePath): writing the whole `autoTierPolicy` / `autoTierPicks`
    // container is silently refused, so the tier maps go out as per-tier leaf
    // paths. Top-level live scalars are themselves volatile leaves.
    const ops: Array<{ op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }> = []
    const pushTop = (key: keyof Section): void => {
      if (JSON.stringify(next[key]) === JSON.stringify(committed[key])) return
      if (isEmptyValue(next[key])) ops.push({ op: 'unset', path: [key] })
      else ops.push({ op: 'set', path: [key], value: next[key] })
    }
    const pushTier = (mapKey: 'autoTierPolicy' | 'autoTierPicks'): void => {
      const a = (next[mapKey] ?? {}) as Record<string, unknown>
      const b = (committed[mapKey] ?? {}) as Record<string, unknown>
      for (const { key } of TIERS) {
        const av = a[key]
        const bv = b[key]
        if (JSON.stringify(av) === JSON.stringify(bv)) continue
        const cleared = av === undefined || (Array.isArray(av) && av.length === 0)
        if (cleared) { if (bv !== undefined) ops.push({ op: 'unset', path: [mapKey, key] }) }
        else ops.push({ op: 'set', path: [mapKey, key], value: av })
      }
    }
    pushTop('autoEscalate'); pushTop('autoReroute'); pushTop('autoEscalationTiers')
    pushTop('autoProviderOrder'); pushTop('recommendTimeoutMs')
    pushTier('autoTierPolicy'); pushTier('autoTierPicks')
    if (ops.length === 0) { clearDrafts(); return }
    void (async () => {
      setSaving(true)
      setFailed(false)
      try {
        const ok = await form.mutate(ops)
        if (!ok) setFailed(true)
        else clearDrafts()
      } catch {
        setFailed(true)
      } finally {
        setSaving(false)
      }
    })()
  }

  const isOverridden = (f: Field): boolean => {
    if (hasPath(snapshot.user, f.path)) return true
    // A tier's `固定` state lives in autoTierPicks while its path is autoTierPolicy.
    if (f.id.startsWith('autoTierPolicy.') && hasPath(snapshot.user, ['autoTierPicks', f.id.split('.')[1]!])) return true
    return Object.hasOwn(boolEdits, f.id) || Object.hasOwn(textEdits, f.id) || Object.hasOwn(selectEdits, f.id) || Object.hasOwn(listEdits, f.id)
  }

  const renderField = (f: Field): React.ReactElement | null => {
    if (f.control === 'switch') {
      const checked = Object.hasOwn(boolEdits, f.id) ? boolEdits[f.id]! : f.bool(committed)
      return React.createElement('div', { key: f.id, className: 'sr-switch' },
        React.createElement(Checkbox, {
          checked, disabled, label: f.label, title: f.hint,
          onChange: (v: boolean) => onToggle(f.id, v),
        }))
    }
    if (f.control === 'dropdown') {
      return React.createElement(DropdownRow, {
        key: f.id, id: `sr-${f.id}`, label: f.label, hint: f.hint, disabled, overridden: isOverridden(f),
        value: Object.hasOwn(selectEdits, f.id) ? selectEdits[f.id]! : f.value(computeNext()),
        options: f.options,
        onChange: (v: string) => onSelect(f.id, v),
      })
    }
    if (f.control === 'multiselect') {
      // The per-tier candidate list is only meaningful in the `固定` mode — the
      // picker appears (and disappears) with its tier's strategy, as before.
      if (f.id.startsWith('autoTierPicks') && tierMode(f.id.split('.')[1] as TierKey) !== 'fixed') return null
      return React.createElement(MultiselectRow, {
        key: f.id, id: `sr-${f.id}`, label: f.label, hint: f.hint, disabled, overridden: isOverridden(f),
        value: Object.hasOwn(listEdits, f.id) ? listEdits[f.id]! : f.value(computeNext()),
        options: f.source === 'provider' ? providerOptions : modelOptions,
        onChange: (v: string[]) => onList(f.id, v),
      })
    }
    const error = textError(f)
    return React.createElement(SettingsValueField, {
      key: f.id, id: `sr-${f.id}`, label: f.label, hint: f.hint,
      text: textValue(f), overridden: isOverridden(f), invalid: error !== undefined, numeric: f.numeric, disabled,
      overriddenLabel: FIELD_LABELS.overridden, resetLabel: FIELD_LABELS.reset,
      invalidLabel: error ?? '输入无效',
      onEdit: (text: string) => onEditText(f.id, text),
      onReset: () => onReset(f.id),
    })
  }

  return React.createElement(SettingsForm, {
    labels: FORM_LABELS,
    state: { available: snapshot.status === 'ready', writable: snapshot.writable, dirty, invalid, saving, failed },
    onSave: save,
    onDiscard: discard,
    children: React.createElement(React.Fragment, null,
      React.createElement('style', null, CSS),
      ...GROUPS.map(group => React.createElement('section', { key: group.id, className: 'sr-group' },
        React.createElement('h3', { className: 'sr-group-title' }, group.title),
        ...FIELDS.filter(f => f.group === group.id).map(renderField),
      )),
    ),
  })
}

export const name = 'dsh-subagent-router'

/**
 * Required client services: `slots` for the seat mounts. `configForms` is
 * deliberately NOT here — it is probed optionally in apply(); requiring it
 * would keep the whole entry pending forever on a deployment that never
 * composed the settings base (silent, zero-error non-mount).
 */
export const inject = ['slots']

/** Client entry: register the Plugins-section config card for the namespace. */
export function apply(ctx: ClientContext): void {
  // 0.2.0-rc.2：配置底座由 `settingsScope` 换成 `configForms`（宿主 settings 改由
  // `SettingsForms` 从 Config schema 派生；旧的 settingsScope 服务与 `settings.plugin.item`
  // 槽位都已移除）。用 `ctx.inject(['configForms'], …)` **等待服务挂载**再探测——
  // 一次性 `ctx.get('configForms')` 会在服务尚未就绪时返回 undefined（本 entry 的
  // apply 早于 settings 客户端挂载），卡片会静默消失。用 inject 子作用域等待既
  // 不阻塞本 entry（父级不挂起），服务永不到达时也只是没有配置卡。
  ctx.inject(['configForms'], (cctx) => {
    const configForms = (cctx as unknown as {
      configForms: {
        get<T>(entryId: string): ConfigForm<T>
        whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
      }
    }).configForms
    // Entry id (profile plugin entry) = settings namespace; the bundle patch
    // (cordis.patch.yml) inserts id `subagent-router`.
    const form = configForms.get<Section>('subagent-router')
    // The provider/model ids in the dropdowns come from the host RPC route (see
    // src/catalog.ts) — a bundle client cannot call the host `llm` service's
    // bulk catalog directly.
    cctx.effect(() => configForms.whileServed(['subagent-router'], () => {
      // Two seats, two jobs: `plugins.item` is the list row + ledger detail page;
      // `plugins.bundle.config` is the form on the bundle detail page (keyed by
      // PACKAGE name). Both are asked "where is the form?" — the host passes
      // `view` so the list row renders a summary and the detail page the form.
      const renderCard = (view: 'summary' | 'page') => React.createElement(SettingsCard, { form, view })
      const itemSeat = cctx.slots.inject('plugins.item', () => cctx.slots.register(
        { name: 'plugins.item', id: 'subagent-router', order: 90, label: '子代理模型路由配置' },
        (props: { view: 'summary' | 'page' }) => renderCard(props.view),
      ))
      const bundleSeat = cctx.slots.inject('plugins.bundle.config', () => cctx.slots.register(
        { name: 'plugins.bundle.config', key: 'dsh-subagent-router' },
        () => renderCard('page'),
      ))
      return () => { itemSeat?.(); bundleSeat?.() }
    }))
  })
}
