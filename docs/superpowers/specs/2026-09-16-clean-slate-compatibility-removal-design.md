# Clean-slate 全仓兼容层清理设计

> 状态：已确认设计，等待实施计划。适用于 OpenHarness-ts 快速迭代期；当前唯一用户接受一次性重置全部本地数据、配置和缓存。

## 1. 背景与决策

OpenHarness-ts 尚未进入需要维护外部兼容承诺的阶段，也没有其他用户依赖旧 API、旧配置、旧数据库或旧协议。继续保留兼容门面、历史迁移和双发行删除门禁，会让当前架构同时维护新旧两套入口，增加理解、测试和修改成本。

本轮采用 clean-slate（只保留当前设计）策略：仓库中的当前领域边界、当前 API 和当前数据结构是唯一标准。旧入口直接删除，不经历弃用发行、保留发行或 major 删除窗口。清理对象是 OpenHarness 自身演进留下的旧入口和旧持久化格式，不是删除当前产品主动支持的外部互操作能力。

## 2. 目标

- 删除全仓为旧版本、旧命名或旧结构保留的 API、转发门面、别名、转换器和数据迁移。
- 让生产代码直接依赖当前的 Repository、Transaction、Application Service、Client Resource 和协议入口。
- 将数据库初始化收敛为一份当前 schema 基线，只支持从空数据目录创建新环境。
- 将配置、HTTP、CLI 和 TypeScript 公共 API 收敛为唯一当前形式。
- 删除 Stage 8 A/B/C 兼容发行、ledger、证据登记和删除授权流程。
- 保留服务当前版本可靠运行的事务、恢复、重试、资源释放和平台适配机制。

## 3. 非目标

- 不读取、修复、转换或保留任何旧开发数据。
- 不提供旧配置字段、旧 HTTP 路由、旧 CLI 命令或旧 TypeScript API 的迁移期。
- 不为被删除入口增加新的适配器、重定向、deprecated 声明或专用错误提示。
- 不借本轮重新设计已经稳定的领域模型，也不重写与兼容清理无关的业务逻辑。
- 不删除当前版本所需的失败恢复和跨平台处理。

## 4. “兼容代码”与“可靠性代码”的边界

以下内容属于兼容代码，应删除：

- 旧名称到当前名称的薄转发方法、属性、类型别名和 re-export。
- 已有当前替代入口的 facade、adapter、wrapper 或委托层。
- 为旧字段、旧枚举值、旧命令、旧参数和旧响应结构保留的解析分支。
- 已被当前路由替代的 HTTP 路由、重定向和双写逻辑。
- 只用于把旧数据库逐步升级到当前结构的历史 migrations。
- 旧协议版本的协商、降级和能力模拟。
- 只验证旧入口仍可使用的测试、fixture、文档和发布门禁。

以下内容不属于兼容代码，应保留：

- 数据库事务回滚、原子写入、幂等处理和崩溃恢复。
- Run、Job、Terminal、Attachment 等当前生命周期的恢复与资源清理。
- 网络重试、超时、取消、错误分类和安全失败。
- Windows、Linux、WSL、PowerShell、Bash 等当前支持环境之间的平台选择。
- 精确协议版本检查。Client 与 daemon 版本不一致时拒绝连接，不尝试兼容运行。

名称中出现 `legacy`、`compat`、`fallback` 或 `migration` 不能单独作为删除依据。每一项必须先确认其实际职责；仍服务当前版本的代码应重命名或保留。

### 4.1 明确保留/删除矩阵

| 能力 | 结论 | 原因 |
|---|---|---|
| OpenHarness 旧 Client、Store、Application、CLI、HTTP、配置、数据库入口 | 删除 | 已有当前替代入口，仅服务自身历史版本 |
| `.claude/skills` 兼容扫描 | 删除 | 当前项目技能目录是 `.agents/skills` 与 `.openharness-ts/skills` |
| 旧 shell 标量到 `ShellDescriptor` 的回退 | 删除 | 当前环境必须直接提供完整 `shellDescriptor` |
| 旧 plugin scope、manifest compatibility 字段和环境变量别名 | 删除 | Native Plugin 只接受当前 manifest；保留正式的 `user` 与 `managed` scope，只删除旧 `project`、`local` scope |
| OpenAI-compatible Provider | 保留 | 这是当前 Provider 类型和用户选择，不是旧 OpenHarness API |
| Codex/Claude 插件导入转换器 | 保留 | 这是显式导入外部格式的当前产品功能；转换结果必须是当前 Native Plugin，不承担旧 OpenHarness 数据升级 |
| Attachment capability 匹配 | 保留 | 当前模型能力路由 |
| Windows/WSL/PowerShell/Bash 选择 | 保留 | 当前平台适配 |
| 事务、恢复、重试、取消和安全失败 fallback | 保留 | 当前可靠性机制 |

## 5. 清理范围

### 5.1 Client 公共 API

- 从 `OpenHarnessClient` 删除 118 个顶层平铺转发方法。
- 只保留 `client.sessions`、`client.projects`、`client.system`、`client.providers`、`client.plugins`、`client.auth`、`client.development`、`client.protocol` 等当前领域 Resource。
- 审核 `transport`、`sse`、`baseUrl`、`token` 和 `fetchImpl` 等底层入口；没有当前生产用途或明确设计职责的直接删除。
- 从公共契约删除 compatibility 分类、deprecated 元数据和 release gate 字段。
- 删除只验证旧方法签名或转发行为的测试。

### 5.2 Services 与存储边界

- 删除 `SessionStore` 上已经由 Projects、Schedules、Channels、Goals、Permissions、Attachments、Sessions、Conversations、Runs 等 Repository 或 Transaction 接管的转发方法。
- 调用方直接注入所需的最小领域能力，不通过完整 `SessionStore` 取得跨域权限。
- 删除旧 Store 类型别名、旧构造参数和兼容聚合接口。
- 保留数据库生命周期、当前事件订阅、当前 waiter/listener 和尚未有独立所有者的真实职责；不能为了减少文件数量而删除当前能力。

### 5.3 Server Application 与 Runtime

- 删除只负责向新 Query、Command、Admission、Control、Maintenance 服务转发的旧 Application Service 或 Engine 入口。
- `SessionApplicationService` 不能整体按兼容门面删除。它的纯转发成员删除，真实会话编排重命名为当前 `SessionInteractionService` 并保留；只有后续审计证明职责可直接归入现有服务时才搬移实现。
- `DaemonApplication` 只组装当前服务，并向 HTTP routes 暴露当前窄接口。
- 删除旧路由和旧请求/响应 decoder，不做重定向。
- 生产代码不得重新依赖完整 Store、Daemon 或 Runtime 以绕过已经建立的领域边界。

`SessionApplicationService` 的方法级归属固定如下，实施计划不得重新把它们合并成全能 facade：

| 现有成员 | 最终入口 | 处理方式 |
|---|---|---|
| `createSession`、`forkSession`、`updateSession`、`closeRuntime`、`archiveSessionTree`、`deleteSessionTree` | `SessionCommandService` | 调用者改为直接依赖 Command，删除转发 |
| 不带副作用的 `getSession` | `SessionQueryService` | 调用者直接查询，删除转发 |
| `getSession({ warm: true })` 的 warming 部分 | `SessionInteractionService` | 查询与 warming 拆开，保留当前行为 |
| `editLatestPrompt`、`admitPrompt`、`resumeRun` | `SessionInteractionService`，内部使用 `RunAdmissionService` | 保留插件选择、幂等、lease、live child 和事件编排 |
| `interruptSession`、`promoteQueuedPrompt`、`cancelQueuedPrompt` | `SessionInteractionService`，内部使用 `RunControlService` | 保留 live child、lease、取消元数据和事件编排 |
| `awaitRun` | `RunControlService` | 调用者直接依赖 Control，删除转发 |
| `withSessionOperation` | 独立最小能力 `SessionOperationRunner` | `SessionInteractionService` 与 `SessionGoalService` 共同依赖；只暴露 `run(sessionId, work)`，不暴露完整 facade |
| operation lease、warming、ready 检查和 descendant 协调 | `SessionInteractionService` 与 `SessionOperationRunner` 的内部实现 | 属于当前可靠性与业务编排，不删除；Goal 通过 Runner 保留 ready、lease、事件 checkpoint/publish 和幂等事务语义 |

### 5.4 Desktop、Frontend 与 CLI

- 删除为旧调用保留的 service 属性、方法、hook 返回值和 store facade。
- 删除旧 CLI 命令、参数、环境变量别名和输出格式兼容分支。
- 所有调用统一使用当前 Client Resource 和当前 IPC/应用服务入口。
- 删除只验证兼容属性仍存在的测试，保留当前用户流程和状态恢复测试。

### 5.5 配置、协议与数据

- 配置只接受当前字段和当前枚举值，未知字段沿用当前严格校验规则。
- 删除旧字段重命名、默认值补齐、结构转换和兼容读取。
- 本次硬切原子提升 `CURRENT_PROTOCOL_VERSION`。Client transport 在首次 HTTP/SSE 业务请求前强制调用 `/capabilities` 完成精确版本握手，并缓存本连接的验证结果；`/health` 和 `/capabilities` 是唯一握手例外。握手失败时不得发出业务请求。每个后续业务请求仍携带当前协议版本，Server 在进入 handler 前拒绝缺失、旧版或未来版本，且不得产生业务副作用。这样同时阻断旧 Client→新 daemon 和新 Client→旧 daemon。
- 历史数据库 migrations 压缩为一份当前 Drizzle schema 基线，同时重建 `_journal.json`。
- 数据库启动路径只为真正空库定义行为：单一基线一次创建全部表、索引、外键和当前 schema generation。旧库不会进入受支持路径，不识别旧 format，也不提供自动迁移、修复或友好拒绝；用户在运行新代码前完成数据重置。
- 实施完成并验证后，由用户明确授权执行一次本机开发数据、配置和缓存重置。代码清理本身不自动删除用户目录。

### 5.6 发布与治理脚本

- 删除 `client-compat-removal-ledger.json`、schema、integrity、removal gate 和 A/B/C 专用 release helper 及对应测试。
- 删除 Stage 8 A/B/C release phase、双发行证据和授权摘要。
- Tag Release 恢复单一普通稳定发行输入。
- 将通用发布能力迁入不含 compatibility 语义的 release helper：固定 commit checkout、同名 tag 冲突检测、测试和双平台 Desktop 构建、artifact 完整性检查、构建成功后创建 tag、npm 重跑幂等与在线 `npm view` 校验、npm 成功后创建 GitHub Release、Release 重跑更新 notes/artifact、发布后 notes 比对、证据摘要和失败通知。
- 新增独立 workflow 结构测试，防止删除兼容脚本时连带删除上述发布安全顺序。
- 公共 API 检查继续存在，但只校验当前导出面和架构边界。

### 5.7 其他包级兼容清理

- `environment` 与 `tools`：移除旧 shell 标量和 `legacyShellDescriptor`；当前环境必须提供 `shellDescriptor`。
- `skills`：移除 `.claude/skills` 扫描、说明和测试，只保留当前技能目录。
- `plugins` 与 `agent-runtime`：移除 manifest `compatibility` 字段、environment aliases、旧 `project`/`local` 安装 scope 的读取/警告路径；保留当前 `user` 与 `managed` scope 及 managed 插件不可修改、不可卸载、不可覆盖的安全规则。旧记录无需识别。
- `plugin-converters`：保留显式的外部插件导入功能，但删除其中仅为旧 OpenHarness manifest 或旧 Native Plugin schema 服务的分支。
- `protocol`、`core`、`tools`、`skills`、`plugins`、`environment`、`agent-runtime` 全部进入实施与回归测试范围，不能只验证六个上层包。

## 6. 实施顺序

### 6.1 建立审计清单

全仓扫描 deprecated、legacy、compatibility、migration、fallback、旧路由和旧字段。每项记录：当前定义、当前调用者、当前替代入口、删除或保留结论。对于语义不明确的项目，先追踪运行入口再决定，禁止按关键词批量删除。

### 6.2 迁移残余调用者

先把仍使用旧入口的调用改到当前边界。新的依赖必须是所需最小能力，不能为了方便新增另一层兼容 facade。每个子域删除前必须做到允许清单外的全仓符号引用归零，覆盖生产代码、测试、类型位置、mock、公共 contract、脚本、fixture 和文档生成输入；旧名称只允许存在于 forbidden-surface 数据和专用负向测试目录，不能只统计运行时调用。

### 6.3 删除兼容提供者

按以下顺序删除，以缩短不可编译窗口：

1. Client 平铺 API、保证旧入口仍存在的兼容测试/fixture、公共 contract/schema/test、ledger/gate/release phase、根脚本引用和相关文档作为一个原子批次修改；同批新增基于 forbidden-surface 的负向 TypeScript fixture。不能先删 facade、后删必然要求 facade 存在的门禁。
2. Desktop、Frontend、CLI 的旧属性、命令和适配器。
3. 先建立 `SessionInteractionService` 最终窄接口、共享实例和供 Goal 共用的 `SessionOperationRunner`，迁移 HTTP、Channel、Schedule、Goal 与测试；再删除 Server 的纯 Application/Engine 转发和旧 HTTP 路由。
4. Services/SessionStore 的领域转发方法和旧类型。
5. `environment`、`tools`、`skills`、`plugins`、`plugin-converters`、`agent-runtime` 中经矩阵确认应删除的兼容分支。
6. 旧配置、协议协商和历史数据迁移，生成并验证单一数据库基线。

每批删除后先运行目标包 typecheck/test，再运行根级 `check-types`、架构检查和相关脚本测试。每个提交必须保持这些门禁可运行；无法独立变绿的强绑定内容必须放入同一原子批次。

### 6.4 重建事实源

- 公共 API contract 只列当前入口。
- architecture baseline 只记录当前允许的边界，不再保存“可下降但不可增加”的兼容数量。
- 将完整旧表面移入纯测试用途的 forbidden-surface 清单。它只防止旧名称回归，不含发行状态、授权、迁移实现或兼容承诺；至少覆盖 118 个 Client 方法、旧类型/re-export、路由、CLI 命令/参数/环境变量、配置字段、枚举和 schema 名称。
- 数据库 schema 以新基线为唯一事实源。
- 文档只描述当前运行路径、入口、状态位置和返回结果。

### 6.5 删除兼容治理

移除 Stage 8 A/B/C 计划和运行时代码的依赖关系，将阶段 8 重新定义为一次 clean-slate 收口。历史设计文档可以保留并标记“已被本设计取代”，避免丢失决策背景；当前状态文档不得继续声称需要双发行门槛。

## 7. 数据重置

数据重置是实施后的独立操作，不嵌入应用启动逻辑，也不由测试脚本隐式执行。

执行前必须：

- 枚举配置覆盖目录、默认配置目录、项目 `.openharness-ts`、Desktop `userData` 和缓存，列出 OpenHarness 独占的叶子路径；不得直接把 `OPENHARNESS_CONFIG_DIR` 指向的整个目录视为可删除根。
- 对每个目标解析规范绝对路径以及 junction/symlink 最终目标；禁止盘符根、用户主目录、工作区根和它们的任何祖先。
- 确认每个目标位于用户最终确认的允许根内，且只属于 OpenHarness 开发数据、配置和缓存。
- 停止正在运行的 daemon、CLI、Desktop 和相关后台进程。
- 停止进程后重新解析并验证同一清单，防止路径在检查与删除之间变化。
- 向用户展示最终精确路径、链接解析结果和是否可恢复，并获得逐项明确授权。

执行后逐项证明目标不存在，再从空目录启动当前版本，生成新的配置和数据库。旧数据不备份、不迁移；若用户希望保留任何文件，必须在删除前另行提出。代码验收始终使用隔离临时目录，不依赖删除真实开发数据；代码可合并与本机数据切换是两个独立状态。

## 8. 测试与验收

### 8.1 静态边界

- 全仓 TypeScript 类型检查通过。
- Client 当前公共 API 与 contract 完全一致。
- 除 forbidden-surface 清单和指定负向测试目录外，全仓不存在已删除入口的直接调用、属性引用、解构、索引访问、类型引用、mock、fixture 或字符串映射。
- Server、Services、Client、Desktop、Frontend、CLI、Protocol、Core、Plugins、Plugin Converters、Tools、Skills、Environment 和 Agent Runtime 的架构依赖规则通过。

### 8.2 反兼容测试

- forbidden-surface 清单中的 118 个旧 Client 方法、旧类型和 re-export 全部不能编译或导入。
- 清单中的旧 CLI 命令、参数、环境变量和输出格式分支全部不存在。
- 清单中的旧 HTTP 路由全部返回标准 404。
- 清单中的旧配置字段、嵌套结构、枚举值和错误类型在产生启动副作用前被运行时校验拒绝。
- 协议版本在本次变更中提升；旧 Client→新 daemon 因请求缺失/携带旧版本被 Server 拒绝，新 Client→旧 daemon 因强制 `/capabilities` 握手失败而不发送业务请求。缺失、旧版和未来版本三类请求都必须在业务 handler 前失败，且不产生数据库或进程副作用。
- 仓库中不存在旧 facade 实现、旧数据转换器和历史 migration runner。

反兼容测试的目的只是防止旧入口被重新加入，不承诺提供迁移体验。

### 8.3 当前行为

- 根级 `check-types`、`test`、`build`、`check:architecture`、`check-docs` 与脚本测试通过。
- 使用临时 `OPENHARNESS_CONFIG_DIR`、临时项目目录、临时 Desktop `userData` 和本地假 Provider/HTTP fixture，从空目录完成默认配置加载、数据库创建和 daemon 启动；不得读取真实 home、项目旧状态或访问公网。
- 单一数据库基线创建全部表、索引、外键并写入当前 generation；通过 schema inventory 与压缩前最终结构对比，二次打开保持幂等。
- CLI 和 Desktop 打包产物都包含同一基线，并能从各自临时空目录完成建库。
- 通过当前 Client/CLI 完成一次 Session 创建、使用本地假 Provider 的 Prompt 执行、状态读取和退出清理。
- Windows/Linux Desktop 构建验证当前核心流程；WSL 平台选择单独串行验证。缺失配置采用当前默认值，不要求为了兼容旧行为生成额外配置文件。

### 8.4 环境例外

已知 Windows/WSL 并发运行可能产生 `node-pty AttachConsole failed` 或 E2E 超时。这类失败必须串行复跑对应文件。只有串行复跑通过且失败与本次改动无关时，才可作为环境例外记录；其他失败必须修复。

## 9. 提交与集成策略

- 使用独立 worktree 和功能分支实施。
- 按审计、调用迁移、Client 删除、应用层删除、存储与配置重置、治理收口拆分提交。
- 不发布中间状态，不创建兼容发行。
- 全部代码验证完成并审查后即可合并 `main`；真实本机数据重置和切换验证在用户确认精确路径后独立执行。
- 推送、发布和本机数据删除分别需要明确授权，不能由“实现代码”自动推导。

## 10. 完成标准

- OpenHarness 自有生产代码只存在一套 API、配置、协议和数据结构；明确保留的外部格式导入和 Provider 互操作能力不计为历史兼容层。
- 118 个 Client 平铺方法及其他纯兼容 facade 全部删除。
- `SessionStore` 和 Application 层不再承担已迁出的领域转发职责。
- 历史 migrations 已压成当前基线，空数据目录可直接初始化。
- Stage 8 A/B/C 发行、ledger 和删除授权机制已删除。
- 可靠性与平台适配测试仍通过。
- 文档、公共契约和架构状态与代码一致。
- 代码完成标准不依赖真实数据删除；合并后另行记录“本机数据尚未切换”或“用户授权后已安全重置并验证全新启动”。
