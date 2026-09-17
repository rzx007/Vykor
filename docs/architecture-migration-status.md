# 架构重构收口与当前边界

> 状态：当前收口记录。2026-09-17 核对 Stage 0–8 已全部完成；本文报告最终结果，不再作为迁移看板。

## 如何使用本文

本文回答三件事：这次按业务域重组最终完成了什么、当前代码边界是什么、以后靠哪些自动化检查防止退回万能入口。系统怎样运行仍以 [架构总览](./architecture-overview.md)、[Daemon Application Architecture](./daemon-application-architecture.md)、[Client Sync Flow](./client-sync-flow.md) 和 [Session Runtime 存储架构](./session-runtime-storage-architecture.md) 为准。

实施期间的规格和计划保留在 `docs/superpowers/`，只用于追溯当时的决策与迁移顺序。它们与当前代码冲突时，以当前代码、测试和本文链接的权威文档为准。

## Stage 0–8 完成矩阵

| 阶段 | 目标 | 最终结果 | 主要证据入口 |
| --- | --- | --- | --- |
| 0 边界护栏 | 固定依赖方向和不可破坏行为 | 架构边界、Client API、兼容面和文档入口都有可执行检查 | `scripts/architecture-boundaries.mjs`、`scripts/client-public-api-contract.json`、[契约与测试索引](./contract-test-index.md) |
| 1 数据库内核 | 把 SQLite 生命周期从业务 Store 中提取 | 连接、migration、owner lease、event sequence、read model、mutation buffer、delta checkpoint 和事务协调进入 `packages/services/src/database` | `packages/services/src/database`、`packages/services/src/session-runtime/migrations` |
| 2 低耦合存储域 | 让 Project、Schedule、Workflow、Channel、Goal、Permission、Attachment 拥有数据 | 各域已有 Repository 或 Transaction 入口，`SessionStore` 只负责组合它们 | `packages/services/src/projects`、`schedules`、`workflows`、`channels`、`goals`、`permissions`、`attachments` |
| 3 Session 主链路 | 拆出 Session、Conversation、Run 和跨域事务 | 查询、单实体写、prompt/run 准入、fork/delete/replace 等事务和增量输出分别有明确所有者 | `packages/services/src/sessions`、`conversations`、`runs` |
| 4 Server Application / Runtime | 把 route、业务编排和 live execution 分开 | route 依赖窄应用服务；`SessionOperationRunner` 统一处理 session 串行、ready、owner lease 与事件提交；AgentPool/Runtime 只管理活体执行 | `packages/server/src/application/session`、`packages/server/src/application/agent`、`packages/server/src/http/routes` |
| 5 Client / Transport | 把通用网络能力与 endpoint 映射分开 | HTTP/SSE transport、协议协商、领域 Resources、state reducer 和 commands 分目录维护 | `packages/client/src/transport`、`protocol`、`resources`、`state`、`commands` |
| 6 Desktop / Frontend | 明确服务端权威状态与本地界面状态 | Frontend 通过共享 Client snapshot/SSE 收敛；Desktop Main 只保留 Electron、窗口、文件系统、daemon 连接和 IPC 等平台职责 | `apps/frontend/src`、`apps/desktop/src/main` |
| 7 公共 API 收口 | 只保留长期公共契约 | Client 公开面由 contract 文件锁定；CLI、Desktop 和 Frontend 使用领域 Resource，不依赖内部 transport 或临时 facade | `scripts/client-public-api-contract.json`、`packages/client/src/__test__/public-api.test.ts` |
| 8 Clean-slate 删除 | 删除兼容入口和旧数据路径 | 顶层 Client 业务转发、Store/Application 纯转发、旧字段/目录/scope/shell 回退已经删除；协议提升为 4，migration 压为单一当前基线 | `scripts/verify-clean-slate.mjs`、[Compatibility surface 实施审计](./compatibility-surface-audit.md) |

原始长期设计见 [按业务域重组长期设计](./superpowers/specs/2026-09-14-business-domain-codebase-reorganization-design.md)。Stage 8 最终采用不保留兼容层的 [clean-slate 设计](./superpowers/specs/2026-09-16-clean-slate-compatibility-removal-design.md) 和 [实施计划](./superpowers/plans/2026-09-16-clean-slate-compatibility-removal.md)。

## 当前四层边界

### Client

- `OpenHarnessClient` 暴露 `client.protocol` 和各领域 Resource；业务调用进入 `client.sessions`、`client.projects`、`client.permissions` 等资源。
- transport 只负责 HTTP、SSE、鉴权、协议 header 和错误转换，不拥有 endpoint 业务规则。
- snapshot 是某一时刻的完整基线，SSE 从 checkpoint 之后补增量，state reducer 负责去重与合并。
- 顶层业务转发方法和底层 transport 公共属性已经删除。

### Server Application

- HTTP route 解析协议输入并调用 Query、Command、Interaction、Run Control 等窄应用服务；route 不直接实现跨表业务流程。
- `SessionOperationRunner` 在进入持久操作前等待 ready、验证 owner lease，并保证同一 session 的操作顺序；提交成功后才 checkpoint/publish 事件。
- `DaemonApplication` 是组合根和生命周期入口，不是所有业务动作的实现类。
- AgentPool、live run handle 和 child handle 属于活体 Runtime；Session、Run、Permission、Workflow 等长期状态属于持久应用。

### Services / Storage

- Repository 拥有单个业务域的读取和写入，Transaction 拥有必须一起成功或失败的跨域写入。
- `SessionStore` 打开数据库、装配 Repository/Transaction、管理 owner lease、waiter/listener、启动恢复和维护入口；它不再提供平铺业务 facade。
- 所有 Repository 共用一个 `StorageContext` 和最外层事务协调器，因此 SQLite、read model、mutation buffer 和 durable event 不会半提交。

### Desktop / Frontend

- Renderer 不读取数据库，也不维护第二套 Session/Run/Permission 真相；持久状态来自 Client snapshot 与 SSE。
- Frontend 只在本地保存界面状态、草稿、连接状态和未完成操作的展示信息。
- Desktop Main 负责 Electron 平台能力和 IPC，不复制 Server 的 run admission、queue 或恢复规则。

## 当前协议与数据基线

- HTTP 协议版本是 `4`，请求头是 `x-openharness-protocol-version`。
- `/health` 和 `/capabilities` 是握手例外。Client 在首个业务请求前读取 capabilities；Server 在业务 handler 前拒绝缺失或不等于 4 的版本。
- SQLite 只有 `packages/services/src/session-runtime/migrations/0000_current_schema.sql` 一份当前 schema，journal 只有一条记录。
- 启动只支持空目录建库和当前 schema 的幂等二次打开，不读取、猜测或转换旧数据库。
- Native Plugin 只接受严格 v1 manifest，安装 scope 只有 `user` 与 `managed`；外部格式先通过 `@openharness/plugin-converters` 显式转换。
- 项目 Skill 目录只有 `.agents/skills` 与 `.openharness-ts/skills`；用户 Skill 默认位于 `~/.openharness-ts/skills`。

## 已删除的兼容面

以下内容不是隐藏能力，也不应在新代码或文档中重新出现：

- `OpenHarnessClient` 顶层 session/project/job 等业务方法；
- 对外暴露的底层 Client transport；
- `SessionStore` 和 Application 层只做一跳转发的平铺业务方法；
- 旧 Client 字段名、旧插件 scope/manifest、旧 Skill 目录和旧 shell fallback；
- 旧数据库 migration 链、旧 schema 自动读取与运行时升级；
- 为“至少保留一轮发行”准备的多次发布、deprecated 周期和删除授权流程。

OpenAI-compatible Provider、外部插件导入、平台 shell 选择、可靠重试、取消、事务回滚和崩溃恢复仍是当前产品能力。它们解决真实运行问题，不属于兼容层。

## 长期门禁

| 命令 | 守护内容 |
| --- | --- |
| `pnpm check:architecture` | Client contract、禁止兼容面、包/模块依赖和 clean-slate 聚合检查 |
| `pnpm check:clean-slate` | Client 公开导出、协议版本/header、单 migration/journal、发布顺序和 bundle inventory |
| `pnpm test:clean-slate` | 空环境 smoke、安全清理、失败清理和 verifier 失败 fixture |
| `pnpm check-docs` | 文档状态、必备入口、本地链接、源码路径和契约测试映射 |

新增功能时按以下顺序判断位置：

1. 业务请求映射进入 Client Resource；
2. 一个用户动作的编排进入 Server Application Service；
3. live Agent/Run handle 的控制进入 Runtime；
4. 单域持久化进入 Repository；
5. 跨域原子写入进入具名 Transaction；
6. HTTP、SSE、IPC 只做格式转换和调用转接。

无法说明状态由谁拥有的逻辑，不应进入新的共享 Store、Manager、Service 或 Context。

## 开发数据重置是独立操作

代码收口完成不等于本机数据已经删除。开发数据库、插件、Skill、凭据或其他本机数据只能按 [开发数据重置手册](./development-data-reset.md) 逐项预检、停进程、解析最终路径并获得授权后处理。

重构完成本身不构成删除真实数据的授权；是否重置数据也不影响 Stage 0–8 的代码完成状态。
