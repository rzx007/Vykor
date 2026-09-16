# Clean-slate 全仓兼容层清理设计

> 状态：已确认设计，等待实施计划。适用于 OpenHarness-ts 快速迭代期；当前唯一用户接受一次性重置全部本地数据、配置和缓存。

## 1. 背景与决策

OpenHarness-ts 尚未进入需要维护外部兼容承诺的阶段，也没有其他用户依赖旧 API、旧配置、旧数据库或旧协议。继续保留兼容门面、历史迁移和双发行删除门禁，会让当前架构同时维护新旧两套入口，增加理解、测试和修改成本。

本轮采用 clean-slate（只保留当前设计）策略：仓库中的当前领域边界、当前 API 和当前数据结构是唯一标准。旧入口直接删除，不经历弃用发行、保留发行或 major 删除窗口。

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
- `DaemonApplication` 只组装当前服务，并向 HTTP routes 暴露当前窄接口。
- 删除旧路由和旧请求/响应 decoder，不做重定向。
- 生产代码不得重新依赖完整 Store、Daemon 或 Runtime 以绕过已经建立的领域边界。

### 5.4 Desktop、Frontend 与 CLI

- 删除为旧调用保留的 service 属性、方法、hook 返回值和 store facade。
- 删除旧 CLI 命令、参数、环境变量别名和输出格式兼容分支。
- 所有调用统一使用当前 Client Resource 和当前 IPC/应用服务入口。
- 删除只验证兼容属性仍存在的测试，保留当前用户流程和状态恢复测试。

### 5.5 配置、协议与数据

- 配置只接受当前字段和当前枚举值，未知字段沿用当前严格校验规则。
- 删除旧字段重命名、默认值补齐、结构转换和兼容读取。
- Client 与 daemon 只接受当前协议版本；版本不一致直接失败。
- 历史数据库 migrations 压缩为一份当前 schema 基线。
- 代码只保证空数据目录可以初始化，不识别旧 schema，也不提供自动迁移或数据修复。
- 实施完成并验证后，由用户明确授权执行一次本机开发数据、配置和缓存重置。代码清理本身不自动删除用户目录。

### 5.6 发布与治理脚本

- 删除 `client-compat-removal-ledger.json`、schema、integrity、removal gate、release helper 及对应测试。
- 删除 Stage 8 A/B/C release phase、双发行证据和授权摘要。
- Tag Release 恢复单一普通稳定发行输入。
- 保留 8B 中已经验证有价值的发布安全顺序：先测试和构建，再创建 tag；npm 校验成功后再创建 GitHub Release。
- 公共 API 检查继续存在，但只校验当前导出面和架构边界。

## 6. 实施顺序

### 6.1 建立审计清单

全仓扫描 deprecated、legacy、compatibility、migration、fallback、旧路由和旧字段。每项记录：当前定义、当前调用者、当前替代入口、删除或保留结论。对于语义不明确的项目，先追踪运行入口再决定，禁止按关键词批量删除。

### 6.2 迁移残余调用者

先把仍使用旧入口的生产调用改到当前边界。新的依赖必须是所需最小能力，不能为了方便新增另一层兼容 facade。每个子域迁移完成后，将旧入口生产调用数降为零。

### 6.3 删除兼容提供者

按以下顺序删除，以缩短不可编译窗口：

1. Client 平铺 API 及其兼容测试。
2. Desktop、Frontend、CLI 的旧属性、命令和适配器。
3. Server 的旧 Application/Engine facade 和旧 HTTP 路由。
4. Services/SessionStore 的领域转发方法和旧类型。
5. 旧配置、旧协议和历史数据迁移。

每批删除后恢复类型检查和对应包测试，再进入下一批。

### 6.4 重建事实源

- 公共 API contract 只列当前入口。
- architecture baseline 只记录当前允许的边界，不再保存“可下降但不可增加”的兼容数量。
- 数据库 schema 以新基线为唯一事实源。
- 文档只描述当前运行路径、入口、状态位置和返回结果。

### 6.5 删除兼容治理

移除 Stage 8 A/B/C 计划和运行时代码的依赖关系，将阶段 8 重新定义为一次 clean-slate 收口。历史设计文档可以保留并标记“已被本设计取代”，避免丢失决策背景；当前状态文档不得继续声称需要双发行门槛。

## 7. 数据重置

数据重置是实施后的独立操作，不嵌入应用启动逻辑，也不由测试脚本隐式执行。

执行前必须：

- 列出将删除的精确绝对路径。
- 确认路径只属于 OpenHarness 开发数据、配置和缓存。
- 停止正在运行的 daemon、CLI、Desktop 和相关后台进程。
- 获得用户对这些精确路径的明确授权。

执行后从空目录启动当前版本，生成新的配置和数据库。旧数据不备份、不迁移；若用户希望保留任何文件，必须在删除前另行提出。

## 8. 测试与验收

### 8.1 静态边界

- 全仓 TypeScript 类型检查通过。
- Client 当前公共 API 与 contract 完全一致。
- 生产代码不存在已删除入口的直接调用、属性引用、解构、索引访问、类型引用或字符串映射。
- Server、Services、Client、Desktop 和 Frontend 的架构依赖规则通过。

### 8.2 反兼容测试

- 代表性旧 Client 方法不能编译。
- 旧 CLI 命令和参数不存在。
- 旧 HTTP 路由返回标准 404。
- 旧配置字段被当前严格校验拒绝。
- 仓库中不存在旧 facade 实现、旧数据转换器和历史 migration runner。

反兼容测试的目的只是防止旧入口被重新加入，不承诺提供迁移体验。

### 8.3 当前行为

- Client、CLI、Desktop、Frontend、Server、Services 的类型检查和测试通过。
- 从空目录完成配置初始化、数据库创建和 daemon 启动。
- 通过当前 Client/CLI 完成至少一次 Session 创建、Prompt 执行、状态读取和退出清理。
- Desktop 能连接新 daemon，并完成当前核心会话流程。

### 8.4 环境例外

已知 Windows/WSL 并发运行可能产生 `node-pty AttachConsole failed` 或 E2E 超时。这类失败必须串行复跑对应文件。只有串行复跑通过且失败与本次改动无关时，才可作为环境例外记录；其他失败必须修复。

## 9. 提交与集成策略

- 使用独立 worktree 和功能分支实施。
- 按审计、调用迁移、Client 删除、应用层删除、存储与配置重置、治理收口拆分提交。
- 不发布中间状态，不创建兼容发行。
- 全部验证完成并审查后再合并 `main`。
- 推送、发布和本机数据删除分别需要明确授权，不能由“实现代码”自动推导。

## 10. 完成标准

- 当前生产代码只存在一套 API、配置、协议和数据结构。
- 118 个 Client 平铺方法及其他纯兼容 facade 全部删除。
- `SessionStore` 和 Application 层不再承担已迁出的领域转发职责。
- 历史 migrations 已压成当前基线，空数据目录可直接初始化。
- Stage 8 A/B/C 发行、ledger 和删除授权机制已删除。
- 可靠性与平台适配测试仍通过。
- 文档、公共契约和架构状态与代码一致。
- 用户授权后完成一次本机开发数据、配置和缓存重置，并验证全新启动。
