# 安全策略

## 报告漏洞

本插件在宿主 harness 内以**服务消费方**身份工作：它读取 `ctx.llm` 的路由目录、经 `ctx.subagents` 委派任务、记录 provider 健康状态，本身不管理凭据。安全边界值得关注的点：

- **模型路由信任**：`model: "auto"` 的选型与健康记录完全来自 `ctx.llm` 报告与本地会话内失败分类，不引入外部输入作为路由裁决依据（`subagent_recommend` 的 LLM 分类失败即降级到命名启发式）。
- **错误信息透传**：子代理失败详情会**脱敏**后拼进工具结果（见 `src/failure.ts`），避免把凭据类信息原样暴露给调用方。
- **配置值**：`autoProviderOrder` / `autoTierPicks` 等来自 settings 或组合入口，无敏感字段。
- **依赖**：发布产物携带的最小依赖（schemastery）。

若你发现漏洞或安全缺陷，**不要**公开 issue——直接发邮件到仓库维护者（见 package.json author），或到 GitHub 仓库 Security 标签页用私密漏洞报告。

## 响应

- 确认收到后 72 小时内回复。
- 严重漏洞优先修复并发布补丁版本。
