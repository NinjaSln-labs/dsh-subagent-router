# 贡献指南

感谢你愿意为 dsh-subagent-router 贡献！本仓库是一个独立单库（2026-09 从 dsh-plugins monorepo 迁出），仓库根即插件目录。

## 开发环境

```sh
npm install --legacy-peer-deps   # peer 由宿主 dsh 在运行时提供，本仓库装 devDeps 供构建/测试
npm run build                    # tsc → lib/ + esbuild 客户端 bundle
npm run typecheck                # 严格类型检查
npm test                         # vitest：schema 形态、路由校验、agentOptions 透传、目录工具、auto 策略与升级、健康换路
```

测试套件在真实的 `ToolRuntime` + `SubagentRuntime` 上驱动真实插件体，使用脚本化子代理 provider 与伪造的 `llm` 路由注册表；不触网、不用凭据。

## 提交规范

- 提交信息用中文写清楚「改了什么 + 为什么」（仓库 AGENTS.md / DEVELOPMENT.md 有完整纪律）。
- 涉及 `src/`、`scripts/` 改动会触发 pre-commit 部署纪律自检（`git config core.hooksPath .githooks` 启用）；确属未部署的中间态用 `--no-verify` 并在说明中注明。
- **本机私有信息不入库**：本机绝对路径、个人邮箱、token、部署实况快照一律不写入入库文件。

## 发版流程

见 [PUBLISHING.md](PUBLISHING.md)（npm version → tag → CI 验证 → OIDC trusted publishing 发布）。

## 行为准则

简单说：尊重、建设性、对事不对人。本仓库维护者会驳回不友善或与主题无关的 issue / PR。
