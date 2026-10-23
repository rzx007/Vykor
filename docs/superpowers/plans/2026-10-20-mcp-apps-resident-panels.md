# 统一 MCP Apps 与迁移 Native UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 MCP Apps 作为唯一插件页面协议，完成现有 Native UI 的迁移与移除，保留 Native Tool、权限校验和操作回执。

**Architecture:** 页面统一使用官方 App/AppBridge；宿主为 Native Tool 和实际 MCP 服务提供两类受控后台。所有活页面使用同一应用身份和操作流程，复用现有工具执行器、会话队列与 SQLite 回执；旧 UI 仅保留隔离的历史读取能力。

**Tech Stack:** TypeScript、官方 ext-apps 1.1.2、现有 MCP SDK 1.29.0/Zod 3.25.76、NativeToolHost、Electron、React、现有 Client/Server、SQLite/Drizzle、Vitest。

**Spec:** [统一 MCP Apps 与会话常驻面板设计](../specs/2026-10-20-mcp-apps-resident-panels-design.md)。

**实施进度（2026-10-21）：** 全部 5 个阶段、10 个任务已完成实现、分阶段验证和独立审查，包括 Native Tool 适配、权限与持久回执、常驻宿主、两个示例及旧 Native UI 活动实现的物理移除。核心迁移已提交为 bcbe0ce7，并通过 a246408e 合入 main；后续右侧固定面板与示例交互优化已提交为 5b48c58f。阶段 1、2 分别有 196、352 项定向测试证据；后续阶段已有真实 Electron、架构、退役和产物检查证据，最新复审累计 132 项宿主/布局、14 项示例测试及真实 Electron 回归通过，用户体验验收正常。widgetState 按任务 7 的可选能力规则不启用；远程平台等排除项不属于遗留任务。尚未推送或发布。

## Global Constraints

- 方案修订结束，当前范围为全部实施任务；不直接改写用户安装快照或实际数据库，不自动提交、合并或发布。
- 最终只有 MCP Apps 页面协议；Native UI 共存仅限阶段 1–4，阶段 5 的切换和物理移除是必做交付。
- 保留 Native Tool 注册、业务实现、Guard、Tool Host、dataDir、权限、超时、取消和审计；不要求为其额外启动 MCP 服务。
- 唯一新应用入口为 components.apps；最终活页面只引用 PluginAppSource，不永久保留 Native/MCP 两种 UI 来源处理器。
- 页面后端固定为 native-tools 或 mcp-server，页面不能选择会话、插件、连接、目标工具函数、模型或权限。
- Native 工具映射只引用同插件实际注册名，参数 schema 来自实际工具；不新增参数重写和工具别名。
- UI 批准继续使用 ui:render、ui:invoke-own-tools，并经过原工具权限；app-only/readOnlyHint 不构成授权。
- app-only 私有目录继续受宿主工具上限、当前角色 allowedTools、deny、supportedEnvironments 和 networkMode 限制；复用 registry 策略判断，不以安装批准或宿主确认覆盖。
- 一次页面操作只创建一个原生 Run、经过一次统一工具执行流程；不能出现适配代理 Run 再调用另一个工具 Run。
- requestId 由受信宿主产生；唯一键和确定性 Run ID 只取 (sessionId, appId, requestId)，指纹只作冲突比较；断连/取消不自动重试副作用。
- 宿主确认前固定 expectedRevision、来源、后台和参数；HTTP/Client 必须传递原请求，重试不替换成新版本。controlRevision 按设计第 6.3 节递增，与业务文档版本分开。
- 持久 not_started/completed/unknown；lastActionRunId 的结果 unknown 或执行事实无法验证时，拒绝该应用的新工具和 ui/message。关闭重开、换请求 ID、重连及重启不能清除此限制。
- 旧 Part/Input/Run、历史 ID/指纹/结果和用户插件数据保留；不能把旧实例转换成可执行新应用。
- 统一配额 8 活页面/窗口、4 活页面/会话；HTML 16 MiB、资源解码总量 8 MiB、MCP 结果 1 MiB、Native appData 256 KiB、动作 args 64 KiB。
- 消息说明 4096 个 Unicode 字符、交接 JSON 32 KiB、widgetState 32 KiB；原 Native Tool 更严格的限制继续生效。
- 首批本地 Desktop/本地环境、单文件离线页面；不增加 Node、外部网络、任意文件、子 frame 或设备权限。
- 不实施 sampling、页面模型工具、Gen UI、远程/WSL/Web/手机或自动保存授权。
- 编码时补齐行为测试，每阶段完成后统一运行受影响检查；失败只补跑相关检查。UI 样式由用户查看，不主动搭预览或截图。
- 复用现有组件，必要新组件按 beUI Skill 和 DESIGN.md 选型；只有用户要求时才生成 Git 提交。

---

## 1. 阶段与完成标准

| 阶段 | 任务 | 可评审交付 | 不可省略的检查 |
| --- | --- | --- | --- |
| 1：协议数据与 SDK | 1、2 | 完整 MCP 数据、隐私与可见性、官方握手验证 | app-only 不进模型、原始结果可持久读回 |
| 2：两类后台与共同回执 | 3、4、5 | Native 宿主内适配、MCP 后台、统一身份和执行入口 | 原绑定与 app-only 策略不绕过，稳定唯一键/控制版本，unknown 阻止新操作 |
| 3：常驻宿主与迁移页面 | 6、7、8 | 窗口级官方页面、会话交接、text-inspector 与作者模板迁移 | 真实 Electron 分别调用 Native Host/MCP 服务；保留输入；主动返回与结果通知各更新一次 |
| 4：同文档协作 | 9 | 资源订阅、工具结果复用、完整笔记样例 | 通知不串来源，业务版本冲突保留草稿 |
| 5：唯一协议切换与移除 | 10 | 旧准入关闭、在途结算、旧模块删除、历史只读 | 无旧活动协议、无私有 SDK 产物、原回执与后台工具仍可用 |

依赖严格为 1 → 2 → 3 → 4 → 5。阶段 3 可以提供体验；整体统一任务在阶段 5 通过后才完成。不能把删除旧 UI 写成可选清理或无限期兼容层。

## 2. 目标接口与文件组织

`protocol` 定义有限通信数据；`plugins` 加载应用与资源声明；`agent-runtime` 捕获精确工具和后台代次；`services` 持久化应用；Server 负责接纳/调度/历史读取；Desktop 只处理实际 frame 和官方页面。

新接口均为本计划的目标，实施时创建；路径以当前基线为准，新文件不冒充已实现 API。

```ts
type PluginAppBackendKind = "native-tools" | "mcp-server";
interface PluginAppSource { sessionId: string; appId: string }
interface PluginAppRuntimeLease {
  runtimeId: string;
  generation: number;
  token: string;
  backendGeneration: number;
}
interface McpCallResultData {
  content: Record<string, unknown>[];
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  isError?: boolean;
}
interface PluginAppInvokeInput {
  requestId: string;
  expectedRevision: number; // 应用 controlRevision，非业务文档版本
  toolName: string;
  args: Record<string, unknown>;
}
interface PluginAppActionReceipt {
  source: PluginAppSource;
  requestId: string;
  runId: string;
  revision: number;
  status: "pending" | "running" | "completed" | "failed" | "interrupted";
}
interface PluginAppActionResponse {
  receipt: PluginAppActionReceipt;
  executionState: "not_started" | "completed" | "unknown";
  result?: unknown; // 原持久工具结果，仅受权宿主读取；页面使用派生 MCP 结果
}
```

GET action 返回 PluginAppActionResponse；Run status 不代替 executionState，failed/interrupted 不能被宿主当作“未执行”。result 直接读取原 Part.output，不另建 Native 结果档案；没有已保存结果时可以缺省，但 executionState 仍从持久操作事实读取，缺失/无法验证按 unknown 处理。

AppBridge 只向后台端口发出标准工具/资源请求；执行权不能由下面的接口类型本身赋予，必须由运行时登记的 opaque binding 验证。

```ts
interface PluginAppBackendPort {
  readonly kind: PluginAppBackendKind;
  readonly generation: number;
  readResource(uri: string, signal: AbortSignal): Promise<{
    contents: Record<string, unknown>[];
  }>;
  listResources(cursor: string | undefined, signal: AbortSignal): Promise<{
    resources: Record<string, unknown>[]; nextCursor?: string;
  }>;
  listResourceTemplates(cursor: string | undefined, signal: AbortSignal): Promise<{
    resourceTemplates: Record<string, unknown>[]; nextCursor?: string;
  }>;
  // 工具接纳/执行不在端口上提供可随意调用的 invoke 函数。
  // Agent 内部按 appId + lease + toolName 解析实际工具，交给共同执行器。
}
```

### Task 1: MCP 原始结果和隐私边界

**Files:**

- Create: `packages/agent-contracts/src/tools/tool-data.ts`、`mcp-apps.test.ts`。
- Modify: protocol 公开导出、`packages/mcp/src/connections/connection-types.ts`、`index.ts`。
- Modify: `packages/agent-contracts/src/tools/tools.ts`、`engine/checked-tool-execution.ts`、`engine/tool-result-feedback.ts`。
- Modify: Server `application/agent/agent-transcript.ts`、`http/part-wire-view.ts` 与实际结果序列化入口。
- Test: mcp `index.test.ts`、core `tool-result-feedback.test.ts`、Server `part-wire-view.test.ts`。

**Interfaces:** Consumes 现有 MCP CallToolResult / ToolResult / Part.output；produces `McpCallResultData`、`ToolResult.mcpResult` 和归一化 UI/visibility/annotations。

- [x] **Step 1: 写数据样本并建立回归断言。**

```ts
const raw = {
  content: [{ type: "text", text: "saved" }],
  structuredContent: { documentId: "note-1", revision: 2 },
  _meta: { uiOnly: { cursor: 8 } },
  isError: false,
};
// manager 调用结果的 mcpResult 深等于 raw；SQLite 重开后仍一致。
// 模型反馈、摘要、日志、压缩历史中均不出现 uiOnly。
```

- [x] **Step 2: 实施完整传递和有限 JSON 校验。** text 非空时保持原模型文字；无 text 时才用 structuredContent JSON 兜底。原始 MCP 图片不强转为当前 core 文件图片类型。宿主保留字段不能由 result metadata 伪造。
- [x] **Step 3: 补齐泄露和超限反例。** 检查普通列表、SSE 摘要、导出、工具结果导入、模型历史和日志；原始结果超限明确报错，不能伪完整截断。
- [x] **Step 4: 运行对应检查。**

```sh
pnpm --filter @vykor/protocol exec vitest run src/mcp-apps.test.ts
pnpm --filter @vykor/mcp exec vitest run src/index.test.ts
pnpm --filter @vykor/core exec vitest run src/engine/tool-result-feedback.test.ts src/engine/checked-tool-execution.test.ts
pnpm --filter @vykor/server exec vitest run src/http/part-wire-view.test.ts
pnpm --filter @vykor/protocol --filter @vykor/mcp --filter @vykor/core --filter @vykor/server check-types
```

**Gate:** 原始结果可读回，模型与普通摘要不接收页面私有数据。

### Task 2: 工具可见性与官方 SDK 依赖验证

**Files:**

- Modify: mcp `index.ts`、`connection-types.ts`；agent-runtime `runtime-integrations.ts`、`run-capability-view.ts`。
- Modify: core `engine/tool-discovery.ts`、`checked-tool-execution.ts`。
- Create: `apps/desktop/tests/plugin-apps-electron/mcp-apps-sdk-fixture.ts`、`mcp-apps-sdk.html`。
- Modify: Desktop package.json、lockfile、现有 Electron 测试入口。
- Test: core `mcp-proxy-authorization.test.ts`、agent-runtime `run-capability-view.test.ts`。

**Interfaces:** Consumes 任务 1 的可见性元数据；produces 受限 app 工具目录与可构建的官方页面 SDK 夹具。

- [x] **Step 1: 写 model-only/app-only/both 三组工具测试。** 没有 UI resource 的 app-only 同样不进入模型目录、搜索或 McpToolCall 代理；非法 visibility 不授予权限。
- [x] **Step 2: 实施目录分离。** app-only 保存于私有目录，不靠提示词隐藏；只有共同授权入口能够获得运行绑定。visibility 只负责模型/页面目录，执行策略另外复用 RuntimeToolRegistry.isVisible 的宿主上限、角色 allowedTools、deny、supportedEnvironments/networkMode 判断；不能直接取内部 registry 跳过策略，也不能因模型目录隐藏就误拒绝合法页面调用。
- [x] **Step 3: 验证并锁定兼容官方 SDK。** 已核对候选 2.0.0 需要 MCP 2/Zod 4，选择兼容当前 MCP 1.x/Zod 3 的 1.1.2。使用官方 CallToolResultSchema 校验 JSON 边界，在生产同样的隔离 iframe 验证官方 App/AppBridge 握手、初始结果、取消及清理；不能全仓升级或用 any 掩盖类型冲突。
- [x] **Step 4: 运行定向测试、Desktop typecheck 与真实 Electron 夹具。** 不兼容时本阶段不能通过，必须记录错误并锁定另一个经过同样验证的具体版本。

```sh
pnpm --filter @vykor/core exec vitest run src/engine/mcp-proxy-authorization.test.ts src/engine/tool-discovery.integration.test.ts
pnpm --filter @vykor/agent-runtime exec vitest run src/run-capability-view.test.ts
pnpm --filter @vykor/desktop typecheck
pnpm --filter @vykor/desktop test:plugin-apps-electron
```

**Gate:** SDK 可实际运行，app-only 工具无法被模型绕过调用。

### Task 3: 应用定义与 Native Tool 内部适配

**Files:**

- Create: `packages/plugins/src/components/apps.ts`、`app-resources.ts` 及测试。
- Modify: plugins `types.ts`、`manifest/schema-v1.ts`、`load-native-plugin.ts`、安装校验和权限统计。
- Create: `packages/agent-runtime/src/node/plugin-apps/plugin-app-backends.ts`、`native-plugin-app-backend.ts`、`mcp-plugin-app-backend.ts` 及测试。
- Modify: agent-runtime `runtime-integrations.ts`、`native-tools/activate.ts`，按实际映射控制 outward 可见性，不改业务 invoke。
- Modify: agent-runtime `default-runtime-tools.ts`、`run-capability-view.ts`，抽取并共用原 registry 策略判断，保持宿主/角色/deny/环境限制。

**Interfaces:** Consumes 当前 Native Tool 注册事实、插件资源快照和 MCP server 绑定；produces 设计第 4 节的 backends/surfaces、受限后台资源端口和内部精确工具目录。

- [x] **Step 1: 写定义验证反例。** 非同插件 Native Tool、跨插件 server、重复后台、资源越界/symlink、重复 URI 和冲突的 target visibility 均失败；args schema 不可在应用 manifest 重定义。
- [x] **Step 2: 实施唯一 apps manifest。** native-tools 的资源精确 URI→entry；tools 精确指向实际注册名，不允许任意函数/模块路径；mcp-server 精确绑定原声明 server。未列入映射的 Native Tool 保留模型能力，但不可被页面调用。
- [x] **Step 3: 实施 Native 结果适配。** 在共同执行结算后把 text/isError 转换为 MCP 结果，有效 metadata.appData 映射 structuredContent；其他 metadata 不透出。保留原 ToolResult 与 executionState，适配错误不伪造工具未执行，也不二次调用工具。静态资源 read/list 不执行 Tool Host。
- [x] **Step 4: 验证原有上下文和 Guard。** cwd/root/dataDir、deadline/signal、网络禁用、schema、超时、取消、输出上限、并发和审计均保留；不能跨 Run 扩大 readToolResult。Native 页面用文本/JSON，其他内容块明确报能力错误。已批准且映射合法的 app-only 工具也分别测试宿主上限、角色 allowedTools、deny、环境不支持/禁网拒绝；两后台的实际外部调用次数为 0，允许场景执行原绑定一次。
- [x] **Step 5: 检查不增加服务。** Native 适配测试启动原 NativeToolHost，断言没有额外监听端口、MCP stdio 进程或代理工具注册；Native app-only 也不能从模型/代理入口调用。

```sh
pnpm --filter @vykor/plugins exec vitest run src/components/apps.test.ts src/components/app-resources.test.ts src/manifest/schema-v1.test.ts
pnpm --filter @vykor/agent-runtime exec vitest run src/native-plugin-app-backend.test.ts src/mcp-plugin-app-backend.test.ts src/native-tools/activate.test.ts
pnpm --filter @vykor/plugins --filter @vykor/agent-runtime check-types
```

**Gate:** 两种后台提供同一页面协议，Native 仍执行原工具，适配不增加权限和额外服务。

### Task 4: 统一应用身份与持久化

**Files:**

- Create: `packages/protocol/src/extensions/plugin-apps.ts`、`plugin-apps.test.ts`。
- Create: `packages/services/src/plugin-apps/index.ts`、`repository.ts`、`repository.test.ts`。
- Modify: services `session-runtime/schema.ts`、`store.ts`、`store-state.ts`、`store-persistence.ts`、数据库 mutation-buffer/回滚/删除/临时数据清理入口。
- Generate: 下一条应用表 migration（基线下一个编号 0008）及 journal/snapshot、当前 schema inventory。
- Create: Server `application/session/session-plugin-app-service.ts` 及测试。

**Interfaces:** Consumes 任务 3 的后台定义、安装事实与现有事务；produces `store.pluginApps`、`PluginAppSource` 和统一 record。

```ts
interface PluginAppRecord {
  id: string;
  sessionId: string;
  pluginId: string;
  pluginVersion: string;
  pluginDigest: string;
  definitionDigest: string;
  backendId: string;
  backendKind: PluginAppBackendKind;
  resourceUri: string;
  origin: { kind: "surface"; surfaceId: string }
    | { kind: "tool-result"; sourcePartId: string };
  logicalKey: string;
  status: "open" | "closed" | "revoked";
  controlRevision: number;
  activeActionRunId?: string;
  lastActionRunId?: string;
  createdAt: number;
  updatedAt: number;
}
```

- [x] **Step 1: 写无需工具结果的 open 测试。** 两次打开同 surface 返回同 appId；不创建假消息、假 Part 或 sourceRunId；Native/MCP 都使用相同 record 和 source 形状。
- [x] **Step 2: 实施单一仓库与控制版本。** `(sessionId,logicalKey)` 唯一，所有写入用现有事务/持久化/回滚。新应用 controlRevision=0；接纳要求 expectedRevision=r，同事务设 activeActionRunId 并变为 r+1，记录接纳版本供调用前校验；首次结算保存结果、清活动指针、设 lastActionRunId 并将当前版本加 1。首次关闭/撤销、closed 显式重开各加 1，保留最近操作事实；revoked 旧定义不可重开。重复请求/结算、读取/prepare、重复打开已 open 应用、主题/可见性/业务版本变化不递增。lease/backendGeneration 独立管理；结算不能强写 expectedRevision+2 或复活 closed/revoked。旧 Native UI Part 不复制到应用表。
- [x] **Step 3: 实施后台代次。** Native Host 重启与 MCP 连接替换均使旧 lease 无效；应用重开必须重新检查摘要和批准。静态资源可读与工具可调用分开裁定。
- [x] **Step 4: 验证创建/更新回滚、关闭重开、插件升级、重启读回、会话删除和临时数据清理。** 覆盖 controlRevision 递增表、关闭与结算并发、重复结算不递增、重开不清除 unknown；旧 UI 历史 ID/结果不能改变。

```sh
pnpm --filter @vykor/protocol exec vitest run src/plugin-apps.test.ts
pnpm --filter @vykor/services exec vitest run src/plugin-apps/repository.test.ts src/session-runtime/store-persistence.test.ts src/session-runtime/temporary-chat-storage.test.ts
pnpm --filter @vykor/protocol --filter @vykor/services check-types
```

**Gate:** 所有新活页面具有同一种持久来源，历史不会成为新执行权。

### Task 5: 共同执行、权限、回执与普通提交

**Files:**

- Create: agent-runtime `plugin-app-runtime.ts`、`agent-run-plugin-app-tool.test.ts`。
- Modify: `agent.ts`，把原 runTool 的安全执行部分提取出来，不把 Native UI manifest 当作最终授权来源。
- Create: Server `plugin-app-operation-service.ts`、`plugin-app-operation-executor.ts`、`plugin-app-conversation-service.ts`。
- Modify: 原 `session-plugin-ui-service.ts`、`session-plugin-ui-action-executor.ts`、`session-plugin-ui-conversation-service.ts`，迁出可靠性机制；旧入口仅为过渡使用，任务 10 删除。
- Create: HTTP `routes/session-plugin-apps.ts`、Client `resources/plugin-app-resource.ts` 及测试，更新 capability/公开入口/应用状态投影。

**Interfaces:** Consumes 精确后台绑定、应用来源、原 operations.run/enqueueHostWork/RunAdmissionService；produces `runPluginAppTool()`、统一 action/conversation 接纳、查询与取消。

```ts
interface PluginAppToolRequest extends PluginAppInvokeInput {
  source: PluginAppSource;
  lease: PluginAppRuntimeLease;
}
```

复用第 2 节 PluginAppInvokeInput，不重定义一份遗漏 expectedRevision 的请求。Desktop 在确认前复制有限 JSON 参数，固定 requestId/expectedRevision/来源/后台身份；确认、Client、HTTP 和 Server 使用同一个请求。指纹包含固定来源及插件/定义摘要、后台身份、toolName、args 和 expectedRevision，不含 lease token。传输重试原样重发；新 RPC ID 不自动视为同一次操作。

HTTP/Client 最终活动入口：

```text
GET  /sessions/:sessionId/plugin-apps/catalog
GET  /sessions/:sessionId/plugin-apps
POST /sessions/:sessionId/plugin-apps/open
POST /sessions/:sessionId/plugin-apps/:appId/prepare
POST /sessions/:sessionId/plugin-apps/:appId/close
POST /sessions/:sessionId/plugin-apps/:appId/actions
GET  /sessions/:sessionId/plugin-apps/:appId/actions/:requestId
POST /sessions/:sessionId/plugin-apps/:appId/actions/:requestId/cancel
POST /sessions/:sessionId/plugin-apps/:appId/resources/read
POST /sessions/:sessionId/plugin-apps/:appId/resources/list
POST /sessions/:sessionId/plugin-apps/:appId/resource-templates/list
POST /sessions/:sessionId/plugin-apps/:appId/conversation/submissions
GET  /sessions/:sessionId/plugin-apps/:appId/conversation/submissions/:requestId
```

- [x] **Step 1: 写两后台同一套权限反例。** 页面篡改工具/插件/后台/会话、失效 lease、审批时被禁用、连接/Host 替换都拒绝。即使 app-only 已映射并获安装批准，宿主上限、角色 allowedTools、deny、环境不支持/禁网仍拒绝；确认期间策略收紧也拒绝。断言 NativeToolHost.call / MCP client.callTool 和模型调用次数均为 0。
- [x] **Step 2: 按固定请求和稳定唯一键接纳。** 唯一键和确定性 Run ID 只由 `(sessionId,appId,requestId)` 生成，指纹只存作比较。先验证宿主原会话读取权并查已有操作：同指纹返回原回执，异指纹报 409；不因当前 lease/revision 已变而重建旧操作。只有新请求才检查当前安装批准、lease、精确绑定、工具策略、open/unknown/busy 与 expectedRevision，再同事务写 pending Run、固定请求、接纳版本和活动指针。用唯一约束与 SessionOperationRunner 防并行重复；执行器调用前再校验接纳版本、活动 Run 所有权、lease、绑定和原 schema/权限/Hook/环境，只执行原绑定一次。
- [x] **Step 3: 保留结算和 unknown 限制。** Native Tool Host 成功收到 invoke 返回后，由宿主归一 executionState=completed，保留业务 isError；不接受插件顶层字段覆盖宿主事实。调用前宿主拒绝仍 not_started，传输拒绝、断连、取消或超时仍沿原链保留 unknown。 调用前持久 not_started/unknown 边界，终态按任务 4 的版本规则保存真实结果及执行事实。lastActionRunId 指向 unknown 或事实无法验证时，拒绝该应用的新工具与 ui/message；只读回执/资源仍按权限可查。换 requestId、关闭重开、重载、重连和重启均不清除；恢复时先恢复事实再开放准入。只有原操作取得可验证并已持久的确定结果才解除，首批无手动标成功或清指针入口。busy/unknown 均保留草稿；副作用后保存失败不重做，取消不保证回滚。
- [x] **Step 4: 实施重复普通消息。** ui/message 使用原 RunAdmissionService 和宿主确认；每个 appId+requestId 在 Input/Run 原子记录提交指纹，先查已有提交再接受新提交。正常状态的两次独立发送产生两条输入，应用仍 open；重复 ID 不重复调用模型。新提交必须通过同一 unknown 限制，不能借 sendMessage 绕过；已有提交回执仍可读。
- [x] **Step 5: 实施公共 API 与同步。** Client 工具调用统一携带 expectedRevision，严格检查 ID/来源/版本；action 查询返回 PluginAppActionResponse，以 executionState 判断执行事实，不只读 Run status。原结果读 Part.output，不存第二份；控制版本通过原 snapshot/SSE 同步。close/revoke 后回执仍按原会话读取权可查，但 Main 不向失效 frame 交付。`pluginApps:1` 只在装配后声明，token、HTML、完整私有结果不广播进摘要。
- [x] **Step 6: 验证两后台的去重、版本与故障。** 同 ID 同指纹的并行/终态重试仅一个 Run、一次实际调用；同 ID 不同 args/expectedRevision 返回 409，GET 仍定位原回执。陈旧确认不能换版本继续，重复请求不递增，关闭后结算不复活应用。副作用后断连/保存失败保留 unknown，新 ID/重开/重连/重启后调用次数仍为 1，ui/message 模型调用次数为 0；旧回执可读，读取/取消不改执行事实。新旧流程不能双重消费相同请求。

```sh
pnpm --filter @vykor/agent-runtime exec vitest run src/agent-run-plugin-app-tool.test.ts src/agent-run-tool.test.ts src/plugin-app-runtime.test.ts
pnpm --filter @vykor/server exec vitest run src/application/session/__test__/session-plugin-app-action.test.ts src/application/session/__test__/session-plugin-app-conversation.test.ts src/http/__test__/session-plugin-apps.test.ts
pnpm --filter @vykor/client exec vitest run src/resources/plugin-app-resource.test.ts
pnpm --filter @vykor/agent-runtime --filter @vykor/server --filter @vykor/client check-types
```

**Gate:** 两后台共用稳定去重键、同一 expectedRevision/结算规则；app-only 保留原策略，unknown 阻止新操作；不依赖旧页面协议获得权限。

### Task 6: 官方页面宿主与常驻面板

**Files:**

- Create: Main `features/plugin-apps/plugin-app-service.ts`、`ipc.ts`、文档资源承载与相应测试。
- Modify: 原 Main `features/plugin-ui/document-store.ts`、`document-protocol.ts`、`window-policy.ts`，把仍需的安全能力迁入统一宿主。
- Create: `shared/plugin-app-types.ts`、preload 有限 API。
- Create: Renderer `components/desktop/shell/plugin-apps/` 下 controller、transport、handlers、page-manager、provider、frame、README 和测试。
- Modify: `routes/__root.tsx`、utility-panel 标签/打开菜单/布局及 README。

**Interfaces:** Consumes 任务 2 的官方 SDK 和任务 5 的有限 Client API；produces 每活页面一个 AppBridge、固定 mount→app→原会话→后台绑定的窗口 owner。

- [x] **Step 1: 写实际 frame 越权测试。** 伪造 appId、跨窗口、旧端口、父窗口导航不可获得绑定。单 frame 只装一种页面协议；迁移的插件不同时装原 bridge。
- [x] **Step 2: 迁移文档安全能力。** 验证资源读取和 HTML 摘要，Main 交付句柄；无 Node/父 DOM/任意文件/网络/子 frame/设备权限。沿用真实 frame 和 sender 校验，不能只信 renderer 传入 ID。
- [x] **Step 3: 实施官方 handlers。** tools/call 在确认前复制参数并固定 requestId/expectedRevision/来源/后台，按 PluginAppToolRequest 持久接纳；等原回执终态后通过请求响应返回 MCP 结果，signal 取消原请求。页面主动调用结果不另发 tool-result 通知；初始/模型结果通知缓冲到 connect 完成。主题/能力变化不重复业务调用，重试不得重新生成版本或请求 ID。
- [x] **Step 4: 实施窗口页面 owner。** root 持有稳定 frame，侧栏只控制显示；切会话/收面板保留同一对象。Main 校验原会话 lease，不借 activeSessionId 改目标。达到 8/4 配额时拒绝新开，不回收编辑器。
- [x] **Step 5: 实施关闭、失联和撤销。** 显式关闭先暂停该 mount 新准入、取消待确认，按固定版本持久关闭成功后再撤挂载、请求取消已接受工作、查询回执、有界 teardown 并关 port/frame；版本冲突保留 frame/草稿，不默默替换版本重试。普通后台重载和功能开关只失效凭证并处理在途工作，保留原 appId/持久状态/最近操作事实；实际定义改变才永久撤销旧定义。离线保留可见草稿但禁用桥；重连只查原操作。unknown 明确显示结果待核实并禁用该应用的新工具/消息，重新 prepare/open 不清除持久限制。接纳前明确拒绝复用统一 PluginAppAdmissionRejection（HTTP 409，code=plugin_app_not_accepted，kind/source/requestId/expectedRevision）：Server 在同会话串行范围确认原工具 Run 或消息 Input/Run 均不存在才返回；Main 只凭受信 Client 的完整匹配证明释放本地 pending，由用户发起新请求。普通 404/网络失败仅继续读原回执，不能当未接纳，也不解除 unknown。
- [x] **Step 6: 运行真实 Electron 两后台测试。** Native 调用原 Tool Host，MCP 调用真实 stdio；跨会话保留、CSP、取消和恢复均要经过真实进程。界面样式交由用户反馈。

```sh
pnpm --filter @vykor/desktop exec vitest run src/main/features/plugin-apps src/renderer/src/components/desktop/shell/plugin-apps/__test__
pnpm --filter @vykor/desktop typecheck
pnpm --filter @vykor/desktop test:plugin-apps-electron
```

**Gate:** 同一官方页面宿主服务两类后台；常驻依赖窗口 owner，授权依赖原会话。

### Task 7: 官方消息、上下文和视图状态

**Files:**

- Create: `shell/plugin-apps/plugin-app-model-context.ts`、`plugin-app-widget-state.ts` 及测试。
- Modify: 官方 handlers、会话 composer 提交入口、Server 应用提交服务。
- Test: `session-plugin-app-conversation.test.ts`、新 composer 应用上下文测试。

**Interfaces:** Consumes ui/message、ui/update-model-context、原会话 composer；produces 可见可删上下文、多次提交和 32 KiB 自愿视图快照。

- [x] **Step 1: 写草稿与来源测试。** 添加选区不覆盖已输入内容，不发送消息、不创建 Run；隐藏会话不能更新当前会话。用户能删除条目，失效来源在发送前被拒绝。
- [x] **Step 2: 实施标准交接。** 原“加入输入框”改为上下文条目；“交给助手”使用标准 sendMessage，经确认和原普通输入流程。不增加私有 draft/submit 方法兼容层，发送后应用仍打开。
- [x] **Step 3: 实施限额与视图快照。** 说明 4096 字符、数据 32 KiB，widgetState 32 KiB，按 appId 隔离、关闭清除；不抓表单、不持久化文档、不推测光标。widgetState 明确是可选 `experimental["vykor/widgetState"]` 扩展，使用官方 App.request 的 ui/set-widget-state 与 hostContext 扩展键，不伪称标准方法，也不提供私有 SDK 别名。当前固定 ext-apps 1.1.2 的官方 schema 会丢弃 experimental 扩展名，按可选能力规则本阶段不装配、不注册和不宣告 widgetState；用官方 schema 与未开放断言验证此边界，常驻 frame 保草稿保持。
- [x] **Step 4: 验证两次独立发送、同请求重试、无模型时禁用 message、取消和主题变化保留输入。** 拒绝未装配 API，只声明真实能力。

**Gate:** 被迁移页面具备旧用户流程需要的交接能力，且不保留旧协议方法。

### Task 8: 迁移 text-inspector、作者模板与分发产物

**Files:**

- Modify: `examples/plugins/text-inspector/.vykor-plugin/plugin.json`、`tools/index.mjs`、`ui/panel.mjs`、`panel.template.html`、`scripts/build-ui.mjs`、README。
- Replace: `ui/manifest.json` 为 `ui/apps.json`；删除该样例 `ui/sdk.js`，重新生成 `panel.html`。
- Modify/replace: `skills/create-plugin/assets/text-inspector/` 对应文件与生成产物。
- Modify: `skills/create-plugin/README.md`、`SKILL.md`、`references/native-plugin.md`、`plugin-apps.md`、`verification.md` 和 `docs/native-plugin-authoring.md`。
- Test: text-inspector 例子、create-plugin 分发/类型、样例打包与真实 Electron 场景。

**Interfaces:** Consumes 任务 3 的 native-tools 后台与官方页面 API；produces 无私有 SDK、无额外 MCP 服务的迁移插件。

- [x] **Step 1: 锁定业务回归样本。** 检查算法和原 TextInspectorCheck/Preview 参数保持：行尾空白、行首 tab、过期/重复 selected、48,000 字节交互边界和大文本文字反馈。
- [x] **Step 2: 改工具结果和声明。** 把 metadata.ui.data 改为明确 metadata.appData；根清单仅 components.apps。映射原两个工具名，inputSchema 仍取真实注册值，不复制到 apps.json。
- [x] **Step 3: 改页面。** import 官方 App，先登记初始/模型结果通知和宿主上下文事件再 connect。页面按钮调用原工具后，明确用 `const result = await app.callServerTool(...)` 的返回值读取 structuredContent/isError；ontoolresult 仅消费宿主主动推送，不能指望它自动收到页面调用结果。两条路径共用同一结果校验/显示函数，通知处理不再次调用工具或保存。用 hostContext 样式、updateModelContext、sendMessage 替换原私有方法；直接打开时显示空表单，不造来源结果。
- [x] **Step 4: 改构建与作者工作流。** 使用官方 SDK 的正常模块构建，模板提供 package.json/锁定依赖；作者构建需准备依赖，安装产物仍为离线单文件。删除旧“只需 Node 拼接私有 SDK”说明，不另建 Vykor 页面 SDK。重新生成两份 HTML，安装时不构建。
- [x] **Step 5: 改版本与分发。** 使用新的插件版本，走原更新/重装链路；不写已安装快照、不删 dataDir，不增加权限时按现有批准规则复用。验证归档产物在仓库外独立运行。
- [x] **Step 6: 同步测试语义。** 保留业务/权限/取消/回执断言，把旧 draft/resolve 方法断言换成标准消息与保持打开。分别验证无 tool-result 通知时主动调用仍更新一次，以及仅收到初始/模型通知时更新一次；页面发起的新增外部调用次数分别为一次/零次，显示处理不触发保存。不得用旧测试全通过掩盖仍使用私有 bridge。

```sh
pnpm --filter @vykor/plugins check-types
pnpm --filter @vykor/skills exec vitest run src/create-plugin-distribution.test.ts
pnpm --filter @vykor/plugin-sources exec vitest run src/package-example-plugins.test.ts
pnpm --filter @vykor/desktop test:plugin-apps-electron
```

**Gate:** 实际插件、复制模板、生成页面和文档全部使用官方 SDK；业务工具仍是 Native Tool。

### Task 9: 资源订阅、工具结果入口与笔记应用

**Files:**

- Create: mcp `resource-subscriptions.ts`、Server `plugin-app-notifications.ts`/通知路由、Client 窗口共享通知流及测试。
- Create: Renderer `plugin-app-resource-feed.ts` 及测试。
- Modify: 成功 Native/MCP 工具结果的应用入口投影、后台能力声明、inline/fullscreen 定位。
- Create: `examples/plugins/notes-app/` 的 manifest、真实 MCP 服务、官方页面、业务测试、构建与 README。

**Interfaces:** Consumes 已签发后台 lease、真实资源通知和成功工具结果；produces 失效通知/resync、精确入口复用、版本化文档样例。

```ts
type PluginAppResourceNotice =
  | { kind: "resync"; runtimeEpoch: string }
  | { kind: "resource-updated"; runtimeEpoch: string;
      appId: string; leaseGeneration: number; uri: string };
```

- [x] **Step 1: 写通知归属反例。** URI 相同但插件/会话/后台不同不能互收；迟到订阅成功需退订，旧后台代次通知丢弃。Native 静态资源后台未实现订阅时不宣告。
- [x] **Step 2: 实施窗口共享通知流。** 鉴权后只转发 invalidation，不落聊天持久历史、不保存正文；断线先发 resync，再重读。不能每个 frame 另开连接或重放工具动作。SDK 1.1.2 由宿主管理已鉴权 read URI 的后台订阅，以标准 ResourceListChanged 触发页面重读；单 URI 明确不支持订阅不影响其他有效订阅，不能吞掉鉴权/传输失败。
- [x] **Step 3: 实施工具入口复用。** 仅真实已提交成功结果与可信后台工具描述可产生入口；唯一匹配声明 surface 时复用，否则按 Part 隔离。Native 通过映射的 ui.resourceUri 识别，旧 metadata.ui 永不转换。失败/历史回放不自动开面板。实时新结果按宿主 sourcePartId 去重并顺序投递；显式查看已有页面只定位右侧标签，不重放旧正文。未知 Part 的页面身份由 Main 判定，不能仅凭资源地址合并；重复点击不重复通知或执行。
- [x] **Step 4: 验证模式和状态。** 所有应用只在右侧面板展示，优先使用已协商的 inline 模式，fullscreen-only 也受面板边界约束；切换和收起不移动或重建 frame、不重握手。加载或错误状态保留可达标签，未完成握手不展示实际页面。业务 revision 改变不冒充宿主控制版本改变。
- [x] **Step 5: 实施笔记样例。** read_note/apply_note_operations 为模型与页面可用，list_notes/save_note_draft 为 app-only；所有写入带 expectedRevision/operationId。冲突保留草稿，相同 operationId 异参数报冲突，保存确认来自服务端。样例使用插件 dataDir 的原会话目录；旧保存回执不能降低已观察的最高业务版本或消除较新资源的冲突。
- [x] **Step 6: 真正运行协同验收。** 用户手工保存、引用选区让模型修改、页面收到通知刷新；工具调用后断连不重做。业务测试与真实 stdio/Electron 均执行。

**Gate:** 页面协议统一后具备同文档协作，Native 工具页面与真实 MCP 应用分别有完整证据。

### Task 10: 停旧准入、保留历史并移除 Native UI

**Files — 历史与退役识别:**

- Create: `packages/protocol/src/extensions/plugin-ui-history.ts`、Server `application/session/plugin-ui-history-service.ts`、HTTP `routes/session-plugin-ui-history.ts`、Client `resources/plugin-ui-history-resource.ts` 及测试。
- Modify: 安装/发现/验证入口，保留有限 retired components.ui 诊断与历史权限推导；新安装拒绝退役入口。
- Modify: 启动恢复、插件生命周期切换和迁移诊断，明确结算旧在途操作。

**Files — 安全能力迁出后删除:**

- plugins `src/ui-sdk.ts`、`ui-sdk.test.ts`、`ui-styles.css`、`tsconfig.ui-sdk.json` 与 package exports/类型检查入口。
- plugins `src/components/ui.ts`、`ui-schema.ts`、旧 UI 加载/验证绑定；安全文件读取保留在 app-resources。
- protocol `plugin-ui-bridge`、活动 UI requests/conversation/snapshot，仅历史记录解析移到 history 模块。
- agent-runtime 的 RunPluginUiBinding、pluginUi 能力视图、旧 runTool UI 入口和原 manifest 依赖；保留新的统一工具执行。
- Server 旧 `session-plugin-ui-service/current/action-executor/conversation-service` 的活动实现及 POST 路由；保留新的操作服务与历史读取。
- Desktop 旧 `features/plugin-ui` 与 `conversation-page/plugin-ui` 中协议 controller/provider/bridge、IPC/preload/shared 活动 API；已复用的安全能力先迁到新模块。
- Client 原 pluginUi 执行资源、旧 SDK 样例、旧 HTML/IIFE 导出配置与旧协议专属测试。

删除按职责逐文件进行，不整目录清空。Native Tool 的 `src/sdk.ts`、`./sdk` 导出、sdk-tests/sdk-examples 类型检查保留；旧 protocol 中仍被使用的有限 JSON、外观 token 等基础能力先迁到统一模块，避免因删除私有 UI 文件损坏普通工具或 Client。

**Interfaces:** Consumes 阶段 1–4 已可用的新流程和旧 Part/Run；produces 官方协议唯一运行路径、`client.pluginUiHistory` 的只读方法。

保留历史 GET 路径：

```text
GET /sessions/:sessionId/plugin-ui/:instanceId/actions/:requestId
GET /sessions/:sessionId/plugin-ui/:instanceId/conversation/submissions/:requestId
```

旧文档/挂载/动作/关闭/交接准入返回 `410 plugin_ui_retired`；不转发到新应用、不签发任何后台凭证。历史模块不得被 runtime 注册或新操作接纳引用。

- [x] **Step 1: 建立切换前扫描清单。** 搜索 VykorPluginUi/createPluginUiClient、旧 bridge methods、components.ui、metadata.ui、package exports 和生成 IIFE。给每个活动引用安排迁移/删除；历史文档、纯历史解析、退役诊断与拒绝测试列精确允许清单，不能用整个 plugin-ui 路径排除来掩盖遗留。
- [x] **Step 2: 加入旧包与旧历史测试。** 原已安装包仍校验完整摘要、identity、原 requested/approvedPermissions；识别退役 ui 后不解析/交付 HTML，合法 Skill/Native Tool 继续可用。新导入旧 UI 包给明确迁移错误。原 schemaVersion2 回执保持同 ID/指纹/结果，历史结果不能成为新应用来源。
- [x] **Step 3: 停止旧准入并结算在途。** 取消待确认；旧 pending 未开始标中断，running 请求取消并保存真实结果；外部已开始未确认保持 unknown。等待边界结束后撤旧 mount/port/lease。重启恢复只结算/查询，不重放旧 uiAction。
- [x] **Step 4: 迁移历史读取。** 从旧代码提取纯读解析和查询，按用户会话读取权校验；历史卡片显示文字及停用提示，不提供旧“打开界面”按钮。保留旧 GET 原路径作为唯一历史地址，不再公开执行型 Client 方法。
- [x] **Step 5: 删除活动代码与导出。** 先迁移并通过新流程的权限/回执等安全回归，再按上述清单删除，更新所有 import、capability、preload、HTTP 注册、构建配置；最终只装配官方 AppBridge。旧 SDK 已经物理移除，不能仅用开关关闭。
- [x] **Step 6: 移植测试再删除旧协议测试。** 两后台均保留 registry 宿主上限/角色/deny/环境拒绝、撤销、schema、取消、稳定去重键、controlRevision、unknown 阻止新操作、摘要隐私和事务恢复测试；lastActionUnknown 的保护不能随旧服务删除。旧 UI 专属握手/方法测试改为拒绝测试，历史读取和退役安装验证继续运行。
- [x] **Step 7: 做关闭新能力的回退测试。** 关闭 MCP Apps 仅停止新 UI 准入并撤凭证，普通工具/文字/历史回执可用；不重启 Native UI、不修改快照或重新执行已接纳操作。
- [x] **Step 8: 完成物理移除验收。** 构建与样例产物无私有 IIFE，public exports 无 ui-sdk/ui-styles；没有任意 POST 可调用旧 UI。允许清单中的历史解析不导入 AppBridge/runtime/执行器。维护中的所有页面和模板只使用 components.apps。

```sh
pnpm check:client-api
pnpm check:architecture
pnpm --filter @vykor/protocol --filter @vykor/plugins --filter @vykor/agent-runtime --filter @vykor/services --filter @vykor/server --filter @vykor/client check-types
pnpm --filter @vykor/desktop typecheck
pnpm --filter @vykor/desktop test:plugin-apps-electron
pnpm check-docs
```

**Gate:** Native UI 的活动协议、SDK、加载器和执行入口全部移除；Native Tool 的能力与历史回执仍有独立测试。阶段 5 不是“保留兼容层，后续再删”。

## 3. 验收矩阵

| 要求 | 任务 | 证据 |
| --- | --- | --- |
| 官方唯一页面协议 | 2、6、8、10 | 官方握手、迁移样例、产物扫描、旧方法拒绝 |
| Native Tool 不额外启动服务 | 3、5、8 | 原 Tool Host 执行和上下文一致，代理/额外进程数量为零 |
| 保留权限/取消/Hook/审计 | 3、5、6 | 两后台实际执行与拒绝测试 |
| app-only 不放宽执行范围 | 2、3、5、10 | 已批准映射仍受宿主上限/角色/deny/环境限制；确认中策略收紧也拒绝，实际外部调用为 0 |
| 一次请求一份回执 | 5 | Run ID 只取三元组；同 ID 同指纹并行/终态重试仅一次调用，异参数/版本 409，GET 定位原回执 |
| 控制版本与接口一致 | 4、5、6 | ToolRequest 继承 InvokeInput；确认前固定 expectedRevision；递增表、陈旧确认、关闭后结算与重复结算覆盖 |
| unknown 阻止后续操作 | 4、5、6、10 | 新 ID/重开/重连/重启不解除；新工具/消息拒绝、原回执可读，副作用不重复 |
| 主动返回与通知分别更新 | 6、8 | await 返回更新一次，初始/模型通知更新一次，不重复调用或保存 |
| 常驻不丢草稿 | 6、7 | 真实 frame 身份和跨会话输入测试 |
| 页面消息可多次发送 | 5、7、8 | 两个独立 Input/Run，应用仍 open |
| 旧历史不丢且不再执行 | 10 | 原 ID/指纹/结果、410、历史模块依赖检查 |
| 旧安装验证不被误伤 | 10 | 原包字节摘要及 requestedPermissions 一致，UI 退役后后台可用 |
| 模型与用户共同编辑 | 9 | 业务版本冲突、operationId、通知归属 |
| 实施范围与用户授权一致 | 全部阶段 | 按阶段记录编码/验证/复核证据，不直接修改用户安装和实际数据库，不自动提交或发布 |

## 4. 实施验证与回退约定

按用户要求先完成阶段内编码和行为测试用例，再集中运行该阶段的定向测试与类型检查；失败后只重跑相关检查，不反复运行已成功的大套件。公共 API/事件/schema 变更运行相应 Client 边界、数据库回滚和临时会话测试；阶段 3–5 必须有真实 Electron 行为证据。具体测试路径以实际文件为准，不能把文档检查当作行为通过。

阶段 1–4 只在开发范围迁移，旧 UI 无新功能；阶段 5 对用户发布统一入口。关闭新能力不等于回到旧协议，完整二进制回退需明确协调插件版本。数据库新增表不删除原历史，用户插件 dataDir 不参与 UI 机制清理。

## 5. 方案自审

- [x] 最终只有 MCP Apps 页面协议，删除旧实现属于必做阶段。
- [x] 两类后台共用一个活应用来源，不保留长期 Native UI 执行适配器。
- [x] Native Tool 原绑定/Guard/Host/权限仍在，未变成直接 invoke 或额外 MCP 进程。
- [x] 工具 schema 来自真实注册，app-only 对模型目录与代理入口均生效。
- [x] 适配只转换终态结果，不重复执行、不增加第二个 Run。
- [x] Run ID 只取 sessionId/appId/requestId，指纹单独比较；并行和终态重试有明确断言。
- [x] ToolRequest 继承含 expectedRevision 的 InvokeInput，确认前冻结，controlRevision 递增规则与设计一致。
- [x] not_started/completed/unknown 与取消语义保留，unknown 不因换 ID/重开/重连/重启清除。
- [x] app-only 继续复用宿主上限、角色 allowedTools、deny 和环境策略，不绕过 registry 过滤。
- [x] 主动工具调用消费 Promise 返回值，初始/模型通知单独处理，显示函数不重复执行工具。
- [x] 原页面、作者模板、生成 HTML、分发包、文档与测试都列入迁移。
- [x] 旧包退役识别与原权限推导有单独验证，不自动修改安装快照。
- [x] 历史读取可保留，不能签发新 UI 或执行凭证。
- [x] 已按用户最新授权进入全部阶段实施；编码优先、按阶段集中验证，不自动提交或发布。

最终模式校验（已按后续用户确认的交互方案更新）：SDK 1.1.2 的公开 `McpUiAppCapabilities.availableDisplayModes` 与 `AppBridge.getAppCapabilities()` 已验证可用。所有应用统一在固定右侧面板展示，聊天仅保留具名入口；加载和错误标签仍可达，握手前实际页面隐藏。未声明模式按 inline-only 处理，面板优先使用 inline，fullscreen-only 使用其支持模式；所有模式请求均限制在面板边界，不支持的请求明确失败。直接菜单打开先隐藏握手，inline-only 可以正常进入；只有初始化失败或没有可用模式时，Main 才依据 Server 本次事务的 openedByRequest 事实、原控制版本和全窗口查看器状态，仅关闭本次新打开且没有操作的独占占位并释放查看器。同会话 open/mount/拒绝清理串行，已有、共享或出现操作竞态时保留明确关闭入口，不自动关闭。切标签、切会话、收起和恢复面板保留同一 frame 与草稿；隐藏时拒绝新操作、取消待确认请求，已接纳操作继续处理原回执。已投递工具结果仅保留 sourcePartId 去重；Main 每个 mount 最多保留 64 条 settled 工具记录，prepared/sent 保留，持久回执与执行链不变。
