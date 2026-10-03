# Native Plugin UI A2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 状态：任务 1–6 已实现并经任务审查；任务 7 已补充跨层回归与文档，最终独立分支审查待完成。验收证据见 [A2 验收记录](../reviews/2026-10-03-native-plugin-ui-a2-verification.md)。现有 codex/plugin-ui-a1 隔离工作区，基线为 1be4f0c7；不包含 A3 / A4。

**Goal:** 原生工具结果生成可信持久 UI 实例，用户操作通过同一受检工具流程执行，并经现有 HTTP / Client / SSE 查询和恢复。

**Architecture:** Kernel 提取共享工具执行，Runtime 固定插件定义与工具调用函数，Application 保存 UI 实例和无模型的操作 Run。状态复用 Part/Run metadata、SQLite 事务及会话车道，不新增表或独立调度器。

**Tech Stack:** 现有 TypeScript、Vitest、Node crypto/fs、SessionStore、Hono、VykorClient；不新增第三方依赖。

**Spec:** [完整规格](../specs/2026-10-02-native-plugin-ui-design.md)，主要落实 UI-05–UI-16 和 A2 相关的 UI-21、UI-22、UI-25、UI-26。

## Global Constraints

- UI 操作只使用声明的同插件 Native Tool，不开放 builtin、其他插件或 MCP。
- UI 不能绕过检查直接调用 ToolRegistry、Tool Host 或 tool.execute()。
- 初始工具正常结束，UI 操作是没有 inputId 的独立 Run；不请求模型、不创建虚假 Attempt、不自动唤醒 Goal。
- 固定源 Run 的插件版本、行为摘要、组件摘要和工具调用函数；不从当前全局目录猜原始来源。
- 单实例 data：JSON UTF-8 256 KiB；动作 args：64 KiB；JSON 深度：20。
- 请求 ID 为 UUID，同一个 requestId 只执行一次；不同参数复用同一 ID 为冲突。
- busy、closing、archived、终态、旧 revision、旧快照、未授权和 unknown 均拒绝新工具操作。
- unknown 不重放原动作；业务实例仍可查看和取消交互。
- 工具结果 proposal.ui 属于外部数据；pluginUi 和 uiAction 是宿主保留 metadata。
- 使用现有 Part/Run、事务、SSE、会话执行车道、权限和取消链路；不新增业务表。
- 本阶段只交付后台与 Client。隔离文档协议、iframe、前端 SDK 和卡片挂载仍属于 A3。
- 如果 A2 尚缺任一接线或验收，不公布 features.pluginUi。

## 文件与任务边界

| 任务 | 主要文件 | 下游消费 |
| --- | --- | --- |
| 1 | core/engine/checked-tool-execution.ts、query-engine.ts、types/runtime.ts | 无模型单工具执行入口 |
| 2 | protocol/plugin-ui.ts、plugin-ui-requests.ts、core/tool-result-feedback.ts、protocol/requests.ts | UI 记录、严格请求和保留字段 |
| 3 | agent-runtime/runtime-integrations.ts、run-capability-view.ts、agent.ts、core/types/runtime.ts | 精确 UI 能力视图与宿主 runTool |
| 4 | server/application/session/session-plugin-ui-service.ts、transcript-projection.ts、session-run-executor.ts | 工具结果与 UI 实例绑定 |
| 5 | session-plugin-ui-action-executor.ts、session-run-engine.ts、恢复与输入材料 | 原子准入、执行、恢复和模型摘要 |
| 6 | daemon-application.ts、http/routes/session-plugin-ui.ts、client/resources/plugin-ui-resource.ts | 可查询的实际后台功能 |
| 7 | 跨层集成、公开契约、作者文档、验收记录 | A2 可独立发布的证据 |

任务按顺序执行，每项独立审查后才进入依赖任务。当前 main 工作区不修改、不合并、不推送。

## Task 1: 提取共享工具执行与 QueryEngine 单工具入口

**Files:** 新增 packages/core/src/engine/checked-tool-execution.ts 和聚焦测试；修改 query-engine.ts、types/runtime.ts、index.ts。只修改这些职责相关文件。

**Interfaces:** `executeCheckedTools(options: CheckedToolExecutionOptions): Promise<CheckedToolExecutionResult>`。QueryEngine 新增 `executeTool(toolUse: ToolUseBlock, options: { signal?: AbortSignal; execution: AgentExecutionContext }): Promise<ToolExecutionResult>`。不改变 submitMessage 或现有模型批次语义。

CheckedToolExecutionOptions 的明确输入是 toolUses、toolRegistry、messages、permissionChecker、hookExecutor、signal、execution、timeoutMs、internalTools、failedToolCalls、createToolContext(toolUse, toolAttemptId)、isTrustedSummary(toolUse, definition)。结果为 `{ results: ToolExecutionResult[]; failure?: { error: unknown } }`。可选项与当前 executeTools 默认值一致。

- [ ] 写失败测试：向 QueryEngine.executeTool 提供一个捕获的 Native 插件工具和 execution，调用后得到真实结果；StreamingMessageClient 的调用计数仍为 0，history 保持原样。
- [ ] 运行聚焦用例，确认缺少单工具入口是失败原因。
- [ ] 将当前 executeTools 的准备、组序、许可、超时、异常事实、生命周期与 post Hook 移到共享函数，QueryEngine 的 executeTools 调用它。上下文仍由 QueryEngine 拥有的能力构造，不接受外部传入任意 ToolContext。
- [ ] 单工具入口固定工具来自 execution.capabilityView；缺少视图或工具拒绝。使用空消息历史，不允许从模型旧消息复用参数；在本入口不保存模型 tool exchange、不请求模型、不消费 Token。
- [ ] 通过普通授权、Hook、取消、超时和捕获 invoke 执行；不能绕过现有 executeTools 路径而直接调用 definition.execute。
- [ ] 回归现有 query-tool-permissions、tool-input-reuse、tool-workflow、query-tool-limits、run-capability 与 serialGroup / batch cancellation 用例，core check-types。

测试主断言应是实际工具输入/返回、权限拒绝时无副作用、取消时 executionState，以及模型请求计数。示例：

```ts
const before = engine.getHistory();
const result = await engine.executeTool({ type: "tool_use", id: "ui-call", name: "Inspect", input: { text: "hello" } }, { execution });
expect(result.content).toEqual([{ type: "text", text: "hello" }]);
expect(clientCalls).toBe(0);
expect(engine.getHistory()).toEqual(before);
```

engine、execution、clientCalls 由该测试现有 QueryEngine fixture 创建；工具的 invoke 返回上述文本且登记 plugin 来源。新增测试文件需要在文件内完整创建 fixture，不能只粘贴此断言。

## Task 2: 共享记录、请求与宿主元数据保护

**Files:** protocol/plugin-ui.ts、新增 plugin-ui-requests.ts 和测试、protocol/index.ts / requests.ts；core/engine/tool-result-feedback.ts 与测试。

**Interfaces:** 逐字段采用 Spec 第 8–10 节的 PluginUiProposal、PluginUiInstanceRecord、InvokePluginUiActionInput、PluginUiActionReceipt、PluginUiActionRunMetadata。新增 `parseInvokePluginUiActionInput(value: unknown)`、`parseDismissPluginUiInput(value: unknown)`、`readPluginUiInstance(value: unknown)`、`readPluginUiAction(value: unknown)`；读取器面对无效或未知版本返回 undefined，请求 decoder 抛 ProtocolValidationError。

- [ ] 写失败测试：拒绝未知字段、非 UUID requestId、非安全整数 revision、超大/deep/非有限数字 args；仅接受 `{ requestId, expectedRevision, actionId, args }`，dismiss 仅 requestId / expectedRevision。
- [ ] 定义记录并添加 dataBytes=262144、actionArgsBytes=65536 到共享限额。以 TextEncoder 计算 UTF-8 JSON 字节数，先检查限额，再交给业务层；数据不截断。
- [ ] 严格读取可信记录，要求 ID、版本、64 位十六进制摘要、source 归属、状态、revision、有限时间、有限 JSON data 全部有效。动作读取同时要求宿主命名空间与完整来源。
- [ ] externalToolMetadata 移除 pluginUi / uiAction，但保留 ui proposal。Prompt 准入 / 客户端 runMetadata 拒绝两个宿主名称，不能伪造无模型运行。
- [ ] API 输出仍沿用原 content 与通用 metadata；UI data 不拼进模型的 tool result content。
- [ ] 运行 protocol / core 聚焦测试和类型检查。

```ts
expect(externalToolMetadata({ pluginUi: { pluginId: "fake" }, uiAction: {}, ui: proposal }))
  .toEqual({ ui: proposal });
expect(() => parseInvokePluginUiActionInput({ ...validInput, toolName: "Bash" })).toThrow();
expect(readPluginUiInstance({ ...instance, revision: -1 })).toBeUndefined();
```

测试中的 validInput、instance、proposal 是独立手写的完整 Spec 记录，不能用生产读取器生成预期值。

## Task 3: Runtime 捕获来源与无模型 Agent 工具调用

**Files:** agent-runtime/run-capability-view.ts、runtime-integrations.ts、agent.ts 与测试；core/types/runtime.ts 中增加类型，不添加 daemon 依赖。

**Interfaces:** `RunPluginUiBinding` 包含 pluginId / pluginVersion / pluginDigest / componentId / componentDigest / htmlSha256 / root / entryPath / definition。`RunCapabilityView.pluginUi?: ReadonlyMap<string, RunPluginUiBinding>` 按 `${pluginId}:${componentId}` 键捕获；它是内部对象，不进入 JSON。

VykorAgent 新增 `runTool(toolUse: ToolUseBlock, options: { capabilityView: RunCapabilityView; scope: AgentRunScope; signal?: AbortSignal; onToolEvent?: (event: AgentEventInput) => Promise<void> }): Promise<ToolExecutionResult>`。该宿主入口由既有 idle / maintenance / close 控制保护，调用 QueryEngine.executeTool，不调用 submitMessage。

- [ ] 写失败测试：源注册工具与 UI 定义匹配时捕获；没有同插件 Native 来源、声明 builtin / MCP / 其他插件动作时绑定不可交互。变更原定义或全局 registry 后已捕获对象及 invoke 不变。
- [ ] 在 Runtime 安装完成时捕获 UI 元数据与行为摘要，校验读取到的组件仍与 A1 摘要相符。UI 本身失败不使其他插件工具不可用；不读“当前最新版”替代原 UI 定义。
- [ ] createRunCapabilityView 的 UI 可见性沿用 pluginId 选择，不为 baseline 开放第三方 UI；数据冻结，不允许调用方修改 Map。
- [ ] runTool 获得实际 Agent 的 cwd / session / effects / 设置，不接受伪造的权限决定、任意 toolRegistry 或调用函数。确认传入 scope 的 session 与实际 Agent 相同。
- [ ] 生命周期事件由 onToolEvent 的可靠 sink 接收，用于操作 Run；不发出模型 input.accepted，不把原 Agent 历史改成虚假的模型调用。
- [ ] close / signal 中断该工具操作，Native Tool Host 的并发、取消和审计仍起作用；UI 原插件失效不能重定向到新版本。
- [ ] 运行真实 Native Tool 子进程集成与 capability view、Agent lifecycle 聚焦回归，agent-runtime check-types / build。

AgentRunScope 需要逻辑 inputId 时使用该操作 Run 的稳定 ID，仅限内存调用归属；不创建 SessionInputRecord。这个决策须在报告中说明，不能给 UI Run 填一个不存在的持久 inputId。

## Task 4: 可信实例生成与持久投影

**Files:** 新增 server/application/session/session-plugin-ui-service.ts、实例投影测试；修改 transcript-projection.ts、session-run-executor.ts 和装配接口。

**Interfaces:** SessionPluginUiService 具有 `registerRunView(runId, view)`、`releaseRunView(runId)`、`createInstance({ sessionId, runId, partId, toolUseId, toolName, result })`、`get(sessionId, instanceId)`。register 只接受宿主创建的视图；createInstance 返回可信记录或 undefined，并给出 UI 诊断，不改变工具成功事实。

- [ ] 写真实 SessionStore 测试：工具成功时保存源 Part.metadata.pluginUi；不支持的 proposal、无文字 content、失败、unknown 或伪造身份均不生成可交互实例。重开数据库后已提交记录仍可读。
- [ ] 源 Run 在 submitMessage 前注册 capabilityView，并在 finally 释放；投影创建用该视图查原工具绑定和组件，不问当前 global registry。
- [ ] createInstance 仅接受 plugin 来源 Native Tool，proposal 只含 schemaVersion / componentId / data；校验后由宿主生成全部身份、UUID、时间与 revision=1。
- [ ] 写工具结果 Part 的现有事务内生成实例；part.output 保留原始结果，宿主 metadata 被外部结果过滤后再加入。
- [ ] get 在当前 Session 的 Parts 中找实例，检查 sourcePartId / sourceRunId / toolUseId 和会话归属。fork / 导入 / 替换 transcript 不继承可执行 UI 身份，已有输入入口拒绝宿主保留名。
- [ ] 生命周期可用性分别检查当前批准、enabled、全局开关、快照、组件和 Session。错误组件不影响普通文字结果，不把断线/禁用当作永久业务终态。
- [ ] 验证事务失败、其他 Session、旧版本、child 未捕获来源的安全回退和原工具结果未被改写。

```ts
const state = store.conversationTransactions.getSessionState(session.id);
expect(state.parts.find(part => part.id === sourcePartId)?.metadata.pluginUi)
  .toMatchObject({ status: "open", revision: 1, sourcePartId, pluginId: "example.ui-fixture" });
expect(state.parts.find(part => part.id === sourcePartId)?.output).toEqual(originalResult);
```

测试使用临时数据库和真实 repositories，捕获视图通过 Runtime 公共入口或完整手写可信 fixture 提供；原始结果必须独立保存供对照。

## Task 5: 原子动作、同一车道执行、恢复与模型摘要

**Files:** 新增 session-plugin-ui-action-executor.ts 及测试；扩展 SessionPluginUiService、session-run-engine.ts、启动恢复、正常输入上下文。

**Interfaces:** service 增加 `invokeAction(sessionId, instanceId, input)`、`getAction(sessionId, instanceId, requestId)`、`dismiss(sessionId, instanceId, input)`、`recover()`；执行器 `execute(runId, workContext)`；SessionRunEngine 提供 host-owned work 入队，复用原 coordinator，不建立第二个 queue。

- [ ] 写失败测试：同请求返回同回执，不同 args / expectedRevision 使用同 ID 为冲突；双客户端旧 revision、busy、终态、归档、权限缺失、旧摘要均未执行工具。
- [ ] 按 Spec 对三个路由 ID 求确定 runId、对规范化 input 求指纹。先查重，再校验新请求。SessionOperationRunner 串行入口下原子创建 Run 并修改实例 activeActionRunId / revision。
- [ ] UI Run 无 inputId，metadata.uiAction 由宿主生成；入队失败 terminalize / not_started，不留下悬空工作。
- [ ] 执行时再次核对实例及插件快照，取得实际 Agent 和固定视图，再调用 runTool。工具開始的持久事实先提交，executionState 保守变为 unknown，然后才调用工具。
- [ ] 使用真实工具事件创建动作 transcript 和 Part；成功 / 失败、实例 data、resolve、activeActionRunId 清理与 Run 终态同事务提交。结果未知不能自动标成功。
- [ ] dismiss 是无副作用的业务取消，关闭前端无影响；进行中要求先取消 Run。新动作拒绝 unknown 的旧实例，同 requestId 永不重放。
- [ ] startup 在普通 Run 中断前处理 UI Run：未开始为 interrupted/not_started，已开始无结果为 interrupted/unknown，清理 activeActionRunId。不能走普通 Prompt resume。
- [ ] 正常后续输入最多附最近一次模型 Run 后 8 条 UI 操作、8,000 字符的外部数据摘要，不自动发模型请求或 Goal 续跑。
- [ ] 真实数据库重开、真实 Node Tool 执行计数、主动取消、保存/入队故障注入分别证明生命周期；不能只检查 mock 调用次数。

```ts
const first = await service.invokeAction(session.id, instanceId, input);
const replay = await service.invokeAction(session.id, instanceId, input);
expect(replay.runId).toBe(first.runId);
await lane.waitForRun(first.runId);
expect(store.runs.getRun(first.runId)?.inputId).toBeUndefined();
expect(store.runs.listRunAttempts(first.runId)).toEqual([]);
expect(await readFile(effectCounterFile, "utf8")).toBe("1");
```

service、lane、effectCounterFile 由本任务测试实际装配，计数文件只位于临时测试根，记录真实 Tool Host 的副作用。

## Task 6: Application / HTTP / Client 完整接线

**Files:** daemon-application.ts、现有 session 装配、http/server.ts；新增 routes/session-plugin-ui.ts、client/resources/plugin-ui-resource.ts 和测试；资源与公共类型 exports / API 契约。

- [ ] 路由使用现有 Bearer / Origin / 协议 middleware，严格 decoder 和 Application error 映射，不在 route 重写业务规则。
- [ ] 提供 Spec 第 13 节 get、document、invoke、getAction、dismiss 路由；新请求 202，已结束重复请求 200。取消复用已有 Run 控制入口。
- [ ] document 只读当前明确批准、启用、摘要相符的单文件 HTML；重新校验组件摘要，返回 html 与 SHA，不开放 assets 路径代理或任意 URL。
- [ ] VykorClient 增加 pluginUi Resource，所有方法有 AbortSignal；HTTP 取消不撤销已经准入的动作。公开新类型/Resource 必须更新公共契约清单。
- [ ] features.pluginUi=1 只在完整 service 接线后公布；无 UI 后台能力的窄测试装配不宣传，旧根协议必填形状保持不变。
- [ ] 运行真实 Hono + Client 调用链、认证失败、归属错误、byte 限额、重复请求及 document 生命周期测试。

```ts
const receipt = await client.pluginUi.invokeAction(sessionId, instanceId, input);
expect(receipt.instanceId).toBe(instanceId);
const read = await client.pluginUi.getAction(sessionId, instanceId, input.requestId);
expect(read.receipt.runId).toBe(receipt.runId);
```

HTTP 测试用 client 的 fetch 进入真实 Hono，底层使用真实 SessionStore 和 UI service；Tool 可使用已验收的 Node 夹具，不连接外部平台或模型。

## Task 7: 跨层回归、独立审查与交付

- [x] 汇总 UI-05–UI-16 证据以及 A2 相关生命周期、无界面、日志和 feature 检查；所有字段和身份验证都有真实消费者。
- [x] protocol、core、agent-runtime、server、client 聚焦测试与 check-types；shared executor 改动必须覆盖原批次权限、取消、超时、重用和组序。
- [x] Agent Runtime 先 build，再检查 Server / Desktop 类型，避免缺 dist 声明被误认作业务错误。
- [x] 运行客户端 API 契约和浏览器构建、文档/whitespace 检查，验证没有浏览器入口引入 Node。
- [ ] 独立全分支审查，先复现真实反馈，再修正并重新审查；保存关键判定和测试证据。
- [x] 更新 Spec 阶段状态、当前作者指南、A2 验收记录并提交到现有隔离分支；不合并、不推送、不提前实施 A3。

## 测试与执行约定

所有实现先验证失败用例。使用已有 pnpm `--config.manage-package-manager-versions=false`，必要时通过已有 sandbox 授权运行；不下载新依赖。SQLite 测试需要现有 better-sqlite3 构建产物；只在当前 worktree 准备，不引用 main 的 workspace 模块。

每个任务按职责分别审查并提交。计划只规定接口与不变规则，实现可沿原代码拆分测试 fixture，但不能复制另一套权限/工具循环、添加新数据库或提供 UI 对任意工具的后门。
