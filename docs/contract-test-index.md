# 契约与测试索引

> 状态：当前硬规则到自动测试的权威索引。最后核对：2026-10-22。

这份文档回答一个简单问题：改了某条关键规则，至少要跑哪些测试。测试文件是证据，不是文档附件；表里的链接由 `pnpm check-docs` 检查是否仍存在。

## 生命周期契约编号

| 编号 | 主要测试 |
|---|---|
| A1、A2、A3、A4、A5 | [agent.test.ts](../packages/agent-runtime/src/node/runtime/agent.test.ts)、[sdk.test.ts](../packages/agent-runtime/src/node/runtime/sdk.test.ts) |
| E1、E2、E3、E4、E5 | [event-source.test.ts](../packages/agent-runtime/src/kernel/event-source.test.ts)、[agent.test.ts](../packages/agent-runtime/src/node/runtime/agent.test.ts) |
| C1、C2、C3、C4、C5、C6 | [child-agent.test.ts](../packages/agent-runtime/src/node/runtime/child-agent.test.ts)、[child-environment.test.ts](../packages/agent-runtime/src/node/runtime/child-environment.test.ts) |
| D1、D2、D3、D4、D5、D6、D7 | [http.test.ts](../tests/server-client/http.test.ts)、[daemon-control-service.test.ts](../packages/server/src/application/control/__test__/daemon-control-service.test.ts)、[session-run-executor.test.ts](../packages/server/src/application/session/__test__/session-run-executor.test.ts)、[agent-pool.test.ts](../packages/server/src/application/agent/__test__/agent-pool.test.ts)、[daemon-lifecycle.soak.test.ts](../packages/server/src/daemon/__test__/daemon-lifecycle.soak.test.ts) |
| T1、T2、T3 | [http.test.ts](../tests/server-client/http.test.ts) |
| P1、P2、P3、P4、P5、P6、P7、P8 | [daemon-agent-event-projector.test.ts](../packages/server/src/application/agent/__test__/daemon-agent-event-projector.test.ts)、[transcript-projection.test.ts](../packages/server/src/application/session/__test__/transcript-projection.test.ts)、[event-registry.test.ts](../packages/services/src/session-runtime/__test__/event-registry.test.ts)、[projection-settlement-recovery.test.ts](../packages/server/src/application/agent/__test__/projection-settlement-recovery.test.ts) |

## Runtime Kernel

### Kernel / Node 分离（2026-10-22）

| 硬规则 | 主要测试 |
| --- | --- |
| 通用 Kernel、可靠回执、父子工具权限上限 | [kernel/index.test.ts](../packages/agent-runtime/src/kernel/index.test.ts) |
| 注入环境默认借用，转交所有权后关闭一次 | [execution-ownership.test.ts](../packages/agent-runtime/src/node/runtime/execution-ownership.test.ts) |
| 根树目录隔离和离线 MCP 认证范围 | [node-run-catalogue.test.ts](../packages/agent-runtime/src/node/capabilities/node-run-catalogue.test.ts)、[prepare-run-tools.test.ts](../packages/agent-runtime/src/node/runtime/prepare-run-tools.test.ts) |
| 应用来源必须来自可信本轮绑定 | [tool-app-origin-projector.test.ts](../packages/server/src/application/agent/__test__/tool-app-origin-projector.test.ts) |


### 模型准入与应用用例（2026-10-22）

| 硬规则 | 主要测试 |
| --- | --- |
| 每次实际请求先准入，拒绝零 Provider 调用，结算失败不重试 | [model-attempt-gate.test.ts](../packages/core/src/engine/model-attempt-gate.test.ts) |
| Goal 按真实 Run 记账，重复与未发出结算保持原规则 | [goal-model-attempt-service.test.ts](../packages/server/src/application/goals/goal-model-attempt-service.test.ts) |
| 事件重放不写 Goal 用量，child 归属保留 | [daemon-agent-event-projector.test.ts](../packages/server/src/application/agent/__test__/daemon-agent-event-projector.test.ts) |
| 应用 ready、重启释放凭证、事实归属和便签冲突 | [maintenance-restart.test.ts](../packages/server/src/http/__test__/application-maintenance-restart.test.ts)、[facts.routes.test.ts](../packages/server/src/application/personalization/facts.routes.test.ts)、[notes.test.ts](../packages/server/src/http/routes/notes.test.ts) |

### 模型网络重试（2026-09-26）

| 硬规则 | 主要测试 |
|---|---|
| 仅重试当前模型调用，次数有界、等待可取消，工具不重复执行 | [model-retry.integration.test.ts](../packages/core/src/engine/model-retry.integration.test.ts)、[model-retry.test.ts](../packages/core/src/engine/model-retry.test.ts) |
| 压缩与记忆独立缓冲重试，失败前缀不进入结果 | [buffered-model-retry.test.ts](../packages/core/src/engine/buffered-model-retry.test.ts)、[memory-runtime.test.ts](../packages/agent-runtime/src/node/memory/memory-runtime.test.ts)、[memory-extract.test.ts](../packages/services/src/__test__/memory-extract.test.ts) |
| 实时结果、SQLite 历史、客户端重放一致，投影失败不重发模型 | [model-retry-flow.test.ts](../tests/server-client/model-retry-flow.test.ts) |
| Desktop 即使跳过中间快照也正确替换输出，倒计时独立更新 | [session-subscription-service.coalescing.test.ts](../apps/desktop/src/main/features/session/session-subscription-service.coalescing.test.ts)、[model-retry-countdown.test.tsx](../apps/desktop/src/renderer/src/components/desktop/conversation-page/message/notices/__test__/model-retry-countdown.test.tsx) |
| CLI 最终 JSON 不拼接失效输出，流式 JSON 可识别替换 | [print-session.integration.test.ts](../apps/cli/src/print-session.integration.test.ts)、[renderer.test.ts](../apps/cli/src/renderer.test.ts) |

| 硬规则 | 主要测试 |
|---|---|
| Kernel 可以独立创建 Agent，不依赖 daemon、HTTP 或 UI | [kernel.test.ts](../packages/agent-runtime/src/node/runtime/host-assembly.test.ts)、[sdk.test.ts](../packages/agent-runtime/src/node/runtime/sdk.test.ts) |
| Run 完成、失败、中断后都只能得到一个终态结果 | [agent.test.ts](../packages/agent-runtime/src/node/runtime/agent.test.ts)、[event-source.test.ts](../packages/agent-runtime/src/kernel/event-source.test.ts) |
| Agent close 会继续尝试所有清理阶段 | [agent.test.ts](../packages/agent-runtime/src/node/runtime/agent.test.ts)、[default-runtime.test.ts](../packages/agent-runtime/src/node/runtime/default-runtime.test.ts) |
| Child 深度、并发和总数受全树预算限制；关闭后不能重置总数 | [child-agent.test.ts](../packages/agent-runtime/src/node/runtime/child-agent.test.ts)、[child-environment.test.ts](../packages/agent-runtime/src/node/runtime/child-environment.test.ts) |

对应契约：[Agent Lifecycle Contract](./agent-lifecycle-contract.md)、[Agent Child Session Flow](./agent-child-session-flow.md)。

## Durable 数据与收尾

| 硬规则 | 主要测试 |
|---|---|
| SQLite schema、migration、Run/Attempt/Task/Permission/Workflow 记录可以严格往返 | [store.test.ts](../packages/services/src/session-runtime/__test__/store.test.ts)、[event-registry.test.ts](../packages/services/src/session-runtime/__test__/event-registry.test.ts) |
| Run 的准入、steer、interrupt 和终态不可回退 | [run-admission-service.test.ts](../packages/server/src/application/session/__test__/run-admission-service.test.ts)、[run-control-service.test.ts](../packages/server/src/application/session/__test__/run-control-service.test.ts)、[run-coordinator.test.ts](../packages/server/src/runtime/__test__/run-coordinator.test.ts) |
| 执行器失败时仍关闭 Agent，并保留原始失败 | [session-run-executor.test.ts](../packages/server/src/application/session/__test__/session-run-executor.test.ts) |
| 成功 Run 才执行自动记忆维护，维护失败不回退 Run 终态 | [session-post-run-maintenance.test.ts](../packages/server/src/application/session/__test__/session-post-run-maintenance.test.ts)、[session-run-executor.test.ts](../packages/server/src/application/session/__test__/session-run-executor.test.ts) |
| Message/Part 投影可重试，不重复写 transcript | [transcript-projection.test.ts](../packages/server/src/application/session/__test__/transcript-projection.test.ts) |
| Child terminal 投影失败会留下 Settlement，重启后幂等修复 | [daemon-agent-event-projector.test.ts](../packages/server/src/application/agent/__test__/daemon-agent-event-projector.test.ts)、[projection-settlement-recovery.test.ts](../packages/server/src/application/agent/__test__/projection-settlement-recovery.test.ts) |
| P6：每条 durable event 必须带当前 schemaVersion | [event-registry.test.ts](../packages/services/src/session-runtime/__test__/event-registry.test.ts) |
| P7：event 名字、版本、payload 和 scope 必须全部通过 registry 校验 | [event-registry.test.ts](../packages/services/src/session-runtime/__test__/event-registry.test.ts) |
| P8：child 必需投影失败后必须保存 Settlement，修好前不能越过这条事件 | [daemon-agent-event-projector.test.ts](../packages/server/src/application/agent/__test__/daemon-agent-event-projector.test.ts)、[projection-settlement-recovery.test.ts](../packages/server/src/application/agent/__test__/projection-settlement-recovery.test.ts) |
| Owner、恢复、Retention、Backup/Restore 不留下半完成状态 | [durability-boundaries.test.ts](../packages/server/src/application/__test__/durability-boundaries.test.ts)、[daemon-lifecycle.soak.test.ts](../packages/server/src/daemon/__test__/daemon-lifecycle.soak.test.ts) |
| daemon shutdown 即使一个阶段失败也继续清理其他阶段 | [daemon-control-service.test.ts](../packages/server/src/application/control/__test__/daemon-control-service.test.ts)、[daemon-operation-gate.test.ts](../packages/server/src/application/control/__test__/daemon-operation-gate.test.ts) |

对应契约：[Durable Execution Data Model](./durable-execution-data-model.md)、[Operations and Recovery](./operations-and-recovery.md)。

## 协议与客户端同步

| 硬规则 | 主要测试 |
|---|---|
| 协议版本和 capability 必须精确匹配 | [capabilities.test.ts](../packages/protocol/src/capabilities.test.ts)、[protocol-validation.test.ts](../packages/server/src/http/routes/protocol-validation.test.ts) |
| 请求字段严格校验，错误返回固定形状 | [requests.test.ts](../packages/protocol/src/requests.test.ts)、[serialization.test.ts](../packages/protocol/src/serialization.test.ts)、[routes.test.ts](../packages/server/src/http/routes/__test__/routes.test.ts) |
| snapshot 包含 Attempt/Task 等完整状态，SSE cursor 可回放和重连 | [http.test.ts](../tests/server-client/http.test.ts)、[reducer.test.ts](../packages/client/src/state/__test__/reducer.test.ts) |
| client HTTP 封装不会偷偷改变请求或响应 | [http-client.test.ts](../packages/client/src/transport/__test__/http-client.test.ts) |
| 浏览器 client 不依赖 Node polyfill | [根测试脚本](../package.json) 中的 `test:client-browser` |

对应契约：[Protocol Contract](./protocol-contract.md)、[Client Sync Flow](./client-sync-flow.md)。

## Workflow、Jobs、Channel 与产品入口

| 硬规则 | 主要测试 |
|---|---|
| Workflow 按依赖、并发、重试和预算调度，状态可持久恢复 | [scheduler.test.ts](../packages/coordinator/src/workflow/__test__/scheduler.test.ts)、[Node workflow-host.test.ts](../packages/agent-runtime/src/node/workflow/workflow-host.test.ts)、[SQLite workflow-host.test.ts](../packages/server/src/application/workflow/__test__/workflow-host.test.ts) |
| Jobs 对不同 producer 提供同一 read/wait/send/cancel 语义 | [jobs index.test.ts](../packages/jobs/src/index.test.ts)、[daemon-job-service.test.ts](../packages/server/src/jobs/daemon-job-service.test.ts)、[job route.test.ts](../packages/server/src/http/routes/job.test.ts) |
| Channel 消息幂等进入 durable Session/Run，投递状态可重试 | [durable-bridge.test.ts](../packages/server/src/application/channel/__test__/durable-bridge.test.ts)、[channel routes.test.ts](../packages/server/src/http/routes/__test__/routes.test.ts) |
| CLI print 使用 daemon 持久状态，不创建第二套 runtime | [print-session.integration.test.ts](../apps/cli/src/print-session.integration.test.ts) |
| TUI 只通过共享 client 同步 Session，Jobs 缓存失败不破坏 Run | [useServerSync.test.tsx](../apps/frontend/src/hooks/useServerSync.test.tsx)、[job-remote-state.test.ts](../apps/frontend/src/jobs/job-remote-state.test.ts) |

对应契约：[Product Surface Integration](./product-surface-integration.md)、[Jobs Protocol](./jobs-protocol.md)、[Channels Flow](./channels-flow.md)。

## 权限与执行边界

| 硬规则 | 主要测试 |
|---|---|
| Permission 请求持久化、回复幂等、过期后不能重新批准 | [permission-broker.test.ts](../packages/server/src/permissions/__test__/permission-broker.test.ts)、[permission-controller.test.ts](../packages/server/src/permissions/__test__/permission-controller.test.ts) |
| Sandbox 统一限制命令和文件访问 | [sandbox policy.test.ts](../packages/sandbox/src/policy.test.ts)、[sandbox index.test.ts](../packages/sandbox/src/index.test.ts)、[file Edit test.ts](../packages/tools/src/file/__test__/edit.test.ts) |
| MCP manager 缺失和认证失败会明确返回错误 | [mcp-tools.test.ts](../packages/tools/src/mcp/__test__/mcp-tools.test.ts)、[mcp-auth.test.ts](../packages/agent-runtime/src/node/mcp/mcp-auth.test.ts) |

对应契约：[Security and Trust Boundaries](./security-and-trust-boundaries.md)、[Permission Flow](./permission-flow.md)、[Sandbox Runtime Flow](./sandbox-runtime-flow.md)。

## Agent 包收敛验收（P0–P6）

下表中的运行回归由 `pnpm test` 覆盖；架构反例由 `pnpm check:architecture` 执行，独立打包和浏览器构建另列。完整阶段结果见 [P6 收口记录](./superpowers/reviews/2026-10-21-agent-package-convergence-closeout.md)。

| 标准 | 具体证据 | 验证命令 |
| --- | --- | --- |
| A01 公共基础类型 | [架构反例](../scripts/architecture-boundaries.test.mjs)、[公共契约](../packages/agent-contracts/src/index.ts) | `pnpm check-types`、`pnpm check:architecture` |
| A02 Core 无宿主策略 | [Core 入口](../packages/core/src/engine/index.ts)、engine-host-types 规则反例 | `pnpm check:architecture` |
| A03 Kernel 无宿主可达引用 | [递归声明与构建反例](../packages/agent-runtime/scripts/kernel-boundary.test.mjs)、[构建检查](../packages/agent-runtime/scripts/build.mjs) | `pnpm --filter @vykor/agent-runtime test:pack` |
| A04 工具与执行宿主 | [资源所有权](../packages/agent-runtime/src/node/runtime/execution-ownership.test.ts)、tool-host-boundary 反例 | `pnpm test`、`pnpm check:architecture` |
| A05 定义、团队、Workflow | [团队树隔离](../packages/agent-runtime/src/node/runtime/team-root-isolation.test.ts)、[WorkflowHost](../packages/agent-runtime/src/node/workflow/workflow-host.test.ts) | `pnpm test` |
| A06 HTTP 与存储边界 | [架构反例](../scripts/architecture-boundaries.test.mjs)、[应用重启](../packages/server/src/http/__test__/application-maintenance-restart.test.ts) | `pnpm check:architecture`、`pnpm test` |
| A07 P0–P6 旧例外清零与依赖 | [架构策略](../scripts/architecture-policy.json)、[导入图扫描](../scripts/architecture-policy.mjs)；Protocol 迁移前的关系保留在 [P7 历史基线](./superpowers/reviews/2026-10-22-protocol-layering-baseline.md)，当前 P13 `stageExceptions` 为空 | `pnpm check:architecture` |
| B01 Run 输入、互斥与重试 | [Agent](../packages/agent-runtime/src/node/runtime/agent.test.ts)、[模型重试](../packages/core/src/engine/model-retry.integration.test.ts) | `pnpm test` |
| B02 可靠事件和结果顺序 | [事件总线](../packages/agent-runtime/src/kernel/event-source.test.ts)、[通用 Kernel](../packages/agent-runtime/src/kernel/index.test.ts) | `pnpm test` |
| B03 子运行创建、TTL 和关闭 | [ChildAgent](../packages/agent-runtime/src/node/runtime/child-agent.test.ts)、[子环境](../packages/agent-runtime/src/node/runtime/child-environment.test.ts) | `pnpm test` |
| B04 撤销、冻结与父子缩权 | [插件生命周期](../packages/agent-runtime/src/node/plugins/run-capability-lifecycle.test.ts)、[通用 Kernel](../packages/agent-runtime/src/kernel/index.test.ts) | `pnpm test` |
| B05 应用确认与可信来源 | [应用授权](../packages/server/src/application/session/__test__/session-plugin-run-authorization.test.ts)、[来源投影](../packages/server/src/application/agent/__test__/tool-app-origin-projector.test.ts) | `pnpm test` |
| B06 文件和 SQLite Workflow | [文件运行](../tests/agent-integration/file-workflow.integration.test.ts)、[应用 WorkflowHost](../packages/server/src/application/workflow/__test__/workflow-host.test.ts)、[自定义宿主取消](../packages/agent-runtime/src/node/workflow/workflow-host.child-cancellation.test.ts) | `pnpm test` |
| B07 owner 与团队隔离 | [团队树隔离](../packages/agent-runtime/src/node/runtime/team-root-isolation.test.ts)、[Workflow 关闭](../packages/agent-runtime/src/node/workflow/agent-workflow-close.test.ts) | `pnpm test` |
| B08 请求前准入与零调用拒绝 | [Engine gate](../packages/core/src/engine/model-attempt-gate.test.ts)、[Node gate](../packages/agent-runtime/src/node/runtime/model-attempt-gate.test.ts) | `pnpm test` |
| B09 用量、重复与恢复 | [Goal 准入结算](../packages/server/src/application/goals/goal-model-attempt-service.test.ts)、[持久 Goal 用量](../packages/services/src/goals/goal-usage.test.ts) | `pnpm test` |
| B10 管理用例与 lease | [维护](../packages/server/src/http/__test__/application-maintenance-restart.test.ts)、[事实](../packages/server/src/application/personalization/project-facts-service.test.ts)、[便签](../packages/server/src/application/notes/note-application-service.test.ts) | `pnpm test` |
| B11 SDK 与浏览器 | [独立消费者](../packages/agent-runtime/scripts/verify-pack.mjs)、[浏览器入口](../tests/browser-client/vite.config.ts) | `pnpm --filter @vykor/agent-runtime test:pack`、`pnpm test:client-browser` |

## 常用命令

```bash
pnpm check-docs
pnpm check-types
pnpm test
pnpm test:client-browser
```

只改一个包时先运行相关测试，例如 `pnpm --filter @vykor/agent-runtime exec vitest run <相关文件>`。根据改动范围补类型、架构或独立消费检查；没有新增跨域风险时不重复运行全量套件。

## Protocol 数据分层与通信契约（P7-P13）

P7–P13 实现与集中验收完成，当前策略的 `stageExceptions` 为零。P7 的 4,173 条关系、manifest 和样本数量继续保留为历史快照；本表列当前规则与测试入口，[最终验收记录](./superpowers/reviews/2026-10-22-protocol-layering-closeout.md)列本轮结果和平台范围。

| 检查目标 | 具体证据 | 定向入口 |
| --- | --- | --- |
| 禁止底层与应用层依赖 Protocol，拒绝隐藏包装、动态导入、别名和根入口绕行 | [架构反例](../scripts/architecture-boundaries.test.mjs)、[策略及声明扫描](../scripts/architecture-policy.mjs) | `pnpm check:architecture` |
| 纯数据沿选中声明及私有别名检查 Promise/AbortSignal；Protocol 的 Job/Terminal 来源只能是 /contracts，同文件合法数据仍允许 | [声明来源正反例](../scripts/architecture-boundaries.test.mjs)、[入口白名单](../scripts/architecture-policy.json) | `pnpm check:architecture` |
| 通用 JSON 字节、指纹、原型、canonical 20 层与有界复制 32 层 | [JSON 样本](../packages/json-data/src/json.test.ts)、[通信基线](../packages/protocol/src/layering-baseline.test.ts) | json-data `src/json.test.ts`；Protocol `src/layering-baseline.test.ts` |
| 旧模式归一化与 plan 权限上限，Client 只做显示投影 | [配置模式](../packages/host-config/src/permission-modes.test.ts)、[有效模式](../packages/permissions/src/effective-permission-mode.test.ts)、[Client 投影](../packages/client/src/runtime-configuration.test.ts) | 各文件所在包的定向 Vitest |
| 插件清单、纯 JSON、Node 绑定与租约不能替代授权 | [插件校验](../packages/plugin-contracts/src/validation.test.ts)、[Server 绑定](../packages/server/src/application/session/plugin-app-host-binding.test.ts)、[应用授权](../packages/server/src/application/session/__test__/session-plugin-run-authorization.test.ts) | 对应包定向 Vitest |
| 插件 HTTP 按结构化错误分类，拒绝输入不受文案和 Runtime bundle 影响，保持接纳与运行错误语义 | [HTTP 错误](../packages/server/src/http/routes/session-plugin-apps.errors.test.ts)、[真实资源入口](../packages/server/src/http/__test__/session-plugin-apps.test.ts)、[插件 parser](../packages/protocol/src/plugin-apps.test.ts)、[Native 后端](../packages/agent-runtime/src/node/plugin-apps/native-plugin-app-backend.test.ts)、[宿主策略](../packages/agent-runtime/src/node/plugin-apps/plugin-app-policy.test.ts) | 对应文件的定向 Vitest |
| 领域输入在非 HTTP 入口也验证，附件默认值只有一个来源 | [领域输入](../packages/domain-contracts/src/inputs/validation.test.ts)、[附件策略](../packages/services/src/attachments/attachment-policy.test.ts)、[HTTP 转换](../packages/server/src/http/mappers/boundary.test.ts) | 对应包定向 Vitest |
| Job/Terminal 数据与宿主分开，owner 与等待/取消行为保持 | [Jobs](../packages/jobs/src/index.test.ts)、[组合 Host](../packages/jobs/src/composite-agent-job-host.test.ts)、[Terminal](../packages/terminal-node/src/local-terminal-provider.test.ts) | Jobs 与 terminal-node 的相关文件 |
| Client 公开集合、辅助函数及浏览器消费保持原行为 | [公开 API](../packages/client/src/__test__/public-api.test.ts)、[类型消费者](../tests/client-public-api/consumer.ts)、[策略显示](../packages/client/src/plugin-app-policy.test.ts) | `pnpm check:client-api`、`pnpm test:client-browser` |
| Kernel 不可达三个新数据包，Node/Kernel/Workflow 独立声明与运行完整 | [Kernel 反例](../packages/agent-runtime/scripts/kernel-boundary.test.mjs)、[独立消费者](../packages/agent-runtime/scripts/verify-pack.mjs) | `node --test packages/agent-runtime/scripts/kernel-boundary.test.mjs`、Runtime `test:pack` |

## 维护规则

跨包 API/Engine/工具组合回归见 [Agent 集成测试](../tests/agent-integration/README.md)，命令为 `pnpm test:agent-integration`，已接入普通 CI 的 `pnpm test`。ToolSearch 与 Job 工具测试分别由 [搜索测试](../packages/tools/src/meta/tool-search.test.ts)和 [Job 测试](../packages/tools/src/job/job-tools.test.ts)覆盖；依赖真实 Engine/ToolRegistry 的用例保留在集成组，不引入 tools → core 的依赖。

- 新增或删除硬规则时，同时更新权威文档和本索引。
- 移动测试文件时，`pnpm check-docs` 必须失败，直到这里的链接更新。
- 一个测试可以证明多条相关规则，但不能只写“全量测试会覆盖”而不给具体入口。
- 历史计划中的测试清单不算当前证据。
