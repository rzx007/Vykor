# 可观测性与排障

> 状态：当前实现的权威观察入口。最后核对：2026-08-23。

这里说明“不改运行状态，怎样看清 daemon 正在做什么”。真正的运行事实仍在 SQLite 和持久文件里；日志、指标和 debug 接口只是查询这些事实，不能代替它们。

## 先用哪一个入口

| 需求 | 入口 | 是否包含内容 |
|---|---|---|
| 只确认 daemon 活着 | `GET /health` | 不包含会话内容 |
| 看全局数量、队列和指标 | `GET /debug/runtime` | 不包含 prompt、模型输出或工具参数 |
| 追一条 Run 的完整关系 | `GET /debug/runs/:runId` | 默认脱敏；显式 `?includeContent=true` 才返回内容 |
| 看投影失败是否仍待修复 | `GET /debug/projection-settlements` | 默认隐藏 settlement payload |
| 串起一次 HTTP、Run、Tool 和 Permission | JSON Lines 结构化日志中的 `traceId` | 禁止记录正文和 secret |
| 查清理做了什么 | SQLite 的 `retention_audit` | 保存策略与删除数量 |
| 确认备份可恢复 | 备份目录的 `manifest.json` 和 `checksums.json` | 包含文件清单与校验值，不是运行指标 |

这些 debug 路由需要 daemon bearer token；`/health` 是例外，只返回很小的存活信息。

## Trace ID：把同一次操作串起来

`traceId` 是一次请求链的关联 ID。客户端可以通过 `x-vykor-trace-id` 传入，daemon 也会在响应中返回同名 header；没有传入时由 daemon 生成。

```text
CLI / TUI / Web 请求
  -> HTTP traceId
  -> Input metadata.traceId
  -> Run metadata.traceId
  -> Tool / Permission / Task 日志
```

请求幂等 ID 和 traceId 不是一回事：幂等 ID 决定“这是不是同一次提交”，traceId 只帮助排障。稳定请求 ID 重试时可以换 traceId，但首次成功准入后，数据库里的原始 traceId 是权威值。

## 结构化日志

`@vykor/server` 的 logger 每行输出一个 JSON 对象。公共字段是 `level`、`event`、`traceId`；按事件还会带 `sessionId`、`runId`、`requestId`、`taskId`、`toolName`、HTTP 状态和耗时。

当前主路径事件包括：

- HTTP：`http.request.completed`。
- Run：`session.run.started`、`session.run.completed`、`session.run.interrupted`、`session.run.failed`。
- Tool：`session.tool.started`、`session.tool.completed`。
- Permission：`permission.requested`、`permission.auto_approved`、`permission.replied`、`permission.expired`。
- Task：`session.task.created`、`session.task.bound`、`session.task.completed`。
- 需要立即处理的异常：`application.owner_lost`、`session.agent.cleanup_failed`、`session.execution.registry_completion_failed`、`session.child_projection.compensation_failed`、`channel.message.idempotency_conflict`、`agent.child_budget_exceeded`。

`application.owner_lost` 表示当前进程已经失去数据目录的写入所有权。它不是普通警告：进程会关闭准入并开始收尾，运维人员应检查是否启动了第二个 daemon、系统时钟是否跳变，以及旧进程是否仍存活。

日志绝不能写 prompt 原文、模型输出、工具参数或结果、permission payload、bearer token、API key。需要正文时，使用受认证保护的 Run Inspector，并明确传 `includeContent=true`；不要扩大常规日志采集范围。

## `/health`

这个接口适合存活探针，只返回：版本、启动时间、运行时长、session 总数、活跃 Run 数和排队 Run 数。它回答“服务是否响应”，不回答“数据是否完全收束”。

## `/debug/runtime`

这个接口从当前持久记录生成快照，包括：

- Session、Run、Task、Workflow、Permission 按状态计数；
- Projection Settlement 总数、待处理数和状态计数；
- SSE 客户端数、warm Agent 数、活跃和排队 Run 数；
- 从 Run、Attempt、Tool Part、Task、Workflow、Permission 和 Settlement 计算出的有界指标。

当前指标名：

| 指标 | 实际含义 |
|---|---|
| `vykor_runs_total{status}` | 数据库中各状态 Run 数 |
| `vykor_runs_active` | pending 或 running 的 Run 数 |
| `vykor_run_duration_ms` | 已有开始和结束时间的 Run 耗时 |
| `vykor_run_attempts_total{provider,model,status}` | 模型尝试次数 |
| `vykor_model_request_duration_ms{...}` | 模型尝试耗时 |
| `vykor_tokens_total{provider,model,direction}` | Attempt 记录的输入、输出 token |
| `vykor_tool_calls_total{tool,status,failure_kind}` | Tool Part 的状态和失败分类 |
| `vykor_tool_call_duration_ms{tool}` | Tool Part 从创建到更新的耗时 |
| `vykor_permissions_pending` | 待回答的权限请求数 |
| `vykor_child_agents_active` | pending 或 running 的 Agent Task 数 |
| `vykor_workflows_total{status}` | 各状态 Workflow 数 |
| `vykor_workflows_active` | running Workflow 数 |
| `vykor_workflow_duration_ms` | 已结束 Workflow 的耗时 |
| `vykor_projection_settlements_pending` | pending 或 retrying 的 Settlement 数 |
| `vykor_projection_failures_total{projector,action}` | Settlement 已记录的修复尝试次数 |

指标 label 只用有限枚举或已有名称，不放 traceId、sessionId、runId 这类无限增长的值。这样不会因为运行越多而无限制造指标序列。

## Run Inspector

`GET /debug/runs/:runId` 把一次 Run 相关的 Input、Attempt、Message、Part、Task、Permission、Event、Workflow 和 Projection Settlement 放到一个响应里。它还会给出：

- `traceIds`：相关记录出现过的 trace；
- `warnings`：终态冲突、未完成 attempt/tool、待处理 settlement 等异常；
- `diagnosticOk`：没有警告时为 `true`。

默认响应会隐藏消息正文、工具输入输出和 settlement payload，但保留 `outcome`、`failureKind`、`toolAttemptId` 等定位字段。

## 正常安静状态

系统没有工作时，下面这些值应长期回到零：

- `coordinator.activeRunCount` 和 `coordinator.queuedRunCount`；
- `vykor_runs_active`；
- `vykor_permissions_pending`；
- `vykor_child_agents_active`；
- `vykor_workflows_active`；
- `vykor_projection_settlements_pending`。

如果 Run 已是终态但 Attempt、Tool 或 Task 仍是 running，Run Inspector 应产生 warning；不要只看顶层 Run 状态就判断成功。

## Retention 与 Backup

Retention 每次运行都会向 `retention_audit` 写一条审计记录，因此当前可靠检查方式是读取 audit，而不是找一条可能丢失的日志。Backup 成功后以 `manifest.json` 和 `checksums.json` 为凭据；恢复前会重新校验所有文件。

当前 `/debug/runtime` 没有“最近一次 retention/backup 成功时间”指标。需要该能力时，应先把持久 audit/manifest 接入控制面并加契约测试，不能用进程内计数冒充 durable 结果。具体操作见 [Operations and Recovery](./operations-and-recovery.md)。

## 推荐排障顺序

1. 用 `/health` 判断 daemon 是否可达。
2. 用 `/debug/runtime` 看是否有未收尾 Run、Permission、Workflow 或 Settlement。
3. 已知 runId 时调用 Run Inspector；否则用结构化日志的 traceId 找到 runId。
4. Settlement 不为零时查看 `/debug/projection-settlements`，再按 [Projection Settlement ADR](./adr/0001-projection-settlement-failure-policy.md) 处理。
5. Owner、重启恢复、Retention 或 Backup 问题转到 [Operations and Recovery](./operations-and-recovery.md)，不要直接改 SQLite。

相关自动验证见 [契约与测试索引](./contract-test-index.md)。
