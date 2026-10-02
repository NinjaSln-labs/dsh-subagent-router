# dsh-subagent-router — 设置页插件配置 UI 实施计划

> 状态：已执行完毕（随 0.3.0 交付）· 日期：2026-08-21 · 目标：让 `dsh-subagent-router` 的配置出现在 **设置 → 插件配置** 页面（`settings.plugin.item` 卡片），并支持在 UI 编辑、保存生效。

## 1. 背景与动机

- 用户期望：在 dsh web 的「设置 → 插件配置」中配置本插件（`autoProviderOrder` / `autoTierPolicy` / `autoTierPicks` / `autoCeiling` 等），而不是手写 `cordis.patch.yml`。
- 现状：本插件是**纯 host 插件**（无 client half），且未注册 settings 命名空间 → 设置页「插件配置」tab 不显示它（该 tab 只渲染「Host 提供 settings 命名空间 ∧ client 注册 `settings.plugin.item` 卡片」的插件）。
- 已实证的机制（dsh 主程序源码）：
  - Host：`installSettingsSection(ctx, ns, schema, entry, hooks)`（`@deepseek-ai/dsh-settings`，profile 可解析）——注册命名空间，`setSource` 切换配置来源（settings user 层 > 组合 entry base 层 > schema 默认）。
  - Client：`settings.plugin.item` 是 keyed slot（key = settings 命名空间）；卡片通过 `ctx.settingsScope.bind({ namespace })` 获取 `SettingsScope`（`getSnapshot`/`subscribe`/`set(field, value)`/`unset(field)`），自绘表单。
  - 打包链：esbuild → `lib/client.js`，`window.__ModuleLoader__.load({ id, factory })` 注册；react/cordis/dsh-client-runtime 等 external（shell 提供）——照 `dsh-context-compass/scripts/build-client.mjs` 模式。
- 参考先例：`dsh-bash-local`（host 侧 installSettingsSection）、`dsh-client-ui-settings-plugins` BashCard（client 卡片 + 表单）、`dsh-context-compass`（第三方 host+client 打包链）。

## 2. 架构决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 配置来源优先级 | settings user 层 > 组合 entry（cordis.patch.yml）> schema 默认 | `installSettingsSection` 的标准接线；现有 patch.yml 配置继续作 base 生效 |
| 配置读取方式 | 响应式 getter（`currentConfig()`），`setSource` 更新，工具注册读 getter | settings 更新后无需重建工具即可生效 |
| 表单渲染 | 自绘 React 表单（计划时点 20 项（注册期），现行 live 配置面 7 字段），不用 `dsh-client-schema-form`（不在 profile 依赖链） | 可控、无额外依赖风险 |
| client 状态 | `ctx.settingsScope.bind({ namespace: 'subagent-router' })` | dsh 开放的标准 scope 入口 |
| 打包 | esbuild（external: react/cordis/dsh-client-runtime/client 等） | 与 context-compass 完全一致的模式 |
| 插件形态 | host + client 双 half | 唯一能满足设置页 UI 的方式 |

## 3. 实施任务（分步）

### Phase A — Host 侧 settings 注册（先做，可独立验证）
- [x] A1. `package.json`：`peerDependencies` 加 `@deepseek-ai/dsh-settings`（dsh 主程序实际版本 **0.1.0-rc.8**；peer 声明宽松 `^0.1.0-rc.8`，运行时解析到 dsh 共享 node_modules）
- [x] A2. `src/index.ts`：`apply` 里用 `installSettingsSection(ctx, settingsNamespace('subagent-router'), Config, config, { setSource, onChange })` 注册；引入 `currentConfig()` 响应式引用
- [x] A3. `resolveConfig` 保持纯函数（schema 归一化值或 entry 都走它）；`apply` 的 `resolved` 改为每次从 `currentConfig()` 读取
- [x] A4. `registerModelPickerTools(ctx, config)` 改为接受 getter `() => ResolvedModelPickerConfig`（工具闭包内每次读最新）
- [x] A5. 单测：host 注册（mock settings 服务或真 dsh-settings）、响应式更新（setSource 后 getter 变化）、向后兼容（无 settings 时用 entry）

### Phase B — Client 侧卡片
- [x] B1. 新建 `src/client.tsx`：默认导出 client 插件
  - `ctx.get('slots')` + `slots.inject('settings.plugin.item', () => slots.register({ name: 'settings.plugin.item', key: 'subagent-router' }, Card))`
  - `ctx.get('settingsScope')` + `bind({ namespace: 'subagent-router' })`（绑定在插件 fiber，disposer 随 fiber 释放）
  - `Card` 组件：读 scope snapshot 渲染字段表单（文本/布尔/数字/数组/enum），`set`/`unset` 写字段
- [x] B2. 表单字段映射：计划时点 20 项（注册期），现行 live 配置面 7 字段 → 控件（`autoProviderOrder` 数组编辑、`autoTierPolicy` 三档 enum、`maxDepth` 数字/enum 等）
- [x] B3. client 端错误处理：scope 不可用（`status: 'unavailable'`）时卡片渲染降级提示

### Phase C — 打包链与元数据
- [x] C1. 新建 `scripts/build-client.mjs`（照 compass：esbuild → `lib/client.js`，`__ModuleLoader__` banner/footer，EXTERNAL 列表 + `@deepseek-ai/dsh-client-runtime/client`）
- [x] C2. `package.json`：`exports["./client"]`、`dsh.client.inject`（`@deepseek-ai/dsh-client-runtime`）、peer deps 加 client 运行时、`build` 脚本改为 `tsc && node scripts/build-client.mjs`
- [x] C3. `tsconfig.build.json`：确认 client.tsx 编译通过（tsc 仅类型检查 client，打包靠 esbuild）
- [x] C4. 依赖安装：`@deepseek-ai/dsh-settings`（host peer，rc.8）、`esbuild`（dev）、`@types/react`（dev）、react（peer）

### Phase D — 验证（自测）
- [x] D1. 单测：`src/config.ts` schema 与 `resolveConfig` 双源一致（已有）；新增 host settings 注册测试
- [x] D2. tsc typecheck 通过（host + client 类型）
- [x] D3. esbuild client 打包成功，`lib/client.js` 生成
- [x] D4. 全量测试绿（现有 64 + 新增）
- [x] D5. 部署 profile（lib + package.json 同步）→ 重启 dsh web

### Phase E — 验收（真实环境）
- [x] E1. 设置 → 插件配置 出现 `subagent-router` 卡片
- [x] E2. 卡片显示表单（计划时点 20 项（注册期），现行 live 配置面 7 字段），当前值正确（来自 patch.yml base + schema 默认）
- [x] E3. 编辑字段（如 `autoTierPolicy.trivial` 改 `cheapest`）→ 保存 → 生效（`model: "auto"` 实测 policy 变化）
- [x] E4. 重置字段（unset）→ 回退到 patch.yml 值
- [x] E5. `subagent_model` 工具在配置变化后行为正确（响应式生效，无需重启）
- [x] E6. 无回归：现有验证场景（锚定/升级/换路）仍工作

## 4. 验收标准（DoD）

1. **设置页可见**：设置 → 插件配置 中显示 `subagent-router` 卡片（非空）。
2. **表单完整**：配置字段全部可编辑（计划时点 20 项（注册期），现行 live 配置面 7 字段）；类型正确（布尔/数字/字符串/数组/enum）。
3. **读值正确**：卡片初始值 = patch.yml base（计划时点基线：`autoProviderOrder: [deepseek-official, amd, opencode-go]` + `autoTierPolicy` 三档；现行 `cordis.patch.yml` 无 `config` 段）⊕ schema 默认。
4. **写值生效**：UI 修改 → 保存 → `subagent_model` 行为即时变化（如 `autoTierPolicy.trivial: anchor` 改为 `cheapest` 后 trivial 任务选型变化），无需重启。
5. **重置回退**：UI 清除字段 → 回退到 patch.yml 值。
6. **向后兼容**：不配置任何 settings（纯 patch.yml）时行为与现状完全一致（64 测试全绿 + 真实场景锚定/升级/换路验证）。
7. **无副作用**：`subagent_models` 目录、健康感知、失败恢复均无回归。
8. **代码质量**：tsc 严格通过；esbuild 打包成功；client 代码遵循 Cordis 插件规范（无 JSX 语法错误、生命周期随 fiber 释放）。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| `settingsScope` 服务在 client 运行时不可见（ui-settings 未挂载或挂载晚） | `ctx.get('settingsScope')` + undefined 检查；卡片渲染降级提示；绑定随 fiber 释放 |
| client 打包 external 模块 shell 不提供（`dsh-client-runtime/client` 等） | 严格照 compass 已验证的 EXTERNAL 列表；运行时验证 |
| settings 注册影响现有 patch.yml 配置（双源冲突） | `installSettingsSection` 的 base = entry 语义天然解决（settings user 覆盖 entry）；单测覆盖 |
| 响应式改造破坏工具注册（getter 闭包） | 单元测试：setSource 后工具行为变化 |
| dsh-settings 版本对齐 | peer 声明宽松（`^0.1.0-rc.x`），运行时解析到 dsh 主程序共享版本 |
| 20 字段表单开发量大（计划时点口径；现行 live 配置面 7 字段）| 按类型分组渲染（text/bool/number/array/enum 五类控件），复用单类组件 |

## 6. 交付物

- 代码：`src/config.ts`（已有）、`src/index.ts`（host settings）、`src/client.tsx`（新增）、`scripts/build-client.mjs`（新增）、`package.json`（exports/client/依赖）、`lib/client.js`（构建产物）
- 测试：`tests/tools.spec.ts`（新增 host settings 用例）
- 文档：`README.md`/`README.en.md`（配置说明补「设置页 UI」）、`docs/ROADMAP.md`（1b 完成）、`.handoff/` 存储（delta；本地私有，未追踪）
- 部署：profile lib 同步 + 重启验证

## 7. 参考（实证来源）

- `dsh-bash-local/lib/index.js` — host `installSettingsSection` 用法
- `dsh-client-ui-settings-plugins/lib/client.js` — BashCard（`settings.plugin.item` 卡片 + `PluginCard`/`ValueField` 表单）
- `dsh-client-ui-settings/lib/client.js` — `SettingsScopeBinder`（`settingsScope` 服务，`bind`/`describe`）
- `dsh-client-runtime/lib/types/client/contract/settings-scope.d.ts` — client `SettingsScope` 契约
- `dsh-context-compass/scripts/build-client.mjs` — 第三方 client 打包链
