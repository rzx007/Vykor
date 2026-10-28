# 契约与测试索引

> 状态：当前硬规则到自动测试的权威索引。最后核对：2026-10-22。

这份文档回答一个简单问题：改了某条关键规则，至少要跑哪些测试。测试文件是证据，不是文档附件；表里的链接由 `pnpm check-docs` 检查是否仍存在。

## 文档维护

`pnpm check-docs` 先运行[文档检查器回归](../scripts/__test__/documentation-policy.test.mjs)，再检查根说明、docs Markdown 及模块 README 的链接、章节、状态、当前源码路径、导航和协议版本声明。历史正文只验证链接，不将旧路径和旧协议当作当前实现检查。内容权威性与维护入口见[文档维护约定](./documentation-policy.md)。

## 环境相关测试

`pnpm test` 按宿主平台运行工作区和跨包测试。补齐环境后应实际重跑，不能把平台跳过计为通过，也不能用模拟结果代替真实进程、文件系统或沙箱。

- Windows 的[WSL 脚本边界测试](../packages/sandbox/src/environment/__test__/wsl-process-boundary.test.ts)和[文件操作测试](../packages/tools/src/file/__test__/operations.test.ts)通过[公共测试帮助代码](../tests/helpers/README.md)查找 Git 中实际可执行的 `sh`，支持非默认盘符安装，不要求复制到 C 盘。
- `pnpm test:execution-integration` 运行[真实 WSL 集成](../tests/execution-node/wsl.e2e.test.ts)。需要 WSL 2、已完成首次用户初始化的默认 Linux 发行版，以及 Bash、ripgrep、procps 和 util-linux。取消用例使用 Bash 的 `exec -a` 设置进程标记，并检查取消时限和残留进程；交互终端不能停在首次创建用户的提示上。
- [办公入口](../packages/plugins/src/__test__/office-work-entry.test.ts)和[研究写作插件](../packages/agent-runtime/src/node/plugins/native-tools/__test__/knowledge-work.test.ts)兼容性检查需要真实的独立 `vykor-plugins` 源码。运行前显式设置已有的 `VYKOR_OFFICIAL_PLUGINS_DIR` 指向该仓库的 `plugins` 目录，再执行 `pnpm test`。Turbo 传入该变量；这两个包的测试不缓存外部源码结果，不自动发现相邻目录或用户安装。
- [Hooks 引号与注入安全](../packages/hooks/src/__test__/index.test.ts)的两项 POSIX 用例，以及[文件操作](../packages/tools/src/file/__test__/operations.test.ts)的可执行权限位用例，需要在 Linux 或 macOS 的 Node 中运行。Windows 的 `cmd` 和文件权限模型无法验证同一行为。在独立 Linux 检出中按锁文件安装依赖后，分别运行 `pnpm --filter @vykor/hooks exec vitest run src/__test__/index.test.ts` 和 `pnpm --filter @vykor/tools exec vitest run src/file/__test__/operations.test.ts`。
- [SRT 端到端测试](../packages/sandbox/__test__/e2e/srt.e2e.test.ts)运行真实受限命令。在 Linux 或 WSL 的 Linux Node 中安装 `@anthropic-ai/sandbox-runtime`，并提供它实际使用的 `bubblewrap` 和 `socat`，再运行 `pnpm --filter @vykor/sandbox e2e:srt`；原生 Windows 不支持这一沙箱。缺少运行器时应阻止执行的 Hooks 测试显式指定不存在的运行器，避免与这项正常运行测试的环境前提冲突。

## 生命周期契约编号

### 当前派发与真实调用

| 契约 | 自动验证入口 | 检查范围 |
|---|---|---|
| P9 当前权限 | [宿主检查](../packages/server/src/application/session/execution/__test__/tool-dispatch-check.test.ts)、[SDK 接线](../packages/agent-runtime/src/__test__/tool-dispatch-wiring.test.ts) | owner、Run、来源、修订、模型/手动/child 的当前检查 |
| P9 错误与收尾 | [受检调用](../packages/core/src/engine/tools/__test__/checked-tool-execution.test.ts)、[实际等待](../packages/core/src/engine/tools/__test__/query-tool-limits.test.ts)、[Browser 与 Job](../tests/agent-integration/__test__/job-safety.integration.test.ts) | 普通错误继续、权限拒绝、超时后真实调用结束 |

### 长结果补读与结构化交付

| 契约 | 自动验证入口 | 检查范围 |
| --- | --- | --- |
| 长结果与读取权限 | [内存存储](../packages/core/src/engine/results/__test__/memory-tool-result-archive.test.ts)、[持久读取](../packages/services/src/tool-results/__test__/tool-result-reader.test.ts)、[宿主权限](../packages/server/src/application/session/execution/__test__/tool-result-service.test.ts) | 超过 300 KB 的正文、分页/字面检索、容量边界、精确会话/来源/owner/权限版本检查 |
| 实际默认 Agent 补读 | [SDK 跨 Run](../packages/agent-runtime/src/node/agent/__test__/tool-result-reading.test.ts)、[daemon 重启](../packages/server/src/application/__test__/daemon-result-reading.integration.test.ts) | 保存先于截断、历史清理后找回、SQLite 重开、当前来源授权、同名伪造及查询不递归归档 |
| 交付收尾与业务核验 | [实际 Kernel 循环](../packages/agent-runtime/src/kernel/delivery/__test__/delivery-run.test.ts)、[实际结果与产物](../tests/agent-integration/__test__/result-delivery.integration.test.ts) | 结构纠错、派发前业务核验、回执归属、普通文本兼容与取消后的迟到核验 |
| 公共交付入口 | [请求解析](../packages/protocol/src/requests/__test__/requests.test.ts)、[准入](../packages/server/src/application/session/execution/__test__/run-admission-service.test.ts)、[客户端](../packages/client/src/resources/session/__test__/structured-delivery.test.ts) | Schema 保留、ID 冲突、格式拒绝、附加能力检查后发送 |
| 能力简化与旧数据 | [HTTP 编辑/重放](../packages/server/src/http/routes/__test__/run-execution.test.ts)、[执行入口](../packages/server/src/application/session/execution/__test__/session-run-executor.test.ts)、[应用交互](../packages/server/src/application/session/interactions/__test__/session-interaction-service.test.ts) | 只接受显式 schema、旧快照读取、合同冲突与重复编辑 |
| 查询搬运与绑定顺序 | [安全检查](../packages/server/src/application/session/execution/__test__/tool-dispatch-check.test.ts)、[结果查询](../packages/server/src/application/session/execution/__test__/tool-result-service.test.ts)、[Kernel 绑定](../packages/agent-runtime/src/kernel/__test__/result-store-binding.test.ts)、[真实子 Run](../packages/server/src/application/__test__/durable-agent-application.test.ts) | 派发检查不读历史记录、授权后分页、单次文本读取、投影后绑定、最终集合绑定 |

### 其余生命周期契约

| 编号 | 主要测试 |
|---|---|
| A1、A2、A3、A4、A5 | [agent.test.ts](../packages/agent-runtime/src/node/agent/__test__/agent.test.ts)、[sdk.test.ts](../packages/agent-runtime/src/node/agent/__test__/sdk.test.ts) |
| E1、E2、E3、E4、E5 | [event-source.test.ts](../packages/agent-runtime/src/kernel/__test__/event-source.test.ts)、[agent.test.ts](../packages/agent-runtime/src/node/agent/__test__/agent.test.ts) |
| C1、C2、C3、C4、C5、C6 | [child-agent.test.ts](../packages/agent-runtime/src/node/children/__test__/child-agent.test.ts)、[child-environment.test.ts](../packages/agent-runtime/src/node/children/__test__/child-environment.test.ts) |
| C7、C8 | [真实停止、额度和补偿](../tests/agent-integration/__test__/child-run-settlement.integration.test.ts)、[真实工厂启动与清理](../packages/agent-runtime/src/node/children/__test__/child-run-settlement.test.ts)、[单一实际结果](../packages/agent-runtime/src/node/runtime/__test__/framework-agent-run-settlement.test.ts) |
| D1、D2、D3、D4、D5、D6、D7 | [http.test.ts](../tests/server-client/http.test.ts)、[daemon-control-service.test.ts](../packages/server/src/application/control/__test__/daemon-control-service.test.ts)、[session-run-executor.test.ts](../packages/server/src/application/session/execution/__test__/session-run-executor.test.ts)、[agent-pool.test.ts](../packages/server/src/application/agent/__test__/agent-pool.test.ts)、[daemon-lifecycle.soak.test.ts](../packages/server/src/http/__test__/daemon-lifecycle.soak.test.ts) |
| T1、T2、T3 | [http.test.ts](../tests/server-client/http.test.ts) |
| P1、P2、P3、P4、P5、P6、P7、P8 | [daemon-agent-event-projector.test.ts](../packages/server/src/application/agent/__test__/daemon-agent-event-projector.test.ts)、[transcript-projection.test.ts](../packages/server/src/application/session/transcript/__test__/transcript-projection.test.ts)、[event-registry.test.ts](../packages/services/src/session-runtime/events/__test__/event-registry.test.ts)、[projection-settlement-recovery.test.ts](../packages/server/src/application/agent/__test__/projection-settlement-recovery.test.ts) |

## Runtime Kernel

### Kernel / Node 分离（2026-10-22）

| 硬规则 | 主要测试 |
| --- | --- |
| 通用 Kernel、可靠回执、父子工具权限上限 | [kernel/index.test.ts](../packages/agent-runtime/src/kernel/__test__/index.test.ts) |
| 注入环境默认借用，转交所有权后关闭一次 | [execution-ownership.test.ts](../packages/agent-runtime/src/node/runtime/__test__/execution-ownership.test.ts) |
| 根树目录隔离和离线 MCP 认证范围 | [node-run-catalogue.test.ts](../packages/agent-runtime/src/node/capabilities/__test__/node-run-catalogue.test.ts)、[prepare-run-tools.test.ts](../packages/agent-runtime/src/node/tools/__test__/prepare-run-tools.test.ts) |
| 应用来源必须来自可信本轮绑定 | [tool-app-origin-projector.test.ts](../packages/server/src/application/agent/__test__/tool-app-origin-projector.test.ts) |


### 模型准入与应用用例（2026-10-22）

| 硬规则 | 主要测试 |
| --- | --- |
| 每次实际请求先准入，拒绝零 Provider 调用，结算失败不重试 | [model-attempt-gate.test.ts](../packages/core/src/engine/model/__test__/model-attempt-gate.test.ts) |
| Goal 按真实 Run 记账，重复与未发出结算保持原规则 | [goal-model-attempt-service.test.ts](../packages/server/src/application/goals/__test__/goal-model-attempt-service.test.ts) |
| 事件重放不写 Goal 用量，child 归属保留 | [daemon-agent-event-projector.test.ts](../packages/server/src/application/agent/__test__/daemon-agent-event-projector.test.ts) |
| 应用 ready、重启释放凭证、事实归属和便签冲突 | [maintenance-restart.test.ts](../packages/server/src/http/__test__/application-maintenance-restart.test.ts)、[facts.routes.test.ts](../packages/server/src/application/personalization/__test__/facts.routes.test.ts)、[notes.test.ts](../packages/server/src/http/routes/__test__/notes.test.ts) |

### 模型网络重试（2026-09-26）

| 硬规则 | 主要测试 |
|---|---|
| 仅重试当前模型调用，次数有界、等待可取消，工具不重复执行 | [model-retry.integration.test.ts](../packages/core/src/engine/model/__test__/model-retry.integration.test.ts)、[model-retry.test.ts](../packages/core/src/engine/model/__test__/model-retry.test.ts) |
| 压缩与记忆独立缓冲重试，失败前缀不进入结果 | [buffered-model-retry.test.ts](../packages/core/src/engine/model/__test__/buffered-model-retry.test.ts)、[memory-runtime.test.ts](../packages/agent-runtime/src/node/memory/__test__/memory-runtime.test.ts)、[memory-extract.test.ts](../packages/services/src/memory/__test__/memory-extract.test.ts) |
| 实时结果、SQLite 历史、客户端重放一致，投影失败不重发模型 | [model-retry-flow.test.ts](../tests/server-client/model-retry-flow.test.ts) |
| Desktop 即使跳过中间快照也正确替换输出，倒计时独立更新；Write 生成状态到正式执行只交接一次 | [session-subscription-service.coalescing.test.ts](../apps/desktop/src/main/features/session/session-subscription-service.coalescing.test.ts)、[model-retry-countdown.test.tsx](../apps/desktop/src/renderer/src/components/desktop/conversation-page/message/notices/__test__/model-retry-countdown.test.tsx)、[跨包 Write 流程](../tests/desktop-integration/__test__/session-write-generation.test.ts)（`pnpm test:desktop-integration`） |
| CLI 最终 JSON 不拼接失效输出，流式 JSON 可识别替换 | [print-session.integration.test.ts](../apps/cli/src/print-session.integration.test.ts)、[renderer.test.ts](../apps/cli/src/renderer.test.ts) |

| 硬规则 | 主要测试 |
|---|---|
| Kernel 可以独立创建 Agent，不依赖 daemon、HTTP 或 UI | [kernel.test.ts](../packages/agent-runtime/src/node/agent/__test__/host-assembly.test.ts)、[sdk.test.ts](../packages/agent-runtime/src/node/agent/__test__/sdk.test.ts) |
| Run 完成、失败、中断后都只能得到一个终态结果 | [agent.test.ts](../packages/agent-runtime/src/node/agent/__test__/agent.test.ts)、[event-source.test.ts](../packages/agent-runtime/src/kernel/__test__/event-source.test.ts) |
| Agent close 会继续尝试所有清理阶段 | [agent.test.ts](../packages/agent-runtime/src/node/agent/__test__/agent.test.ts)、[default-runtime.test.ts](../packages/agent-runtime/src/node/runtime/__test__/default-runtime.test.ts) |
| Child 深度、并发和总数受全树预算限制；关闭后不能重置总数 | [child-agent.test.ts](../packages/agent-runtime/src/node/children/__test__/child-agent.test.ts)、[child-environment.test.ts](../packages/agent-runtime/src/node/children/__test__/child-environment.test.ts) |

对应契约：[Agent Lifecycle Contract](./agent-lifecycle-contract.md)、[Agent Child Session Flow](./agent-child-session-flow.md)。

## Durable 数据与收尾

| 硬规则 | 主要测试 |
|---|---|
| SQLite schema、migration、Run/Attempt/Task/Permission/Workflow 记录可以严格往返 | [store.test.ts](../packages/services/src/session-runtime/__test__/store.test.ts)、[event-registry.test.ts](../packages/services/src/session-runtime/events/__test__/event-registry.test.ts) |
| Run 的准入、steer、interrupt 和终态不可回退 | [run-admission-service.test.ts](../packages/server/src/application/session/execution/__test__/run-admission-service.test.ts)、[run-control-service.test.ts](../packages/server/src/application/session/execution/__test__/run-control-service.test.ts)、[run-coordinator.test.ts](../packages/server/src/runtime/__test__/run-coordinator.test.ts) |
| 执行器失败时仍关闭 Agent，并保留原始失败 | [session-run-executor.test.ts](../packages/server/src/application/session/execution/__test__/session-run-executor.test.ts) |
| 成功 Run 才执行自动记忆维护，维护失败不回退 Run 终态 | [session-post-run-maintenance.test.ts](../packages/server/src/application/session/maintenance/__test__/session-post-run-maintenance.test.ts)、[session-run-executor.test.ts](../packages/server/src/application/session/execution/__test__/session-run-executor.test.ts) |
| Message/Part 投影可重试，不重复写 transcript | [transcript-projection.test.ts](../packages/server/src/application/session/transcript/__test__/transcript-projection.test.ts) |
| Child terminal 投影失败会留下 Settlement，重启后幂等修复 | [daemon-agent-event-projector.test.ts](../packages/server/src/application/agent/__test__/daemon-agent-event-projector.test.ts)、[projection-settlement-recovery.test.ts](../packages/server/src/application/agent/__test__/projection-settlement-recovery.test.ts) |
| P6：每条 durable event 必须带当前 schemaVersion | [event-registry.test.ts](../packages/services/src/session-runtime/events/__test__/event-registry.test.ts) |
| P7：event 名字、版本、payload 和 scope 必须全部通过 registry 校验 | [event-registry.test.ts](../packages/services/src/session-runtime/events/__test__/event-registry.test.ts) |
| P8：child 必需投影失败后必须保存 Settlement，修好前不能越过这条事件 | [daemon-agent-event-projector.test.ts](../packages/server/src/application/agent/__test__/daemon-agent-event-projector.test.ts)、[projection-settlement-recovery.test.ts](../packages/server/src/application/agent/__test__/projection-settlement-recovery.test.ts) |
| Owner、恢复、Retention、Backup/Restore 不留下半完成状态 | [durability-boundaries.test.ts](../packages/server/src/application/__test__/durability-boundaries.test.ts)、[daemon-lifecycle.soak.test.ts](../packages/server/src/http/__test__/daemon-lifecycle.soak.test.ts) |
| daemon shutdown 即使一个阶段失败也继续清理其他阶段 | [daemon-control-service.test.ts](../packages/server/src/application/control/__test__/daemon-control-service.test.ts)、[daemon-operation-gate.test.ts](../packages/server/src/application/control/__test__/daemon-operation-gate.test.ts) |

对应契约：[Durable Execution Data Model](./durable-execution-data-model.md)、[Operations and Recovery](./operations-and-recovery.md)。

## 协议与客户端同步

| 硬规则 | 主要测试 |
|---|---|
| 协议版本和 capability 必须精确匹配 | [capabilities.test.ts](../packages/protocol/src/runtime/__test__/capabilities.test.ts)、[protocol-validation.test.ts](../packages/server/src/http/routes/__test__/protocol-validation.test.ts) |
| 请求字段严格校验，错误返回固定形状 | [requests.test.ts](../packages/protocol/src/requests/__test__/requests.test.ts)、[serialization.test.ts](../packages/protocol/src/serialization/__test__/serialization.test.ts)、[routes.test.ts](../packages/server/src/http/routes/__test__/routes.test.ts) |
| snapshot 包含 Attempt/Task 等完整状态，SSE cursor 可回放和重连 | [http.test.ts](../tests/server-client/http.test.ts)、[reducer.test.ts](../packages/client/src/state/__test__/reducer.test.ts) |
| client HTTP 封装不会偷偷改变请求或响应 | [http-client.test.ts](../packages/client/src/transport/__test__/http-client.test.ts) |
| 浏览器 client 不依赖 Node polyfill | [根测试脚本](../package.json) 中的 `test:client-browser` |

对应契约：[Protocol Contract](./protocol-contract.md)、[Client Sync Flow](./client-sync-flow.md)。

## Workflow、Jobs、Channel 与产品入口

| 硬规则 | 主要测试 |
|---|---|
| Workflow 按依赖、并发、重试和预算调度，状态可持久恢复 | [scheduler.test.ts](../packages/coordinator/src/workflow/__test__/scheduler.test.ts)、[Node workflow-host.test.ts](../packages/agent-runtime/src/node/workflow/__test__/workflow-host.test.ts)、[SQLite workflow-host.test.ts](../packages/server/src/application/workflow/__test__/workflow-host.test.ts) |
| Jobs 对不同 producer 提供同一 read/wait/send/cancel 语义 | [jobs index.test.ts](../packages/jobs/src/__test__/index.test.ts)、[daemon-job-service.test.ts](../packages/server/src/jobs/__test__/daemon-job-service.test.ts)、[job route.test.ts](../packages/server/src/http/routes/__test__/job.test.ts) |
| Channel 消息幂等进入 durable Session/Run，投递状态可重试 | [durable-bridge.test.ts](../packages/server/src/application/channel/__test__/durable-bridge.test.ts)、[channel routes.test.ts](../packages/server/src/http/routes/__test__/routes.test.ts) |
| CLI print 使用 daemon 持久状态，不创建第二套 runtime | [print-session.integration.test.ts](../apps/cli/src/print-session.integration.test.ts) |
| TUI 只通过共享 client 同步 Session，Jobs 缓存失败不破坏 Run | [useServerSync.test.tsx](../apps/frontend/src/hooks/useServerSync.test.tsx)、[job-remote-state.test.ts](../apps/frontend/src/jobs/job-remote-state.test.ts) |

对应契约：[Product Surface Integration](./product-surface-integration.md)、[Jobs Protocol](./jobs-protocol.md)、[Channels Flow](./channels-flow.md)。

## 权限与执行边界

| 硬规则 | 主要测试 |
|---|---|
| Permission 请求持久化、回复幂等、过期后不能重新批准 | [permission-broker.test.ts](../packages/server/src/permissions/__test__/permission-broker.test.ts)、[permission-controller.test.ts](../packages/server/src/permissions/__test__/permission-controller.test.ts) |
| Sandbox 统一限制命令和文件访问 | [sandbox policy.test.ts](../packages/sandbox/src/policy/__test__/policy.test.ts)、[sandbox index.test.ts](../packages/sandbox/src/__test__/index.test.ts)、[file Edit test.ts](../packages/tools/src/file/editing/__test__/edit.test.ts) |
| MCP manager 缺失和认证失败会明确返回错误 | [mcp-tools.test.ts](../packages/tools/src/mcp/__test__/mcp-tools.test.ts)、[mcp-auth.test.ts](../packages/agent-runtime/src/node/mcp/__test__/mcp-auth.test.ts) |

对应契约：[Security and Trust Boundaries](./security-and-trust-boundaries.md)、[Permission Flow](./permission-flow.md)、[Sandbox Runtime Flow](./sandbox-runtime-flow.md)。

## Agent 包收敛验收（P0–P6）

下表中的运行回归由 `pnpm test` 覆盖；架构反例由 `pnpm check:architecture` 执行，独立打包和浏览器构建另列。完整阶段结果见 [P6 收口记录](./superpowers/reviews/2026-10-21-agent-package-convergence-closeout.md)。

| 标准 | 具体证据 | 验证命令 |
| --- | --- | --- |
| A01 公共基础类型 | [架构反例](../scripts/architecture-boundaries.test.mjs)、[公共契约](../packages/agent-contracts/src/index.ts) | `pnpm check-types`、`pnpm check:architecture` |
| A02 Core 无宿主策略 | [Core 入口](../packages/core/src/engine/index.ts)、engine-host-types 规则反例 | `pnpm check:architecture` |
| A03 Kernel 无宿主可达引用 | [递归声明与构建反例](../packages/agent-runtime/scripts/__test__/kernel-boundary.test.mjs)、[构建检查](../packages/agent-runtime/scripts/build.mjs) | `pnpm --filter @vykor/agent-runtime test:pack` |
| A04 工具与执行宿主 | [资源所有权](../packages/agent-runtime/src/node/runtime/__test__/execution-ownership.test.ts)、tool-host-boundary 反例 | `pnpm test`、`pnpm check:architecture` |
| A05 定义、团队、Workflow | [团队树隔离](../packages/agent-runtime/src/node/children/__test__/team-root-isolation.test.ts)、[WorkflowHost](../packages/agent-runtime/src/node/workflow/__test__/workflow-host.test.ts) | `pnpm test` |
| A06 HTTP 与存储边界 | [架构反例](../scripts/architecture-boundaries.test.mjs)、[应用重启](../packages/server/src/http/__test__/application-maintenance-restart.test.ts) | `pnpm check:architecture`、`pnpm test` |
| A07 P0–P6 旧例外清零与依赖 | [架构策略](../scripts/architecture-policy.json)、[导入图扫描](../scripts/architecture-policy.mjs)；Protocol 迁移前的关系保留在 [P7 历史基线](./superpowers/reviews/2026-10-22-protocol-layering-baseline.md)，当前 P13 `stageExceptions` 为空 | `pnpm check:architecture` |
| B01 Run 输入、互斥与重试 | [Agent](../packages/agent-runtime/src/node/agent/__test__/agent.test.ts)、[模型重试](../packages/core/src/engine/model/__test__/model-retry.integration.test.ts) | `pnpm test` |
| B02 可靠事件和结果顺序 | [事件总线](../packages/agent-runtime/src/kernel/__test__/event-source.test.ts)、[通用 Kernel](../packages/agent-runtime/src/kernel/__test__/index.test.ts) | `pnpm test` |
| B03 子运行创建、TTL 和关闭 | [ChildAgent](../packages/agent-runtime/src/node/children/__test__/child-agent.test.ts)、[子环境](../packages/agent-runtime/src/node/children/__test__/child-environment.test.ts) | `pnpm test` |
| B04 撤销、冻结与父子缩权 | [插件生命周期](../packages/agent-runtime/src/node/plugins/__test__/run-capability-lifecycle.test.ts)、[通用 Kernel](../packages/agent-runtime/src/kernel/__test__/index.test.ts) | `pnpm test` |
| B05 应用确认与可信来源 | [应用授权](../packages/server/src/application/session/plugins/__test__/session-plugin-run-authorization.test.ts)、[来源投影](../packages/server/src/application/agent/__test__/tool-app-origin-projector.test.ts) | `pnpm test` |
| B06 文件和 SQLite Workflow | [文件运行](../tests/agent-integration/file-workflow.integration.test.ts)、[应用 WorkflowHost](../packages/server/src/application/workflow/__test__/workflow-host.test.ts)、[自定义宿主取消](../packages/agent-runtime/src/node/workflow/__test__/workflow-host.child-cancellation.test.ts) | `pnpm test` |
| B07 owner 与团队隔离 | [团队树隔离](../packages/agent-runtime/src/node/children/__test__/team-root-isolation.test.ts)、[Workflow 关闭](../packages/agent-runtime/src/node/workflow/__test__/agent-workflow-close.test.ts) | `pnpm test` |
| B08 请求前准入与零调用拒绝 | [Engine gate](../packages/core/src/engine/model/__test__/model-attempt-gate.test.ts)、[Node gate](../packages/agent-runtime/src/node/runtime/__test__/model-attempt-gate.test.ts) | `pnpm test` |
| B09 用量、重复与恢复 | [Goal 准入结算](../packages/server/src/application/goals/__test__/goal-model-attempt-service.test.ts)、[持久 Goal 用量](../packages/services/src/goals/__test__/goal-usage.test.ts) | `pnpm test` |
| B10 管理用例与 lease | [维护](../packages/server/src/http/__test__/application-maintenance-restart.test.ts)、[事实](../packages/server/src/application/personalization/__test__/project-facts-service.test.ts)、[便签](../packages/server/src/application/notes/__test__/note-application-service.test.ts) | `pnpm test` |
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
| 通用 JSON 字节、指纹、原型、canonical 20 层与有界复制 32 层 | [JSON 样本](../packages/json-data/src/__test__/json.test.ts)、[通信基线](../packages/protocol/src/__test__/layering-baseline.test.ts) | json-data `src/json.test.ts`；Protocol `src/layering-baseline.test.ts` |
| 旧模式归一化与 plan 权限上限，Client 只做显示投影 | [配置模式](../packages/host-config/src/permissions/__test__/permission-modes.test.ts)、[有效模式](../packages/permissions/src/__test__/effective-permission-mode.test.ts)、[Client 投影](../packages/client/src/configuration/__test__/runtime-configuration.test.ts) | 各文件所在包的定向 Vitest |
| 插件清单、纯 JSON、Node 绑定与租约不能替代授权 | [插件校验](../packages/plugin-contracts/src/manifest/__test__/validation.test.ts)、[Server 绑定](../packages/server/src/application/session/plugins/__test__/plugin-app-host-binding.test.ts)、[应用授权](../packages/server/src/application/session/plugins/__test__/session-plugin-run-authorization.test.ts) | 对应包定向 Vitest |
| 插件 HTTP 按结构化错误分类，拒绝输入不受文案和 Runtime bundle 影响，保持接纳与运行错误语义 | [HTTP 错误](../packages/server/src/http/routes/__test__/session-plugin-apps.errors.test.ts)、[真实资源入口](../packages/server/src/http/__test__/session-plugin-apps.test.ts)、[插件 parser](../packages/protocol/src/extensions/__test__/plugin-apps.test.ts)、[Native 后端](../packages/agent-runtime/src/node/plugin-apps/__test__/native-plugin-app-backend.test.ts)、[宿主策略](../packages/agent-runtime/src/node/plugin-apps/__test__/plugin-app-policy.test.ts) | 对应文件的定向 Vitest |
| 领域输入在非 HTTP 入口也验证，附件默认值只有一个来源 | [领域输入](../packages/domain-contracts/src/inputs/__test__/validation.test.ts)、[附件策略](../packages/services/src/attachments/__test__/attachment-policy.test.ts)、[HTTP 转换](../packages/server/src/http/mappers/__test__/boundary.test.ts) | 对应包定向 Vitest |
| Job/Terminal 数据与宿主分开，owner 与等待/取消行为保持 | [Jobs](../packages/jobs/src/__test__/index.test.ts)、[定点路由](../packages/jobs/src/__test__/routed-agent-job-host.test.ts)、[Terminal](../packages/terminal-node/src/providers/__test__/local-terminal-provider.test.ts) | Jobs 与 terminal-node 的相关文件 |
| Client 公开集合、辅助函数及浏览器消费保持原行为 | [公开 API](../packages/client/src/__test__/public-api.test.ts)、[类型消费者](../tests/client-public-api/consumer.ts)、[策略显示](../packages/client/src/resources/plugins/__test__/plugin-app-policy.test.ts) | `pnpm check:client-api`、`pnpm test:client-browser` |
| Kernel 不可达三个新数据包，Node/Kernel/Workflow 独立声明与运行完整 | [Kernel 反例](../packages/agent-runtime/scripts/__test__/kernel-boundary.test.mjs)、[独立消费者](../packages/agent-runtime/scripts/verify-pack.mjs) | `node --test packages/agent-runtime/scripts/__test__/kernel-boundary.test.mjs`、Runtime `test:pack` |

## 日常续做与交付闭环

| 检查目标 | 具体证据 | 定向入口 |
| --- | --- | --- |
| 重开不重发原任务，压缩保留执行状态和结果引用，新调用重新通过当前权限检查 | [日常重开](../packages/server/src/application/__test__/daemon-daily-continuation.integration.test.ts)、[摘要原文事实](../packages/core/src/engine/compaction/__test__/compact-continuity.test.ts) | Server、Core 对应文件的定向 Vitest |
| 当前宿主检查、普通错误连续执行和独立结果补读 | [派发前检查](../packages/server/src/application/session/execution/__test__/tool-dispatch-check.test.ts)、[实际 Browser/Shell](../packages/server/src/application/__test__/unknown-outcome-default.test.ts)、[独立结果存储](../packages/services/src/tool-results/__test__/tool-result-reader.test.ts) | Server、Services 对应文件的定向 Vitest |
| 自动评审消费真实结构化回执，普通文本不能冒充；交付与 Goal 完成矛盾时暂停 | [真实系统子 Agent 评审](../packages/server/src/application/auto-review/__test__/auto-review.integration.test.ts)、[消费与核验](../packages/server/src/application/auto-review/__test__/session-auto-review-service.test.ts)、[Goal 结算](../packages/server/src/application/session/goals/__test__/session-goal-service.test.ts)、[回执投影](../packages/server/src/application/agent/__test__/daemon-agent-event-projector.test.ts) | Server 对应文件的定向 Vitest |

## 维护规则

跨包 API/Engine/工具组合回归见 [Agent 集成测试](../tests/agent-integration/README.md)，命令为 `pnpm test:agent-integration`，已接入普通 CI 的 `pnpm test`。ToolSearch 与 Job 工具测试分别由 [搜索测试](../packages/tools/src/meta/__test__/tool-search.test.ts)和 [Job 测试](../packages/tools/src/job/__test__/job-tools.test.ts)覆盖；依赖真实 Engine/ToolRegistry 的用例保留在集成组，不引入 tools → core 的依赖。

- 新增或删除硬规则时，同时更新权威文档和本索引。
- 移动测试文件时，`pnpm check-docs` 必须失败，直到这里的链接更新。
- 一个测试可以证明多条相关规则，但不能只写“全量测试会覆盖”而不给具体入口。
- 历史计划中的测试清单不算当前证据。

## 共用执行核心与真实 Workflow 验收

| 硬规则 | 主要测试 |
| --- | --- |
| SDK/daemon 真实三轮各 12 worker、默认并发 8/累计 64、第九拒绝、取消和 deadline 实际调用/清理、迟到旧 attempt、审批/保留后代、同身份恢复与当前授权 | [真实 Workflow 生命周期](../tests/agent-integration/__test__/workflow-child-lifecycle.integration.test.ts) |
| 查询失败不替代 worker、固定 run 回执、memory/file 公共断言、未知回执不能被取消伪造确认 | [真实 runner](../packages/agent-runtime/src/node/workflow/__test__/agent-workflow-runner.test.ts)、[宿主](../packages/agent-runtime/src/node/workflow/__test__/workflow-host.test.ts)、[公共场景](../tests/workflow/lifecycle-scenarios.ts) |
| 唯一 coordinator deadline/宽限、实际停止前不重试、旧 attempt 进度隔离、未知停止错误 | [调度器](../packages/coordinator/src/workflow/__test__/scheduler.test.ts) |
| 普通/Workflow/system inherit 环境前解析、同 tick send/suspend 串行、历史和实例保留 | [子运行](../packages/agent-runtime/src/node/children/__test__/child-agent.test.ts)、[配置](../packages/agent-runtime/src/node/children/__test__/child-agent-options.test.ts) |
| 删除 adapter、process 回退、重复 timer 与 daemon 生命周期分支 | [架构边界](../scripts/architecture-boundaries.test.mjs) |
