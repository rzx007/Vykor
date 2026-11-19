# Daemon 公开 Agent 契约与应用客户端退役实施计划

> 状态：A–F 已实施并验收，官方 1.2.28 的 Windows 覆盖升级已通过。盘点基线 `9258ffcf`，2026-11-19。
>
> 执行按下列批次逐项核对。每批先锁定可观察的行为，再替换调用并验证正常产品入口。

**目标** 让第三方和 Vykor 首方产品通过同一个 `@rzx/client` 完成 Agent 会话的全过程。将桌面数据交回 Electron，将后台管理保留在 daemon，通过逐项迁移退役 `@vykor/application-client`。

**架构** daemon 继续唯一持有共享会话、执行、授权、工具结果和事件。公开 SDK 提供 Agent 资源与同步，Node 专用 `/service` 管本机后台进程。可选宿主由后台装配。Electron 管桌面数据和产品交互。CLI、TUI、Desktop 确实共用的后台管理请求使用按职责命名的私有模块。

**技术范围** 复用现有 TypeScript、Hono HTTP、SSE（持续推送的 HTTP 连接）、SQLite、Electron IPC（窗口与主进程的请求边界）及 Vitest。基线、取舍和源码依据见[调研文档](../../research/2026-11-18-daemon-agent-platform-opencode.md)。

## 1. 目标边界与批次依赖

```text
CLI / TUI / Electron main / 第三方 ── @rzx/client ──→ daemon → Agent 执行内核
Node 本机进程管理 ── @rzx/client/service ──→ 已登记实例
首方管理功能 ── 对应的私有 HTTP 资源模块 ──→ daemon 管理路径
Desktop 便签 ── Electron IPC ──→ 本地便签库
Browser 工具 ── 可选 BrowserHost ──→ Electron 桥接或部署方实现
```

- **公开调用和后台状态分别归属。** `@rzx/client` 负责发请求、校验结果、合并快照与事件。Session 是整段会话，Input 是一次提交，Run 是一次执行。输入、运行结果、审批、Job 和恢复记录都由 daemon 持有，首方和第三方用相同 ID 查询和控制。
- **管理模块按调用方放置。** Desktop 专有适配器放到使用它的 `apps/desktop/src/main/features/`，TUI 斜杠行为放到 `apps/frontend`。多个应用共同调用的 daemon 管理接口放新增私有 `packages/daemon-admin/`，只提供 `/configuration`、`/knowledge`、`/workspace`、`/channels`、`/mcp`、`/plugins` 六个子路径。每个模块接收既有 `HttpTransport`。管理调用按连接惰性共用一个 transport，公开 SDK 和管理 transport 用相同的 endpoint 与连接凭据，沿用相同的握手实现。无包根汇总客户端。单应用专用的资源放回应用。
- **连接和权限沿用现状。** Desktop 的有凭据 HTTP 连接、管理调用和 `/service` 留在 main。Renderer 使用现有 IPC，可直接引用浏览器安全的公开类型或明确的纯函数。首期面向受信任的单实例部署，管理包的导入边界只组织代码，真正授权继续在服务端。环境、权限或副作用不同的调用独立迁移。 [现有 Desktop 依赖检查](../../../apps/desktop/scripts/verify-workspace-boundaries.mjs) · [安全和信任边界](../../security-and-trust-boundaries.md)

**执行顺序** A 公开闭环 → B 普通调用切换。C 管理与产品插件迁移、D Browser、E 便签可分别验收。B 和 C 在动同一个连接服务时先合 B 的接口再接 C 的薄资源，D 先改连接判断再改后台装配。F 在 A–E 通过后清理工作区并删包。任何批次的回滚只回滚自己的调用切换；便签发布完成后的恢复规则见 E。

## 2. `@vykor/application-client` 调用迁移清单

以类构造、资源实现、包根和 `/service` 导出为入口。一共 21 个实例属性，其中 15 个私有资源文件声明 144 个不同的资源方法（`connectCatalogProvider` 的 TypeScript 重载计一次）。下面包含完整方法名及每组代表性调用点。继承公开资源的方法单独列出。测试中的调用按被验证的行为迁移，避免用测试私有壳证明公开契约。 [实例装配](https://github.com/rzx007/Vykor/blob/9258ffcf5bffaa6cc683d76963c94acb0d277141/packages/application-client/src/application-client.ts) · [包根导出](https://github.com/rzx007/Vykor/blob/9258ffcf5bffaa6cc683d76963c94acb0d277141/packages/application-client/src/index.ts)

### 2.1 直接改用 `@rzx/client`（批次 A、B）

| 资源 | 方法 | 迁移动作 |
| --- | --- | --- |
| `protocol` | `health`、`capabilities` | 改公开 `client.protocol`。保留原 endpoint、token、timeout 和协商错误。 |
| `runtime` | `listModels`、`listAgentPersonas`、`listSkills`、`getSessionMcp` | 直接改公开 `client.runtime`，读取已配置能力。 |
| `sessions` 读与管理 | `search`、`list`、`get`、`create`、`update`、`fork`、`archive`、`delete`、`getState`、`listMessages`、`listMessageParts`、`getMessagePart` | 改公开 `client.sessions`。`getState` 的公共解码器只返回生命周期顶层字段，迁移前用 Desktop 实际字段访问和插件历史验收确认。确有产品附加字段的读取时放独立 Desktop 适配器，共用底层验证。 |
| `sessions` 运行 | `admitPrompt`、`editLatestPrompt`、`promoteQueuedPrompt`、`cancelQueuedPrompt`、`resumeInterruptedRun`、`interrupt`、`compact`、`rewind`、`remember`、`export`、`getUsage` | 改公开 `client.sessions`。`admitPrompt` 的 Desktop `pluginAppContexts` 例外和 `clearWorktreeBinding` 见 2.2。 |
| `sessions` Goal | `getGoal`、`createGoal`、`updateGoal`、`applyGoalAction` | 改公开 `client.sessions`，保留目标 ID、问题 ID 和版本冲突。 |
| `permissions` | `listApprovals`、`revokeApproval`、`list`、`reply` | 改公开 `client.permissions`，A 补 `reply` 输入的 `answer`。 |
| `attachments` | `upload`、`get`、`download`、`delete` | 改公开 `client.attachments`。Office/预览展示由现有桌面适配器继续处理。库维护见 2.2。 |
| `jobs` | `list`、`createBackgroundShell`、`read`、`wait`、`send`、`cancel` | 改公开 `client.jobs`。维持现有可辨识的任务地址 `JobTarget`（类型和 ID），执行仍由 daemon。 |
| `events` | `list`、`stream` | 改公开 `client.events`，产品同步直接用 `syncEvents`、reducer 和选择函数，命令行结束观察和停止 Run 分别处理。 |
| `files` | `list`、`stat`、`readText`、`find`、`search` | 改公开 `client.files`，保留会话授权和宿主不支持的响应。 |
| `/service` | `Service`（`discover`、`ensure`、`stop`、`clientOptions`）、`ServiceEndpoint` | 直接从 `@rzx/client/service` 引入。删除纯转发，校验本机登记、写锁、取消和后台所有权。 |

典型入口为 [CLI 单次运行](../../../apps/cli/src/print-session.ts#L293)、[TUI 同步](../../../apps/frontend/src/hooks/useServerSync.ts)、[Desktop 连接](../../../apps/desktop/src/main/features/session/daemon-connection-service.ts) 和 [Desktop 订阅](../../../apps/desktop/src/main/features/session/session-subscription-service.ts)。两种快照解码器的具体差别见 [serialization.ts](../../../packages/protocol/src/serialization/serialization.ts#L395)。

### 2.2 私有资源的逐项去向（批次 B、C、E）

| 私有资源 | 方法 | 目的地与行为 |
| --- | --- | --- |
| `SessionResource` | `getState`、`admitPrompt` | 普通调用按 2.1。`pluginAppContexts` 只在 Desktop main 的会话提交适配器中构造，复用公开提交的 Input ID、能力检查及同一路由，UI 上下文继续由 daemon 验证。快照附加字段按 B 的测试处理。 |
| `SessionResource` | `clearWorktreeBinding` | Desktop 会话操作中的窄 HTTP 适配器。daemon 核对已归档、绑定、目录不存在与幂等回执，Electron 保有本机删除工作树及重试交互。 |
| `AttachmentResource` | `scanStorage`、`repairStorage`、`gcStorage` | Desktop 附件维护适配器调用现有后台路由。由 daemon 查引用、维修或清理。上传与下载改公开方法。 |
| `NoteResource` | `organization`、`saveOrganization`、`list`、`create`、`update`、`remove` | Electron `DesktopNoteService` 改本地仓库，实现既有 IPC。正文版本、组织 ETag（用来识别上次读取的指纹）和错误映射保留。 |
| `NoteResource` | `storageInfo` | 移除 HTTP 调用，`openDirectory()` 用主进程的本地目录路径，保留系统打开行为。 |
| `SystemResource` | `listCommands` | `/workspace` 私有命令目录读法，Desktop、TUI 用原 `/commands`。Skill 通用查询仍用 `runtime.listSkills`，内置显示与 slash 分派留产品。 |
| `SystemResource` | `getSettings`、`patchSettings`、`getProfileStatus`、`initProfile`、`listOutputStyles` | `/configuration`。保留 daemon 设置 CAS（读取时值匹配才写），以及设置变更后的运行环境/插件失效处理。Profile、样式仍从 daemon 环境读写。 |
| `SystemResource` | `getRestartPreview`、`prepareRestart`、`requestDataSwitch`、`getDataSwitchResult` | Desktop 会话下的维护适配器。排空、旧后台停止、所有者更替及切根回执仍由当前服务/宿主控制流程负责。普通 SDK 连接无需后台管理权限。 |
| `SystemResource` | `listMemory`、`getMemory`、`addMemory`、`removeMemory`、`updateMemory`、`clearMemory`、`listFacts`、`replaceFact` | `/knowledge`。保留项目范围、revision、事实替换和缓存失效。注意项目记忆是 Agent 业务数据，桌面便签独立迁出。 |
| `SystemResource` | `listContextPlugins`、`getContextPreview`、`getContextStatus`、`getContextUsage`、`startDream` | `/knowledge`。查询真实后台上下文；`getContextUsage` 含 cwd/报告等语义，和公开 `sessions.getUsage` 各自保留。Dream 仍经 daemon 启动，之后用公开 Jobs 查运行。 |
| `ProviderResource` | `listProviders`、`createCustomProvider`、`connectCatalogProvider`、`updateCatalogProviderHeaders`、`disconnectCatalogProvider`、`updateCustomProvider`、`removeCustomProvider`、`refreshModels` | `/configuration`。目录连接、密钥和刷新失效都在后台。现有 UI 用 `runtime.listModels` 读可用模型，只有显式刷新走 `refreshModels`。保留 `connectCatalogProvider` 的各个入参组合。 |
| `AuthResource` | `getStatus`、`login`、`logout` | `/configuration`。Desktop 设置与 TUI slash 继续走 daemon 凭据；CLI 已有的明确本机凭据命令保持原调用。 |
| `McpResource` | `runtimeStatus`、`synchronize`、`reconcileGlobal`、`authStatus`、`startLogin`、`getLogin`、`submitCallback`、`cancelLogin`、`logout`、`watchLogin` | `/mcp`。daemon 持有活动连接、授权操作与事件；Electron/CLI 按现状处理打开浏览器、手动回调、取消。MCP 配置文件的已有本机入口继续用对应应用服务。 |
| `ProjectResource` | `list`、`inspect`、`rename`、`setPinned`、`setDefaultShell`、`rebind`、`archive` | Desktop 项目窄适配器消费现有 daemon 注册表。`inspect` 也可写入登记；保留重绑的冲突、调度和终端协调。 |
| `ProjectResource` | `init` | `/workspace` 的远端项目初始化，由 daemon 在它自己的工作目录写项目规则，TUI 只呈现结果。 |
| `ScheduleResource` | `getStatus`、`listTasks`、`createTask`、`updateTask`、`removeTask`、`triggerTask`、`listRuns`、`setRunUnread` | Desktop 已有 `schedule-service` 使用局部 HTTP 适配器。daemon 保存日程、运行和未读状态，也可由 Agent 或无人值守触发。 |
| `ScheduleResource` | `getTask` | 当前无生产客户端调用，退役 wrapper。后台读取路由及测试继续保留。 |
| `ChannelResource` | `getStatus`、`runtimeStatus`、`startRuntime`、`stopRuntime`、`getFeishu`、`patchFeishu`、`connectFeishu`、`removeFeishu`、`addFeishuAllow`、`removeFeishuAllow`、`startFeishuRegistration`、`feishuRegistrationStatus`、`cancelFeishuRegistration` | `/channels`。Desktop 和 CLI 负责交互，daemon 管连接、配对、授权名单和回执。 |
| `ChannelResource` | `handleMessage`、`recordDelivery`、`listPendingDeliveries` | 当前无首方生产客户端调用，退役 wrapper。保留 daemon 的渠道处理与 HTTP 集成证据，外部接入仍需原路由。 |
| `DevelopmentResource` | `listSkillMarketplace`、`installMarketplaceSkill`、`removeSkill` | Desktop `skill-service` 下的窄后台调用；保留后台安装检查及刷新状态。 |
| `DevelopmentResource` | `listHooks`、`getGitDiff`、`getGitBranch`、`getGitStatus`、`gitCommit` | `/workspace`。TUI slash 按 daemon 端 cwd 调用，Desktop 读取远端分支也走这里。独立的本地 Git 界面继续走 Electron 的 Git 服务。 |
| `TerminalResource` | `create`、`list`、`read`、`write`、`resize`、`close`、`streamEvents` | Desktop 终端和后台维护共用 `features/terminal` 下的窄适配器。终端进程、输出序号和 Native/WSL 运行环境仍归 daemon。Electron 转发输入与呈现。 |
| `TerminalResource` | `get`、`signal` | 当前没有生产客户端调用，退役 wrapper，保留 HTTP 路由及进程作用域测试。 |

调用点和状态可从 [Desktop 会话操作](../../../apps/desktop/src/main/features/session/session-operations.ts)、[Provider](../../../apps/desktop/src/main/features/provider/provider-service.ts)、[MCP](../../../apps/desktop/src/main/features/mcp/mcp-service.ts)、[定时任务](../../../apps/desktop/src/main/features/schedule/schedule-service.ts)、[渠道](../../../apps/desktop/src/main/features/channels/channel-service.ts)、[终端](../../../apps/desktop/src/main/features/terminal/terminal-service.ts) 和 [CLI 渠道](../../../apps/cli/src/commands/channels.ts) 核对。对应客户端入口是 [configuration](https://github.com/rzx007/Vykor/blob/9258ffcf5bffaa6cc683d76963c94acb0d277141/packages/application-client/src/resources/configuration/README.md)、[workspace](https://github.com/rzx007/Vykor/blob/9258ffcf5bffaa6cc683d76963c94acb0d277141/packages/application-client/src/resources/workspace/README.md)、[runtime](https://github.com/rzx007/Vykor/blob/9258ffcf5bffaa6cc683d76963c94acb0d277141/packages/application-client/src/resources/runtime/README.md) 与 [session](https://github.com/rzx007/Vykor/blob/9258ffcf5bffaa6cc683d76963c94acb0d277141/packages/application-client/src/resources/session/README.md)。

### 2.3 插件及历史（批次 C）

| 私有资源 | 方法 | 目的地与行为 |
| --- | --- | --- |
| `PluginResource` | `list`、`enable`、`disable`、`installLocal`、`uninstall`、`reload` | `/plugins` 共用插件管理路径，保留 CLI、TUI 和 Desktop 的调用，安装/启停/运行失效在 daemon。 |
| `PluginResource` | `previewArchive`、`installArchive`、`previewGit`、`installGit` | Desktop 插件导入适配器。使用现有后台预览及安装，保留预览与安装之间的内容身份检查、报错和临时文件清理。 |
| `PluginResource` | `marketplaceCatalog`、`marketplaceSources`、`marketplaceAddSource`、`marketplacePreview`、`marketplaceCancel`、`marketplaceInstall`、`marketplaceSetSourceEnabled`、`marketplaceRemoveSource`、`marketplaceOperation` | Desktop `features/plugin/` 的市场适配器。源、操作与回执归 daemon，断线后查同一操作。 |
| `PluginAppResource` | `notifications`、`catalog`、`open`、`prepare`、`openToolResult`、`initialResult`、`close` | Desktop `features/plugin-apps/` 窄适配器。持有窗口/嵌入显示，daemon 管租约、会话状态和真实资源流。 |
| `PluginAppResource` | `invoke`、`getAction`、`cancelAction`、`readResource`、`listResources`、`listResourceTemplates`、`submitConversation`、`getConversationSubmission` | 同上。沿用作用域和请求 ID 校验。响应丢失时查原操作或提交回执。 |
| `PluginAppResource` | `list` | 只见测试调用，删除生产 wrapper。测试直接调用现有列表 HTTP 路由。 |
| `PluginUiHistoryResource` | `getConversationSubmission`、`getAction` | 只见测试调用，删除生产 wrapper。用 `HttpTransport` 在服务端集成测试中验证历史两个只读 GET、跨会话不可见和旧写操作的 410。Desktop 已保存消息的历史展示继续读领域记录。 |
| `getPluginAppToolPolicy` | 单个纯函数 | 移到 Desktop 插件应用适配器，作为展示与请求大小检查。运行授权继续在 daemon 和 Agent 运行时。 |

现有入口见 [CLI 插件命令](../../../apps/cli/src/commands/plugin.ts)、[Desktop 插件](../../../apps/desktop/src/main/features/plugin/plugin-service.ts)、[Desktop 市场](../../../apps/desktop/src/main/features/plugin/marketplace-service.ts)、[插件应用服务](../../../apps/desktop/src/main/features/plugin-apps/plugin-app-service.ts)、[资源通知流](../../../apps/desktop/src/main/features/plugin-apps/resource-feed.ts) 和[只读历史路由](../../../packages/server/src/http/routes/session-plugin-ui-history.ts)。

### 2.4 命令、包根导出与类型（批次 B、C、E）

- `hasActiveRun` 从公开 selector `selectSessionRuns` 按 `pending`、`running` 推导，CLI 和 TUI 本地使用。`LOCAL_COMMAND_DETAILS`、`LOCAL_COMMAND_NAMES`、`parseSlashLine`、`mergeCommandDetails`、`resolveSessionCwd`、`dispatchSessionCommand` 和 `SlashLine`、`PresentationReadRequest`、`RuntimeDiagnostics`、`SessionCommandClient`、`SessionCommandHost`、`SessionCommandOutcome` 随调用移到 `apps/frontend/src/hooks/` 的 slash 命令模块。原有分派器保留按最小 `Pick` 接受公开资源与各个窄管理依赖。全局诊断和产品文案留 TUI。 [已迁的命令实现](../../../apps/frontend/src/hooks/commands/session-commands.ts) · [生产调用](../../../apps/frontend/src/hooks/commands/sessionSlashCommands.ts)
- `/new`、`/sessions`、`/resume`、`/permissions`、`/plan`、`/theme`、`/models`、`/workflow`、`/workflows` 保留本地交互入口。其会话、恢复、运行模式或 Jobs 的真实变更继续走现有公开资源。`/mcp`、`/jobs`、`/background`、`/agents`、`/subagents`、`/rewind`、`/compact`、`/remember`、`/usage`、`/cost`、`/export` 用公开资源。`/help`、`/skills` 保留当前目录合并和模板显示。`/version`、`/status`、`/doctor` 等保留健康查询、产品状态及原有可选诊断。 [TUI actions](../../../apps/frontend/src/hooks/sync-submodules/actions.ts) · [命令流](../../slash-commands-flow.md)
- `handleSettingsCommand` 的 `/config`、`/provider`、`/auth`、`/profile`、`/effort`、`/fast`、`/reasoning`、`/turns`、`/output-style` 接 `/configuration`。`handleKnowledgeCommand` 的 `/memory`、`/facts`，以及 `/context`、`/stats`、`/dream` 接 `/knowledge`。`/init`、`/hooks`、`/diff`、`/branch`、`/commit` 接 `/workspace`。`/plugin` 和 `/reload-plugins` 接 `/plugins`，`formatPluginReload` 留 TUI。`handleDiagnosticCommand` 和 `handleJobCommand` 随 dispatcher 拆用上述资源。 [TUI 命令模块](../../../apps/frontend/src/hooks/commands/README.md)
- `src/index.ts` 中来自 `@rzx/client` 的类型、事件/同步 helpers、transport、运行配置 helpers 直接改源包。线格式、校验与序列化引用 `@vykor/protocol`，领域类型与纯逻辑优先直接引用相应领域子路径。Desktop renderer/shared 只允许这里实际使用的类型和纯函数，例如 notes、插件历史、输出显示；主进程传 IPC 形状，不把后台管理模块引入 renderer。聚合文件里其余自定义类型随所属资源迁移，包括 `DaemonRestartPreview`、`AppAdmitClientPromptInput`、`FeishuComposedSnapshot`、市场/导入/管理回执和三项附件维护输入输出。公开规范中已存在的类型直接引用现有定义。`AdmitClientPromptInput` 的私有别名随产品适配器删除，同名公开类型来自 `@rzx/client`。 [现有导出](https://github.com/rzx007/Vykor/blob/9258ffcf5bffaa6cc683d76963c94acb0d277141/packages/application-client/src/index.ts) · [私有类型目录](https://github.com/rzx007/Vykor/blob/9258ffcf5bffaa6cc683d76963c94acb0d277141/packages/application-client/src/types/README.md) · [公开 API 导出清单](../../../scripts/client-public-api-contract.json)

## 3. 实施任务与交付关口

### A. 锁定公开 Agent 契约

**文件** `packages/client/src/types/index.ts`、`packages/client/src/resources/configuration/permission-resource.ts`、`tests/client-public-api/`、`tests/server-client/`、`apps/client-docs/examples/node/run-with-permissions.ts`、`apps/client-docs/src/content/docs/` 和 `docs/protocol-contract.md`。机器可读 HTTP 契约新增在 `apps/client-docs/src/content/docs/reference/` 的 Agent API 说明与对应站点静态 JSON，由 `apps/client-docs/scripts/__test__/` 校验。

- [x] 在公开类型用例写入 `client.permissions.reply(requestId, { status: "approved", decision: "once", answer: "继续" })`，确认当前类型拒绝 `answer`。把 `ReplyPermissionInput` 补到与 `packages/protocol/src/session/session-requests.ts` 一致，服务器沿用已有请求体与权限 broker。为文档写明 `toolName === "AskUser"` 和 `payload.input.kind === "question"` 的识别、普通工具授权与问题的不同回执、Goal 问答的独立入口。
- [x] 加真实 HTTP/SSE 用例，使用隔离 SQLite 和可控的测试 Agent。客户端 A 选模型、创建、提交同一稳定 Input ID 两次，拿到同一 Run；B 断开 A 的订阅后重新 attach，能看到相同会话/运行和等待中的工具审批，明确批准一次，再单独用 `answer` 回答 `AskUser`。测试 Agent 只在收到该答案后完成，B 从同一 Run 读到消息与终态，并观察 `permission.asked`、`permission.replied`。重复或过期回复以实际服务端状态为准。
- [x] 用同一测试固定取消与恢复。退出 B 的订阅只结束本地等待。再启动第二个可阻塞 Run，带第一轮 `expectedRunId` 调 `interrupt` 得到 `interrupted: false`，第二轮继续。以第二轮 ID 停止后才能等到 `interrupted`。另复用重启和重放用例，固定快照与游标恢复、SSE 断线期间文本以持久快照为准、启动恢复和人工重新接纳是两类操作。测试覆盖 `steer` 的目标版本、同 ID 不同内容冲突、当前权限与请求身份。
- [x] 将 2.1 已有公开资源对应的 HTTP operation 列为稳定面，优先录入会话闭环、权限、事件和能力握手，再在本批结束前补齐其余公开路径。生成或校验一份 OpenAPI 3.1 JSON，标明方法、路径、鉴权、响应、错误、当前协议和各 feature。以 `@vykor/protocol` 的现有解码规则和 handler 实测作为校验依据。对尚未声明为 schema 的范围，用公开用例核对文档与服务的字段和状态码，避免私有字段成为公开承诺。SSE 另有事件名字、游标、重连与重放章节，SDK 继续复用现成同步。文档上线前用路由/请求样本测试检查 operation，拒绝意外导出 `/notes`、管理和 Browser host 路由。
- [x] 增补可从仓库外使用的安装验收。将 `@rzx/client` 和 CLI 候选产物装到临时项目，在绝对临时数据根启动 `vk --data-root <临时根> serve --host 127.0.0.1 --port 0 --token <临时 token>`，以监听结果连接，结束后仅清理本次实例。CLI 启动与公开包安装使用已打包产物，行为测试用受控测试模型；示例的真实模型验证单列环境与结果。独立浏览器构建继续校验根入口只用标准 `fetch`。安装测试和行为测试一起交付，避免 monorepo 路径别名掩盖缺失导出。

**通过条件** 两个独立公开客户端可接手同一次运行并解决人机交互。现有调用形状及协议 7 继续有效，新增可选能力以 `/capabilities` 决定。公开导出、HTTP 契约、安装包、文档一致。运行：

```powershell
pnpm check:client-api
pnpm check-types:server-client
pnpm test:server-client
pnpm --filter @rzx/client test:pack
pnpm test:client-browser
pnpm docs:check
```

### B. 首方普通 Agent 调用改用公开 SDK

**文件** CLI `print-session.ts`、`ensure-daemon.ts`、`daemon-lifecycle.ts`，TUI `useServerSync.ts`、`sync-submodules/actions.ts` 和 `sessionSlashCommands.ts`，Desktop `daemon-connection-service.ts`、`session-service.ts`、`session-operations.ts`、`session-subscription-service.ts`，三端的 `package.json`、解包/打包规则与公开/管理依赖检查。

- [x] 先改 CLI 为直接导入 `@rzx/client`、`@rzx/client/service`，加入显式依赖。本机 attach、单次输出、超时、会话延续和退出码保持原行为。删除 CLI 的 `hasActiveRun` 间接依赖，用公开选择器判断；保留非交互模式现有配置，在读到无人能回答的提问时明确按该模式处理。
- [x] TUI 用公开 `VykorClient`、同步、选择器、权限及 jobs 调正常会话。管理路径暂以只传所需方法的适配器提供，再在 C 切换实际实现。区分普通审批、`AskUser` 与 Goal。接通现有 `question_response` 的提交，按现有问题控件的格式编码答案，回答必须对应活跃请求 ID，最终状态来自同步数据。远程 TUI 仍按 daemon 的 cwd 执行管理命令。
- [x] Electron main 从同一 endpoint 建公开 `VykorClient`。注入 `client.sessions`/`permissions`/`events` 等最窄依赖，按 2.2 单列桌面专用请求。为插件输入构造 Desktop 独有的 `AdmitClientPromptInput & { pluginAppContexts: PluginAppConversationRequest[] }` 参数，由同一 `sessions.admitPrompt` 发送，端到端断言字段通过序列化到达同一准入入口且租约校验生效。公开类型和安装包的负例继续拒绝直接声明该 UI 字段。若清理 app 快照 decoder，先验证普通订阅只读生命周期字段，插件用 `pluginApps` 与历史专用入口。保留 Desktop `partView: "summary"`、完整工具结果补读、切会话订阅和队列回执。
- [x] 调整 Desktop 依赖白名单及 bundle 对公开包根、`/service` 和明确领域子路径的规则。Renderer 持续经 IPC 获得数据，Node 专用服务、后台管理和服务器模块继续限 main。新增负例证明 renderer 不能导入这些入口。

**通过条件** CLI、TUI、Desktop 正常发送、运行中补充、等待、附件、审批和断线接回使用公开客户端。在管理模块尚未迁完的阶段，普通会话测试也能只注入公开客户端运行。运行：

```powershell
pnpm --filter @rzx/ohs test
pnpm --filter @vykor/frontend check-types
pnpm --filter @vykor/frontend test
pnpm --filter @vykor/desktop typecheck
pnpm --filter @vykor/desktop exec vitest run src/main/features/session src/main/features/attachment
pnpm test:server-client tests/server-client/__test__/running-follow-up.test.ts
pnpm check:client-api
```

### C. 按职责迁移后台管理、插件和命令

**文件** 新增 `packages/daemon-admin/package.json` 与 `src/` 下按 2.2、2.3 拆出的子路径，每个分类写明调用入口及状态归属。改 `apps/cli/src/commands/`、`apps/frontend/src/hooks/`、`apps/desktop/src/main/features/` 对应服务、测试夹具、Desktop 打包白名单和 lockfile。只在实际迁移需要时调整 `packages/protocol/` 的内部分导出。

- [x] 首批搬现有资源的请求路径、校验与客户端错误包装。为设置、Provider、MCP、渠道、插件这几个共享入口保留一份 typed HTTP 实现。创建 Desktop 项目、日程、终端、插件 UI、市场、技能、附件、维护适配器，消费所在功能已有的连接。开发/审查按 2.2、2.3 核对全部 144 个私有方法去向，无生产调用的 wrapper 先由真正测试所需的 HTTP 请求替换，再删。
- [x] 搬 TUI 命令 dispatcher 和纯显示逻辑，先用现有命令测试固定路由和反馈，再将 `SessionCommandClient` 的结构改成公开 Agent 依赖加需要的管理模块。`/context`、`/stats`、`/memory`、`/facts`、`/dream` 仍以当前 cwd/会话查 daemon。`/init`、`/diff`、`/branch`、`/commit` 的测试使用客户端/daemon 目录不同的远程连接，验证服务端工作目录及有写入命令的错误返回。
- [x] 做状态与错误回归。设置 CAS、模型目录刷新、凭据修改和后台切根保留现有错误与新旧所有者切换。渠道保留配对取消、投递去重，调度保留触发与未读，终端保留 PTY 输出游标、项目绑定、关闭和 Native/WSL。插件保留安装预览身份、删除后失效，MCP OAuth 保留操作代次、脱敏和断线读回执。插件 App 保留租约与作用域、同一 ID 捞结果，以及旧历史只读/旧写入 410。
- [x] 迁移内部集成夹具。测试公开资源用 `@rzx/client`，管理用对应私有子路径，插件应用和少数兼容路由用已有 `HttpTransport` 直接向已鉴权测试服务请求。原有 `packages/application-client/src/**/__test__/` 用例跟随功能移动或合并进覆盖同一行为的测试，保留失败与兼容断言。

**通过条件** 各首方正常管理入口及远程 TUI 行为通过。管理包公共导出仅为计划内子路径，`@rzx/client` 仍可独立安装且公开资源边界通过。运行：

```powershell
pnpm --filter @vykor/daemon-admin test
pnpm --filter @rzx/ohs test
pnpm --filter @vykor/frontend test
pnpm --filter @vykor/desktop exec vitest run src/main/features/provider src/main/features/settings src/main/features/mcp src/main/features/channels src/main/features/schedule src/main/features/terminal src/main/features/plugin src/main/features/plugin-apps
pnpm --filter @vykor/desktop run test:plugin-apps-electron
pnpm --filter @vykor/server exec vitest run src/http/__test__/plugin-ui-retirement.test.ts src/http/routes/__test__/terminal.test.ts
pnpm test:server-client
pnpm check:client-api
```

### D. 浏览器桥接改为后台可选能力

**文件** `apps/desktop/src/main/features/session/daemon-connection-service.ts` 及连接回归测试、`apps/desktop/src/main/features/daemon-autostart/daemon-entry.ts`、`apps/cli/src/commands/daemon.ts`、`packages/server/src/daemon-host/registered-daemon.ts`、`packages/server/src/application/daemon-application.ts`、`packages/server/src/http/server.ts` 和 `packages/server/src/application/browser-tools/`。

- [x] 首个提交先让 Desktop 接受同协议同数据根但没有 `browserBridge` 的实例。能力值存在时才建立并维护桥接。测试无桥接时会话正常、`onConnected` 不启动、协议不合或数据根不同仍拒绝；已连桥接的断开与重连按原流程释放。
- [x] 显式在 Desktop service/on-demand 启用桥接，`vk serve` 默认关闭，普通启动与 `--register` 两条路径都覆盖。保持 `desktop_managed`/`cli_advanced` 执行策略与桥接选配独立。桌面接回先前由 CLI 启动的无桥实例时，可正常使用会话和手动浏览，Agent 浏览器能力显示按实例装配决定。部署方继续通过 `startVykorDaemon({ browserHost })` 传可信实现。
- [x] 按装配决定工具入表。有普通 host 才注册 `Browser`，有 `executeDeveloper` 且装配明确开启才注册 `BrowserDeveloper`。保留 Electron 页面作用域和用户开关、Agent 审批、取消、超时、输出大小和截图归档。Electron 断线后，未派发返回不可用或 `not_started`；已派发返回结果未知，重连不自动重放旧工作。对暖 Agent 使用运行开始时的工具范围，避免已有运行因桥接重连得到另一套能力。

**通过条件** 无宿主的 daemon 真实模型工具目录没有 Browser，占位路由也关闭。Desktop 桥接与注入宿主分别通过隔离验收。手动浏览、批注和 HTML/SVG 文件预览维持 IPC 行为。运行：

```powershell
pnpm --filter @vykor/server exec vitest run src/http/__test__/browser-host.test.ts src/application/browser-tools/__test__
pnpm --filter @vykor/desktop exec vitest run src/main/features/session/daemon-connection-service.test.ts src/main/features/session/daemon-connection-service.lifecycle.test.ts src/main/features/browser
pnpm --filter @rzx/ohs exec vitest run src/commands/daemon.test.ts
```

### E. 便签迁入 Electron，交付旧数据和备份兼容

**文件** `apps/desktop/src/main/features/notes/` 的 `note-service.ts`、`ipc.ts` 与新增 `desktop-note-repository.ts`、`legacy-note-import.ts`，`apps/desktop/src/shared/note-types.ts`、`apps/desktop/src/main/features/business-data/`、`apps/desktop/src/main/features/settings/maintenance-settings-service.ts`。从 `packages/services/src/notes/` 复用正文、组织及版本规则。同步 `packages/server/src/application/backup/application-backup.ts`、`packages/server/src/http/routes/notes.ts`、`packages/services/src/session-runtime/store.ts` 和整根迁移验证入口。先做本地发布/兼容，再退旧路由。

- [x] 将运行时便签目录设为 `data/desktop/notes/`。正文仍是独立 Markdown，`organization.json` 及其上一版、索引元数据都在本地便签目录。本地索引使用独立 SQLite 文件，抽出当前 `NoteRepository` 使用的窄笔记元数据读写接口从而复用原有读写与冲突判断。由 Electron main 串行写入正文、索引和组织，沿用已有临时文件替换和冲突保护；renderer 用现有 IPC 保留编辑、拖拽和恢复稿。`openDirectory()` 直接打开此目录。IPC 拒绝任意路径及无效数据，保留当前对版本冲突的错误映射。验收便签页、聊天/代码选区、快捷入口、多窗口冲突、外部 Markdown 修改、损坏组织与未来版本只读。
- [x] 提供升级导入入口。识别已完成收据或已存在来源；先冻结便签编辑、刷恢复稿、排空旧写入并经现有 daemon 控制锁阻止旧实例竞争重启。读取静止的旧 SQLite（含 WAL 中已提交的数据）与旧 Markdown 及组织原件，按资源保留 ID、时间、revision、删除记录与外部修改相关索引。旧 `note_attachment` 和其他历史字段保留在完整旧来源/备份，升级与恢复均不破坏这些原件。使用同盘暂存目录写新库，关闭并校验索引、正文与布局，再原子改名为目标。已完成收据存于目标目录，包含源身份/摘要和导入版本。空安装可直接创建；无法读取旧数据必须明确报错，保留源与恢复稿。
- [x] 为升级编写故障测试。分别模拟暂存时失败、校验失败、发布后进程退出和再次启动。发布前源仍可恢复且新 IPC 尚未启用写入。发布后重试使用同一完成记录，保留新库里的编辑及删除记录。已有独立目标且来源不同则显式提示冲突。整个窗口关闭、备份或整根迁移等待便签写队列及业务恢复稿排空。整根验证加入本地便签完整性并继续兼容旧数据根。迁出后的更新失败走向前修复或从经校验的桌面备份恢复，旧版本无法接收新库写入的变化。
- [x] 协调备份变化。daemon 负责会话等后台快照；Electron 负责 Notes 冻结快照。沿用 Desktop 的统一备份入口时，主进程暂存两份快照、校验并用版本化清单标明组件，全部成功后发布。恢复写独立空目标，旧备份版本 1/2 从 SQLite 读取，版本 3 从清单核对 Markdown、索引和组织文件。兼容导入通过本地备份/旧库导入器，与 `NoteResource` 和当前 `/notes` 无依赖。新备份在 daemon 单独调用时说明只含后台数据，文件版本与公开 HTTP 协议分别管理。
- [x] 切换后移除日常 daemon Notes 装配和调用。首方升级阶段将私有 `/notes` 返回明确的 `410 notes_moved`，提示旧 Desktop 更新，主流程不再构建 `SessionStore.notes`。需要同时支持旧 Desktop 的部署先完成协调升级，再启用这一步。公开协议 7 和公开 SDK 形状沿用；若其基础语义将来有破坏性变化，再按协议规则升级。历史数据库迁移与 schema 中的表保留，整根旧库识别继续使用。旧读写端点最终撤回与应用客户端包退役独立，备份兼容代码留在实际导入/恢复实现。

**通过条件** daemon 停止时，便签支持创建、更新、删、找、整理、打开目录和重启回读。新旧完整备份与整根迁移可恢复，旧源校验和不变，注入失败时无双写、覆盖或数据丢失。运行：

```powershell
pnpm --filter @vykor/services exec vitest run src/notes/__test__ src/database/__test__/data-root-relocation.test.ts
pnpm --filter @vykor/server exec vitest run src/application/backup/__test__/application-backup.test.ts
pnpm --filter @vykor/desktop exec vitest run src/main/features/notes src/main/features/business-data src/main/features/settings src/renderer/src/components/desktop/notes-page/__test__
pnpm test:desktop-integration
```

重点参考 [旧便签仓库](../../../packages/services/src/notes/note-repository.ts)、[旧备份恢复](../../../packages/server/src/application/backup/application-backup.ts)、[整根库检查](../../../packages/services/src/database/data-root-relocation.ts)、[桌面冻结与刷新](../../../apps/desktop/src/main/features/business-data/window-flush.ts) 和[数据根迁移](../../data-root-migration.md)。

### F. 退役 `@vykor/application-client`，验证发布候选

**最早删包时间** A–E 的验收均通过，当前 CLI/TUI/Desktop 的正常入口和测试夹具均已迁走，便签旧备份可以绕过旧客户端读回。此时可在同一提交删除包及构建配置。服务端保留旧只读插件回执、便签迁移提示或旧备份导入，均由各自服务与测试持有。Windows/Linux SDK 与 CLI 的安装产物、Desktop 启动和升级产物验证通过后，再交付该版本。

- [x] 按第 2 节确认生产中没有同名私有 `VykorClient`、`/service` 转发或者新增的管理总客户端。包内测试和 `tests/server-client` 混用夹具已迁出。公开快照、授权回复、插件租约、管理错误及离线便签的回归都有正常入口证据。
- [x] 删除 `packages/application-client/`，同步根及 `apps/cli`、`apps/frontend`、`apps/desktop` 的 `package.json`、`pnpm-lock.yaml`、`apps/frontend/tsconfig.json`、`tests/server-client/tsconfig.json`、`turbo.json`、`apps/desktop/electron.vite.config.ts`、Desktop 依赖白名单和 `scripts/architecture-policy.json`。清点 Vitest/Vite 别名、打包脚本、发布元数据和 CI。移除 [退役 UI 检查脚本](../../../scripts/check-retired-native-ui.mjs) 的私有历史客户端 `pureImports` 条目，保留其余历史校验，并更新[旧引用清单](../../../scripts/retired-native-ui-allowlist.json) 的路径、行号和原文。同步包 README、协议、SDK、产品接入与命令说明。过程资料保留结论，已退役源码的有效链接改至固定版本证据。
- [x] 用 `git grep -n -F -e '@vykor/application-client' -e 'packages/application-client' -- apps packages tests scripts package.json pnpm-lock.yaml turbo.json .github` 复查。允许退役检测规则、精确 Allowlist 和历史说明引用旧名。运行导入、依赖、配置映射和活跃源码路径的匹配必须为零。加一条与现有架构检查共用的退役约束，阻止依赖回流。候选从干净安装构建，避免旧 `node_modules` 里的链接蒙混过关。
- [x] 交付验收记录，记录提交、平台、版本、样本数据来源、命令和输出。验证旧版本数据升级和公开 SDK 的兼容性，用户资料用隔离副本。SDK 的兼容修订沿既有独立 npm 发版流程，CLI/桌面按现有产品发布边界，发布前比对候选的 `CURRENT_PROTOCOL_VERSION`、`/capabilities` 与实际公开路径。

```powershell
pnpm install --lockfile-only
pnpm install --frozen-lockfile
pnpm check:architecture
pnpm check-types
pnpm --filter @vykor/desktop typecheck
pnpm test
pnpm test:client-browser
pnpm --filter @rzx/client test:pack
pnpm docs:check
pnpm --filter @rzx/ohs build
pnpm --filter @vykor/desktop build
pnpm check:retired-ui
pnpm check-docs
git diff --check
```

## 4. 验收记录

资源清单以 `9258ffcf` 为基线。以下记录 2026-11-19 的实际验证。

- **A 通过。** `check:client-api`、`check-types:server-client`、`test:server-client`（132 项）、`test:client-browser` 和 `docs:check`（14 项）通过。OpenAPI 的 54 个操作与 SDK 实际请求及 daemon 路由对照。Windows Node 24.10.0 上运行 `test:pack:daemon`，在独立 npm 项目从候选 tarball 安装两包，通过本机模拟模型验收。使用 npm 官方 registry 安装依赖，模型只在本机运行。
- **B 通过。** CLI 262 项、TUI 154 项、Desktop 会话与附件 168 项及三端类型检查通过。运行中补充与插件应用各通过一项真实 HTTP 回归。最终 `test:pack:daemon` 通过 SDK 和 CLI 候选包的独立安装与无 Electron 流程，`check:architecture` 通过。
- **C 通过。** 管理包 18 项、CLI 262 项、TUI 189 项、Desktop 定向 521 项和服务端集成 132 项通过。真实 Electron 测试通过官方 MCP SDK、原生及 MCP 插件、文本检查器和示例便签应用，校验断线回执和历史。
- **D 通过。** Desktop 定向 174 项、服务端 54 项通过。普通与登记 CLI 启动均验证无桥接。独立安装的 CLI 启动后，模拟模型实际收到的工具表无浏览器工具，会话流程完整通过。
- **E 通过。** 便签与数据库 68 项、服务端备份与旧路由 21 项、桌面跨包集成 4 项通过。真实 SQLite 和 Markdown 隔离样本验证离线 CRUD、旧备份只读输入、暂存失败、修订冲突及整根迁移。服务端兼容端点返回 410。
- **F 候选验证。** 旧包和依赖已移除。冻结锁文件安装、架构检查、整仓类型检查、Desktop 完整类型检查、公开 SDK 重打包、浏览器构建和文档检查均通过。Windows 与 Debian/WSL 的 Node 24.10.0 在独立目录安装 `@rzx/client@0.1.0`、`@rzx/ohs@1.0.0`，均使用隔离数据根和本机模型样本验证真实 Agent 往返。
- **Desktop 编译产物验证。** Windows 的 Desktop 1.2.31 构建通过。使用 Electron 45.2.1 启动编译后的无窗口入口，以隔离旧库、Markdown 和本地便签验证整根迁移校验子进程，然后从目标根启动并读回同一会话。编译主入口 SHA-256 为 `cd9a68912410127a83c8d59366994d84b8abf7738693400e62aff0c0b21a25cb`。安装器覆盖升级的后续验收见下节。
- **F 整仓回归通过。** `pnpm test` 的 76 个工作区任务全部通过，Desktop 3,997 项通过。后续脚本、WSL 执行、Agent 集成（197 项）、Desktop 集成（4 项）和服务端与 SDK 集成（132 项）全部通过。删包后，从根项目、CLI、TUI 和 Desktop 的依赖环境均无法解析旧包。

### Windows 1.2.28 原位覆盖升级验收

2026-11-19，在断网的 Windows Server 2022 Standard Evaluation（x64，构建 20348）虚拟机中，以普通用户运行官方 1.2.28 安装器。用旧版写入两条便签，记录文件夹布局和一条 SQLite 会话。关闭旧版后，在同一安装位置运行 1.2.31 候选安装器。两个安装器均使用 `/S`，退出码均为 `0`，安装登记从 1.2.28 更新为 1.2.31。验收复用同一隔离数据根，宿主的安装登记和原进程与测试前一致。

- **daemon 自动启动通过。** `0x80000003` 对应 Electron 加载应用代码前读取运行数据目录的检查。Windows 的桌面按需启动现在显式把已解析的目录传给 daemon。覆盖后由桌面拉起的 daemon 成功登记，通过健康和进程身份检查，并读回旧会话。 [启动修复](../../../apps/desktop/src/main/features/session/daemon-connection-service.ts) · [Electron 检查位置](https://github.com/electron/electron/blob/v45.2.1/shell/browser/browser_process_impl.cc#L165)
- **旧数据和离线便签通过。** 两条旧便签的正文、ID、时间戳、修订号和文件夹布局一致。旧会话库、Markdown 和组织文件的哈希一致。停止测试 daemon 后，在实际便签页面验证新增、编辑、删除和整理，重启后读回保存的结果。
- **第 1–3 版只读备份恢复通过。** 三份按对应历史版本构造的备份分别校验并恢复到独立目录。核对便签、会话记录和第 2、3 版的附件，再在 daemon 停止时打开各恢复目录读回便签。校验和恢复使用可写的临时副本，原归档哈希一致，21 个文件保持只读。 [备份校验和恢复](../../../packages/server/src/application/backup/application-backup.ts)

验收使用未签名的 Windows x64 安装包 `Vykor-1.2.31-setup.exe`，SHA-256 为 `08e3e4c64da0f3fbaf86a68d28f1c62ae1a7da1f590df83d8d2e95b334c6972e`。安装包、验收原始记录、测试数据和虚拟机文件留在本地。
