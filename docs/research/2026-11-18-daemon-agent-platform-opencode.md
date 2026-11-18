# Vykor daemon 如何成为可独立接入的 Agent 服务

> 状态：调研与建议，供评审。调研日期 2026-11-18。

Vykor 已经能在没有 Electron 的情况下运行 Agent，也已经有独立发布的客户端 SDK。下一步应让这个能力成为一份完整、可验证的产品承诺：只安装 CLI 后台和公开 SDK，第三方就能选模型、创建会话、提交任务、处理审批与提问、跟上执行进度，并在断开后重新接手。Desktop、TUI 和未来客户端应看到同一份运行记录。

现阶段最值得改的地方有两个。**内置便签归 Desktop，读写和打开文件夹都能离线完成。浏览器归可选执行环境，daemon 决定本次 Agent 能否调用，由 Electron 或部署方提供实际执行。** 另外，公开 SDK 已经覆盖大量运行操作，仍需给第三方一份明确清单，区分可稳定调用的 Agent 能力、部署时安装的扩展和管理员设置。

## 1. OpenCode 值得对照的边界

本次读取用户给出的 OpenCode Build 文档和官方 API，并用 OpenCode `v2.3.2` 核对关键实现。Vykor 基线为 `78bdc3d0d25139ffe17964e6a6530f955b6adab9`。较早的 OpenCode V1 文档和仓库旧计划用于说明历史背景。产品部署和真实模型调用超出本次验证范围。 [OpenCode JavaScript 客户端](https://opencode.ai/docs/build/client/) · [OpenCode v2.3.2](https://github.com/anomalyco/opencode/releases/tag/v2.3.2)

- **网络客户端和本机服务管理是两个入口。** `@opencode/client` 用服务端 URL 建立连接，可以传请求头或自定义 `fetch`。Node 专用的 `@opencode/client/service` 负责发现、启动、停止本机服务。资源接口和 OpenAPI（供程序读取的 HTTP 接口说明）来自同一份契约。第三方能用 TypeScript 客户端或普通 HTTP 接入。官方 API 参考将当前接口标为实验性，适合参考契约组织方式。 [客户端文档](https://opencode.ai/docs/build/client/) · [HTTP API](https://opencode.ai/docs/api)
- **会话写入、执行进度和历史读取各有入口。** `session.prompt` 将输入写入服务端并安排执行，服务还提供消息分页、活跃会话、待审批请求和表单操作。公开 JS 客户端的 `event.subscribe()` 是实时通知，断线期间会漏事件，也不会自动重连。第一方 Solid 客户端实现了重连和重读状态。另有独立的实验会话日志接口，其原始事件可以按配置持久化。读取最新状态和重新执行中断任务是两件不同的事。 [会话与事件 API](https://opencode.ai/docs/api#session) · [Solid 重连实现](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/client/src/solid/connection.ts#L148-L181) · [事件持久化开关](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/bus.ts#L185-L215)
- **扩展按实际执行位置组织。** 服务端插件注册工具、集成和自定义方法。桌面插件可以有单独的窗口入口和 Electron 主进程入口。两侧确实需要交换数据时才定义 Plugin RPC，也就是有自己入参和返回值的跨进程调用。OpenCode 另有进程内嵌入 SDK，Cloudflare 宿主会换掉当地不可用的文件和进程实现。适用于 Vykor 的思路是复用 Agent 内核，由部署方式装配运行环境。 [服务端插件](https://opencode.ai/docs/build/plugins/server/) · [桌面插件](https://opencode.ai/docs/build/plugins/gui/) · [Plugin RPC](https://opencode.ai/docs/build/plugins/rpc/) · [嵌入 SDK](https://opencode.ai/docs/build/sdk/) · [Cloudflare 宿主](https://opencode.ai/docs/build/sdk/cloudflare/)

Vykor 可以沿用自己的同步能力。它已经用会话快照与游标（客户端处理到哪一条事件的编号）补齐持久事件，文本增量由实时流显示，重连后以持久消息为准。OpenCode V2 的实验接口和它的恢复策略适合做对照。Vykor 对已有运行的默认重启行为是收束为中断，支持通过显式接口重新接纳符合条件的原输入。重放一条原输入可能产生新的执行，和把原来的文本、工具结果读回来有不同的后果。 [Vykor 同步契约](../client-sync-flow.md) · [Vykor 恢复规则](../operations-and-recovery.md#异常退出后的收束) · [OpenCode 重启恢复源码](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/session/execution/restart.ts#L34-L72)

## 2. Vykor 现有基础与真正的缺口

### 一条任务现在怎样跑通

1. `vk serve` 通过 `startVykorDaemon()` 读取设置、装配服务、打开数据目录并监听 HTTP。`@rzx/client` 用地址和 token 连接，通过 `/capabilities` 检查协议和功能。浏览器可以使用根入口。需要本机启动的 Node 调用方才导入 `/service`。 [CLI 后台入口](../../apps/cli/src/commands/daemon.ts#L56) · [daemon 默认装配](../../packages/server/src/daemon/default-daemon.ts#L37) · [客户端 SDK](../client-sdk.md)
2. 客户端创建 Session（保存整段对话的会话），然后用稳定的 Input ID 提交输入。daemon 校验并保存输入，返回接纳结果，再由会话的执行队列调度 Run（一次实际运行）。已有 Run 时可以排队，也可以要求补充到指定活动 Run。同 ID 重试同一笔请求能取回原接纳结果。 [运行路由](../../packages/server/src/http/routes/run-execution.ts) · [输入接纳与运行](../../packages/server/src/application/session/execution/README.md)
3. daemon 组装 `createDefaultNodeAgent()`，把模型、工具、审批回调和事件出口交给共用执行内核。内核执行模型和工具、持有当前执行与子 Agent；daemon 将事件整理成 SQLite 中的消息、Run、任务和权限记录，再通过 SSE（服务器持续推送事件的 HTTP 连接）发给客户端。CLI、TUI、Desktop 使用同一份持久状态。 [默认 Agent 工厂](../../packages/server/src/daemon/daemon-agent.ts#L385) · [事件写入入口](../../packages/server/src/application/daemon-application.ts#L640) · [应用与内核的状态边界](../agent-framework-capability-boundary.md)
4. 客户端用 `syncEvents` 读取快照并持续更新，用 `waitForRun` 取得指定 Run 的最终状态和消息。关闭等待或丢失连接只影响观察。要停止后台执行，需要 `sessions.interrupt`，并带上期望的 Run ID。另一个客户端可连接同一个 daemon、读回状态并继续处理待答请求。 [运行与审批示例](../../apps/client-docs/examples/node/run-with-permissions.ts) · [客户端同步](../client-sync-flow.md)

### 过去已经解决了什么

2026 年 7 月的 OpenCode 对照已经把会话归属从 TUI 的 `BackendHost` 迁到后台，8 月补了消息片段、快照和游标，10 月又补了慢订阅者积压、作用域和运行可靠性。后来 `@rzx/client` 独立发布，与内部 `@vykor/application-client` 共享传输和同步。这些改造建立了共享的运行与状态读取方式。产品 API 移到私有客户端以后，默认 daemon 仍会装配对应服务。便签继续挂在它的会话存储上，已登记服务默认打开 Desktop Browser 桥接，Desktop 甚至要求这个桥接存在才接受连接。**目前最突出的差距在后台装配和能力的公开边界。** [七月 daemon 方案](../superpowers/plans/2026-07-31-daemon-session-runtime.md) · [八月事件模型](../superpowers/plans/2026-08-01-session-part-event-model.md) · [十月 P1](../superpowers/plans/2026-10-31-opencode-p1-reliability.md) · [十月 P2](../superpowers/plans/2026-10-31-opencode-p2-reliability.md) · [私有应用客户端](../../packages/application-client/README.md) · [Desktop 连接条件](../../apps/desktop/src/main/features/session/daemon-connection-service.ts#L239)

### 第三方接入的三类能力

- **已有公开入口。** 协议和能力检查、模型/Agent 定义/Skill 查询、会话与历史、附件、权限、排队与运行中补充、停止与显式恢复、Goal、Jobs、同步事件和只读会话文件。应优先在现有 `@rzx/client` 上把这些组织成一个完整接入流程。`AskUser` 已可经 `/permissions` 查询和回复，HTTP 类型接受 `answer`，公开 SDK 的回复类型漏了这个字段，TUI 的专门回答入口仍未接通。建议先补齐 SDK 类型、示例和跨客户端验收。提问回复要带答案，工具批准要带明确授权决定，Goal 暂停后的用户回答走已有 Goal 操作。 [公开资源](../../packages/client/README.md#公开资源) · [AskUser 处理](../../packages/server/src/application/daemon-application.ts#L647) · [协议回复类型](../../packages/protocol/src/session/session-requests.ts#L58) · [SDK 回复类型](../../packages/client/src/types/index.ts#L130) · [TUI 回答入口](../../apps/frontend/src/hooks/sync-submodules/actions.ts#L379) · [Goal 操作](../../packages/client/src/resources/session/session-resource.ts#L420)
- **daemon 已能执行，接入方式应按使用者明确。** Agent 可执行子任务、工作流、已配置的 MCP（接入外部工具的标准协议）与插件工具。第三方目前通过会话和 Jobs 查询、等待和控制已有任务。工作流定义的直接提交、会话有效工具的查询和本轮插件选择，是可以按消费者需求补齐的接口。提供商凭据、插件安装、OAuth（通过外部服务登录授权）、定时任务管理等操作有各自的权限和生命周期，单独保留管理入口。 [应用服务目录](../../packages/server/src/application/README.md) · [Jobs 协议](../jobs-protocol.md) · [Workflow CLI 数据归属](../workflow-cli.md) · [插件能力调用](../plugin-capability-invocation-design.md)
- **缺一份机器可读的公开 HTTP 契约。** 现有 Hono 路由、Protocol 类型、运行时解码和 TypeDoc 说明各自有效。这次在服务端 HTTP、协议和 SDK 文档生成目录中没有找到可消费的 OpenAPI 规范或生成管线。建议先为对外承诺的资源登记方法、路径、输入输出、错误、能力和版本，从同一契约产生 API 参考，再验证它和实际路由一致。SSE 另外写明事件类型、持久性、游标和重连规则。保留现有 SDK 的同步辅助函数和调用方式。 [HTTP 组装](../../packages/server/src/http/server.ts) · [协议契约](../protocol-contract.md) · [SDK 文档生成](../../apps/client-docs/README.md)

## 3. 建议的职责和状态归属

```text
Desktop / TUI / 第三方应用 ── 公开 Agent 客户端 ──→ daemon
                                                   ├─ 持久会话、输入、Run、权限、附件、事件
                                                   └─ 共用执行内核 ──→ 已装配的工具及执行环境

Desktop 便签界面 ── 进程间调用 ──→ Electron 主进程 ──→ 本地便签库
浏览器界面 / 自定义浏览器环境 ── 窄接口 ──→ daemon 的可选浏览器工具
```

- **默认后台**负责可共享的会话、模型、运行、工具授权、工作区、消息和恢复。在已有 `startVykorDaemon` / `startVykorServer` 上把 Agent 必需服务、部署方选装的能力和维护入口分清。标准后台可以由 CLI 启动。已登记实例仍可由多个客户端共享。部署形态本身无需决定权限宽松程度，现有 `desktop_managed` / `cli_advanced` 涉及实际执行与设置，应逐项核对行为再调整。 [默认装配](../../packages/server/src/daemon/default-daemon.ts#L37) · [注册后台](../../packages/server/src/daemon-host/registered-daemon.ts#L228) · [信任边界](../security-and-trust-boundaries.md)
- **程序内嵌入**继续提供 `createDefaultNodeAgent()` 或 `createAgentKernel()`。调用程序自己管理资源与生命周期。如果需要多客户端共享、会话持久化和重启恢复，使用后台服务和公开客户端。可注入使用方的实现是执行层接口，应用连接后台是网络接口。 [Agent SDK](../agent-sdk.md) · [内核与 daemon 分工](../agent-framework-capability-boundary.md)
- **产品与扩展**按状态的消费者决定归属。仅供单个产品的窗口状态、便签、草稿留在产品内。代表远程/无人值守运行的调度和渠道可作为后台选装功能，触发后仍写同一个会话运行体系。若 Agent 需操作某个产品的数据，由该产品显式提供特定工具和授权范围。 [产品接入边界](../product-surface-integration.md) · [定时任务](../scheduled-tasks-flow.md) · [渠道消息](../channels-flow.md)

对外首期按受信任的个人或部署实例定义。当前 daemon 的 Bearer token（请求头中的连接凭据）保护会话、审批、设置和运维等接口。若要提供公开多用户服务，需要另行设计用户身份、每个用户可访问的会话和工作区、凭据与执行隔离。工具审批仍应由 daemon 统一判断。 [远程连接](../remote-attach.md) · [认证与权限边界](../security-and-trust-boundaries.md#daemon-bearer-token)

### 收窄 `@vykor/application-client` 的职责

**以过渡层看待这个包。** 它复用了公开 SDK 的传输和同步，但自己又组装了一个同名 `VykorClient`，把会话、便签、设置、终端、插件应用和后台管理都挂到同一对象上。包根还重导出了公开 SDK，`/service` 原样转发公开服务入口。一个具体的重复是 `SessionResource.getState`：两边已经都支持 `partView: "summary"`，仍各自发同一个请求、解码同一个结果。CLI 的单次运行和 TUI 的会话同步仍从私有包进入，产品接入自然会继续选这个大入口。 [私有客户端构造](../../packages/application-client/src/application-client.ts) · [公开客户端构造](../../packages/client/src/transport/http-client.ts) · [私有快照方法](../../packages/application-client/src/resources/session/session-resource.ts#L13) · [公开快照方法](../../packages/client/src/resources/session/session-resource.ts#L177) · [CLI 入口](../../apps/cli/src/print-session.ts#L293) · [TUI 同步入口](../../apps/frontend/src/hooks/useServerSync.ts#L3)

- **共享的 Agent 调用由首方产品直接使用 `@rzx/client`。** 会话、输入、审批、附件读写、Jobs 和同步与第三方共用一条调用路径。本机启动直接使用 `@rzx/client/service`。CLI 单次运行可先迁移已经覆盖的调用，TUI 和 Desktop 按调用点处理仍依赖私有操作的部分。 [本机服务转发](../../packages/application-client/src/local-service/index.ts) · [公开资源](../../packages/client/README.md#公开资源)
- **桌面自己的功能由实际持有状态的模块提供。** 内置便签走 Electron IPC，窗口、草稿、展示和本地命令由产品管理。仍需要 daemon 参与的产品操作保持独立入口，例如插件页面的工具调用需要服务端核对租约和范围。不能因为它由 Desktop 发起就把授权逻辑移到桌面。 [桌面业务数据](../../apps/desktop/src/main/features/business-data/README.md) · [插件页面服务端操作](../../packages/server/src/http/routes/session-plugin-apps.ts)
- **daemon 管理保留窄接口。** Provider 配置、凭据、全局设置、附件清理等操作仍由后台处理，可按具体职责复用小的内部调用模块。一部分可选后台能力仍有跨产品消费者，例如调度或渠道，可保留自己的客户端资源。逐个核对使用者，再决定哪些值得合用一个小包。拆分客户端入口后，管理授权仍由服务端负责。 [当前 Provider 调用](../../apps/desktop/src/main/features/provider/provider-service.ts#L24) · [附件维护资源](../../packages/application-client/src/resources/session/attachment-resource.ts) · [认证与权限边界](../security-and-trust-boundaries.md)

迁移时先让首方普通 Agent 路径直接走公开 SDK，退掉已经有公开等价实现的转发和重复方法。便签迁出、后台管理与可选能力拥有各自入口之后，再按剩余使用者决定是保留小型内部包还是退役 `@vykor/application-client`。验收看正常产品入口是否共用一套会话、权限和同步逻辑，以及剩余私有调用是否能说清由谁执行、状态放在哪里。

### 便签改由 Electron 主进程持有

**当前实现。** 便签页和聊天/代码选区的保存功能经 `window.desktop.notes` 调用 Electron 主进程。`DesktopNoteService` 再去获取 daemon 客户端，访问私有 `/notes` 接口。正文位于 `data/session-runtime/notes/*.md`，会话 SQLite 保有索引、元数据和旧正文迁移逻辑。文件夹和排序在 `organization.json`，写入会比对读取时的版本。草稿恢复已经有桌面自己的存储队列。独立示例插件 `notes-app` 操作它自己的会话数据，和内置便签是两个功能。 [桌面便签入口](../../apps/desktop/src/renderer/src/components/desktop/notes-page/README.md) · [当前主进程服务](../../apps/desktop/src/main/features/notes/note-service.ts) · [便签仓库](../../packages/services/src/notes/README.md) · [桌面恢复数据](../../apps/desktop/src/main/features/business-data/README.md) · [示例插件](../../examples/plugins/notes-app/README.md)

**建议实现。** 保留现有便签 IPC（窗口与主进程交换请求的接口），把 `DesktopNoteService` 换成本地便签仓库。建议把正文和索引放在 `data/desktop/notes/`，继续支持打开 Markdown 目录、外部修改检测、正文版本冲突、文件夹和排序。主进程负责串行写入和安全替换，renderer 保存编辑中内容，沿用已有恢复稿路径和机制。这样多个窗口有明确的写入者，也能继续用当前整根迁移方式搬家。纯浏览器产品可以用 IndexedDB 保存它自己的便签，等出现跨设备共享需求时再设计同步。 [便签组织存储](../../packages/services/src/notes/README.md) · [数据根迁移](../data-root-migration.md)

**迁移要带走完整记录。** 已有应用备份会保存便签正文、组织文件和上一版组织，旧备份可能只有 SQLite 中的正文。升级由一个明确的迁移入口读出正文、ID、时间、版本、删除状态与组织布局，在新目录写入并校验后记下完成状态。迁移中冻结旧写入，切换后只有 Electron 写新库。保留旧来源作为可验证的恢复材料，重复迁移时依据来源标识和完成记录避免覆盖用户在新库里的编辑。为新数据接好桌面备份与恢复，再移除 daemon 的日常 `/notes`、私有客户端资源和 `SessionStore.notes` 装配。旧备份由兼容导入入口读取。 [当前备份与恢复实现](../../packages/server/src/application/backup/application-backup.ts#L82) · [当前便签仓库的旧数据迁移](../../packages/services/src/notes/note-repository.ts)

### 浏览器作为可选的执行环境

**当前实现。** Electron 主进程持有桌面浏览器页、会话与窗口绑定。Agent 的 `Browser` / `BrowserDeveloper` 工具在 daemon，由它们调用 `BrowserHost`，这个接口描述浏览器接收什么动作、如何请求批准和返回结果。目前已有两个接入点。`startVykorDaemon` 可注入 `browserHost`；已登记 daemon 默认打开私有桌面桥接，由 Electron 经本机连接处理浏览器操作并提交结果。`browserBridge` 表示桥接路由已可用，不能证明存在已连接的桌面或可用页面。即便没有宿主，当前装配也向模型注册这两个工具。Desktop 则把 `browserBridge` 当成普通连接的必需条件。 [BrowserHost](../../packages/server/src/application/browser-tools/browser-host.ts#L53) · [工具注册](../../packages/server/src/application/daemon-application.ts#L597) · [已登记后台](../../packages/server/src/daemon-host/registered-daemon.ts#L228) · [Desktop 连接条件](../../apps/desktop/src/main/features/session/daemon-connection-service.ts#L239) · [浏览器能力说明](../browser-capabilities.md)

**建议实现。** 允许三种组合。独立服务默认只装配 Agent 基础能力；桌面组合选装 Electron 桥接，继续由 Electron 管窗口、标签和批注；部署方可在可信后台装配处注入自己的 `BrowserHost`，按已声明的动作和结果运行。现有注入点是服务端代码入口，给第三方部署者使用时，需要明确导出和版本约定。如果只需要接入一组独立的网页工具，已有 MCP 入口更直接。只有宿主实现开发者检查并显式启用时才注册 `BrowserDeveloper`。Desktop 握手检查协议与数据目录，桥接按能力单独连接。桌面接到已经运行的纯 Agent 实例时，普通会话可用，浏览器 Agent 工具是否可用由实例的装配决定。手动浏览和文件预览继续走 Electron 自己的入口。 [服务端注入点](../../packages/server/src/daemon/default-daemon.ts#L15) · [工具行为](../../packages/server/src/application/browser-tools/browser-tool.ts) · [文件预览路由](../../apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/file-open-request.ts)

工具描述应随宿主能力调整，调用前检查当前会话范围。未连接或未派发要能提示用户；派发后失联应标记结果未知，由人或上层判断是否重试。接口需约定取消、超时、输出大小、截图处理和宿主资源关闭。daemon 继续拥有 Agent 权限决定，宿主在授权范围内执行和返回。跨进程通信先沿用现有受控桌面桥接，部署方可先用进程内注入。后续出现第二类确实需要跨进程的宿主，再评估通用注册协议。 [BrowserHost 类型](../../packages/server/src/application/browser-tools/browser-host.ts) · [桥接状态与回执](../../packages/server/src/application/browser-tools/browser-bridge.ts#L44) · [权限流程](../permission-flow.md)

## 4. 实施顺序与验收

1. **做一个无 Electron 的消费者验收。** 用隔离数据目录启动现有 `vk serve`，独立 Node 项目只安装公开 `@rzx/client`。先复用现有接入示例，再让客户端 A 创建会话、以稳定 ID 提交，客户端 B 接续读取、处理一次工具审批和一次 `AskUser`、读到结果。验证断线补齐记录、提交重试不增加 Run、旧 Run ID 无法停止新的执行。同步补齐公开回复类型及示例。后续再从一个实际消费者需要的资源开始产出 OpenAPI 和协议一致性测试。 [现有公开示例](../../apps/client-docs/examples/node/run-with-permissions.ts) · [HTTP 集成用例](../../tests/server-client/http.test.ts)
2. **先解开 Browser 的连接依赖。** 先让 Desktop 可以接入没有 `browserBridge` 的兼容实例，再修改后台装配。分别验证没有浏览器工具、现有桥接可用、注入最小 `BrowserHost` 的三种情况。普通文本和文件操作都能执行。浏览器能力验证覆盖审批拒绝、取消、无宿主和断线后的真实结果状态，开发者检查有单独开关。 [桌面连接](../../apps/desktop/src/main/features/session/daemon-connection-service.ts) · [浏览器桥接测试](../../packages/server/src/http/__test__/browser-host.test.ts)
3. **迁出便签，再删除旧写入入口。** 用含旧 SQLite 正文、Markdown、新旧组织文件及未保存草稿的测试数据验证升级。检查重复迁移、旧备份导入、版本冲突、打开目录、聊天和代码选区创建以及 daemon 停止时独立读写。迁出完成后确认旧 `/notes` 退役，日常便签数据只由 Desktop 打开。 [现有便签服务](../../packages/server/src/application/notes/README.md) · [应用备份测试](../../packages/server/src/application/backup/__test__/application-backup.test.ts)
4. **按需求补全开发者契约。** 把现有能力整理成「公开会话操作」「配置后可用」「管理员操作」清单。先选真实消费者需要的缺口，例如会话允许的工具发现、已安装能力选择或 Workflow 提交。保持同一执行队列、同一会话存储和同一权限决策，按能力标记和协议变更规则发布。 [公开客户端边界](../../packages/client/README.md) · [协议版本策略](../protocol-contract.md#版本匹配)

首个里程碑应交付一个脱离 Desktop 安装的客户端闭环，同时让桌面可以连没有浏览器能力的 daemon。便签迁移有独立的数据与兼容工作，可以并行验证。在这三个条件落实后，开发者就能用 Vykor 现有 Agent 能力构建自己的应用，Vykor Desktop 也能独立决定自己的产品功能放在哪里。

## 5. 本次验证

基于固定源码和官方参考核对以上路径。现有测试共通过 61 项，包括 6 项 server-client 集成用例，以及权限代理 41 项、应用备份 7 项、浏览器桥接 7 项。覆盖文本运行、重启收束、提交幂等、SSE 实时与重放、断线后回复审批、运行中补充，以及现有便签备份和浏览器连接行为。对外安装演练、真实模型、便签迁移和可选浏览器三种组合属于后续实施验收。 [HTTP 集成](../../tests/server-client/http.test.ts) · [权限代理](../../packages/server/src/permissions/__test__/permission-broker.test.ts) · [备份](../../packages/server/src/application/backup/__test__/application-backup.test.ts) · [浏览器桥接](../../packages/server/src/http/__test__/browser-host.test.ts)
