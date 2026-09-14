# OpenHarness 按业务域重组长期设计

## 状态

- 日期：2026-09-14
- 范围：整个仓库的长期代码组织；实施从 `packages/services/src/session-runtime` 开始
- 性质：内部架构迁移，不在同一阶段修改产品行为

## 背景

仓库已经出现多处“按技术入口持续聚合”的大文件：

- `packages/services/src/session-runtime/store.ts`：5,157 行；
- `packages/client/src/transport/http-client.ts`：1,714 行；
- `packages/server/src/application/daemon-application.ts`：1,078 行；
- `packages/server/src/application/session/session-application-service.ts`：943 行；
- `packages/server/src/application/session/session-run-engine.ts`：822 行；
- `apps/frontend/src/hooks/useServerSync.ts`：1,252 行。

行数只是表象。核心问题是这些入口同时拥有多个业务域、事务规则、运行状态和适配逻辑。以 `SessionStore` 为例，它同时处理附件、项目、定时任务、会话、工作流、外部渠道、消息、事件、目标、Run、执行任务、权限、迁移、备份、清理和增量落盘。修改一个业务时，维护者必须理解大量不相关代码，测试也逐渐集中成巨型文件。

本设计不以“所有文件必须变小”为目标，而是重新明确：

1. 一项业务规则由谁拥有；
2. 状态存在哪里；
3. 哪些写操作必须共享事务；
4. 请求从入口到结果经过哪些步骤；
5. 哪些接口属于长期公共承诺。

## 设计目标

- 顶层代码按照业务能力组织，例如 session、run、attachment、schedule 和 workflow。
- 业务域内部只在确有需要时区分业务流程、活体运行和持久化。
- 保留一个 SQLite 数据库和可靠的跨表事务。
- HTTP、SSE、SQLite 格式、CLI/Desktop 用户行为和已承诺 SDK/插件接口在迁移期间保持稳定。
- 允许内部 TypeScript API 演进，旧入口通过临时兼容门面逐步退场。
- 每个阶段都能独立合并、测试、发布和回滚。
- 防止 `SessionStore` 退场后出现新的万能 Store、Manager、Service 或 Context。

## 非目标

- 不按行数机械拆文件。
- 不把一个 SQLite 数据库拆成多个业务数据库。
- 不强制每个业务域建立 domain/application/infrastructure/ports/adapters 全套目录。
- 不为单一实现预先创建 repository interface、factory 或 registry。
- 不在目录迁移时同时重做 UI 视觉设计。
- 不一次性推翻所有公共 API。
- 不在缺少测量的情况下重写完整内存 read model。

## 方案选择

### 方案一：只拆大文件

把方法移动到多个文件，但继续由 `SessionStore`、`DaemonApplication` 和 `HttpClient` 提供全部能力。迁移风险最低，却保留了万能对象和错误依赖方向，只能作为短期提取手段。

### 方案二：全面分层

每个业务域强制建立完整的领域层、应用层、仓储接口和适配器。边界形式完整，但会产生大量单实现接口、构造参数和转发代码，维护成本可能高于当前收益。

### 采用方案：业务域优先，复杂域适度分层

顶层按业务能力组织。一个域内部只保留确实存在的职责：

```text
<domain>/
├─ service.ts       # 完成一个业务动作
├─ repository.ts    # 本域 SQLite 读写
├─ records.ts       # 内部输入、记录和行转换
└─ *.test.ts
```

简单域可以只有一个 repository 或 service。跨域一致性操作使用具名 transaction script，不通过一串抽象接口间接完成。

核心原则是：

> 按业务能力划分代码，按事务一致性共享数据库，按外部承诺稳定协议。

## 仓库长期边界

### `packages/protocol`

只保存跨进程、跨包的稳定契约：HTTP 请求响应、SSE 事件、公共 DTO、错误码、协议版本和能力声明。数据库行结构、服务内部状态和业务辅助函数不进入该包。

### `packages/services`

第一阶段保留包名，长期定位为 Node 本地基础设施和持久化实现。它负责 SQLite、文件、本地执行和本地数据服务，不负责 HTTP 或模型运行编排。只有当最终职责稳定后，才评估是否更名为 `storage` 或 `node-services`。

### `packages/server`

负责 daemon 的业务应用流程：接收一个用户动作，协调持久化和活体 runtime，并产生可供传输层返回或发布的结果。Server transport 不拥有业务规则。

### `packages/client`

负责协议协商、HTTP/SSE 传输和按业务资源组织的远程调用。Client 不复制 Server 的业务决策。

### Desktop 与 Frontend

Desktop main 负责 Electron、文件选择、窗口、shell 和 daemon 连接等平台能力。界面代码按用户功能组织，并明确区分 Server 权威状态、本地操作状态、页面状态、草稿状态和连接状态。

## `SessionStore` 目标设计

### 共享数据库内核

建立一个薄的数据库内核：

```text
packages/services/src/database/
├─ session-database.ts
├─ migrations.ts
├─ owner-lease.ts
├─ event-sequence.ts
├─ read-model.ts
├─ mutation-buffer.ts
└─ schema/
```

它只负责：

- 打开和关闭 SQLite；
- WAL、foreign key、busy timeout 等连接配置；
- 迁移与存储格式检查；
- 最外层同步事务；
- application owner 租约；
- 全局事件序号；
- message delta 批量落盘的基础能力。

数据库内核不包含 `createSession()`、`createGoal()` 等业务方法。

### 业务 Repository

Repository 表达“本域数据如何读写 SQLite”，不负责 HTTP、Agent 或 UI。目标职责包括：

```text
sessions/       session、session tree
projects/       project、project location
conversation/   input、message、part、transcript
runs/           run、attempt、session execution
permissions/    permission request
goals/          goal、request、assessment、continuation
attachments/    asset、representation、lease、input reference
events/         durable event、projection settlement
schedules/      scheduled task、scheduled run
workflows/      workflow run、attempt、event、execution claim
channels/       external conversation、delivery
maintenance/    retention、recovery、backup
```

低耦合的小领域允许先合并在一个文件内。文件划分以职责和共同变化为依据，不按表数量机械拆分。

### 跨域 Transaction Script

以下操作涉及多个业务表，必须由具名事务脚本拥有最外层事务：

- prompt 与 run 联合准入；
- transcript 替换；
-最新 prompt 替换和重新准入；
- session fork；
- session tree 删除；
-启动恢复；
- retention 删除与审计。

建议位置：

```text
packages/services/src/transactions/
├─ admit-prompt-with-run.ts
├─ replace-transcript.ts
├─ fork-session.ts
├─ delete-session-tree.ts
├─ recover-runtime-state.ts
└─ apply-retention.ts
```

Repository 提供在当前上下文中执行的基础操作，不自行嵌套新的公开事务。

### 内存 Read Model

第一次迁移保留现有 SQLite 与内存状态的提交、回滚和 delta flush 语义，将其提取为共享组件。Repository 通过同一个 `StorageContext` 使用数据库、read model 和 mutation buffer。

后续再根据测量决定缓存范围：高频 session/run/message/part 可保留索引化 read model；project、schedule、workflow、retention audit 和多数 attachment 数据可评估直接查询 SQLite；event 只保留必要索引，不让无限历史常驻内存。

缓存策略调整不得与职责拆分放在同一迁移步骤。

### 兼容门面

迁移期间保留 `SessionStore`，但旧方法只转发到新的 repository 或 transaction script。新业务代码禁止增加旧平铺入口调用。迁移完成后依次删除无人调用的方法、兼容类和误导性的根导出。

## Server 目标设计

### Application 层

按业务动作组织：

```text
packages/server/src/application/
├─ sessions/
├─ runs/
├─ projects/
├─ goals/
├─ attachments/
├─ schedules/
├─ workflows/
├─ channels/
├─ permissions/
├─ maintenance/
└─ events/
```

只有 session 和 run 等复杂域才进一步拆 query、maintenance 或 control service。

`SessionService` 负责持久会话、transcript、fork、archive、delete 和 snapshot；`RunService` 负责 prompt、queue、steer、replay、retry、interrupt 及 run/attempt 生命周期；`RunControlService` 负责查找并操作活体 Agent/Run handle。持久记录和活体 handle 在命名和位置上必须明确区分。

### Runtime 层

```text
packages/server/src/runtime/
├─ agents/
├─ runs/
├─ projection/
└─ startup/
```

Runtime 负责 Agent 实例、run handle、child handle、session lane、shutdown drain、framework event 投影和运行时恢复。

`SessionRunEngine` 按真实流程拆为：

- `run-admission.ts`：决定 steer、queue、replay 或拒绝，并创建 durable input/run；
- `session-run-lane.ts`：保证同一 session 的 root run 串行；
- `run-executor.ts`：创建或复用 Agent，投递输入并收束结果；
- `session-run-engine.ts`：组合上述能力并保留少量入口。

不引入通用调度框架替代现有明确的 session lane。

### 事件投影

Framework event 到 durable 数据只有一个投影入口。主 projector 负责身份校验、handler 路由、事务、required projection 和 settlement；按 input、run、message/tool、permission、child 等事件家族拆 handler。Handler 不创建独立数据库连接，也不直接发布未提交的 SSE 状态。

### Daemon 组合根

`DaemonApplication` 最终只负责创建和暴露业务服务、等待启动恢复以及按正确顺序关闭资源。依赖组装集中在 composition 目录。它不再亲自实现 session、run、workflow 等业务流程。

### Transport

HTTP/SSE 只负责协议输入解析、调用 application service、结果映射和已知错误转换。Route 不直接访问 SQLite、repository 或 AgentPool，也不自行组合多步事务。

## Client 目标设计

保留统一 Client 使用体验，内部改为业务资源：

```text
packages/client/src/
├─ openharness-client.ts
├─ transport/
│  ├─ http-transport.ts
│  ├─ sse-transport.ts
│  ├─ protocol-negotiation.ts
│  └─ errors.ts
└─ resources/
   ├─ sessions.ts
   ├─ runs.ts
   ├─ projects.ts
   ├─ attachments.ts
   ├─ schedules.ts
   ├─ workflows.ts
   ├─ channels.ts
   ├─ jobs.ts
   ├─ settings.ts
   └─ debug.ts
```

目标调用形式为 `client.sessions.create()`、`client.runs.interrupt()`。旧平铺方法在过渡期只做转发，经过 deprecated 周期后再决定是否在主版本中删除。

Transport 只知道通用请求、流、鉴权、协议协商和错误转换，不实现具体业务 endpoint。

## Desktop 与 Frontend 目标设计

### Desktop Main

按 platform、daemon、features 和 ipc 组织。纯远程代理直接调用 Client resource；只有确实需要 Electron 平台能力的流程才保留 Desktop application service。Server 已有的 run admission、queue 或状态机规则不得在 Desktop 重复实现。

### Renderer 和 Web

界面按 feature 组织，例如 conversation、session-list、projects、attachments、schedules、settings 和 plugins。每个 feature 可以拥有自己的 state、actions、selectors、components 和测试。

conversation workspace 可以继续使用一个共享状态容器，因为 active session、primary SSE 和 pending prompt 需要原子对账；settings、plugins 和 schedules 等独立域可以拥有独立状态入口。

状态必须归入以下一种：

- Server 权威状态；
- 本地操作状态；
- 页面状态；
- 草稿状态；
-连接状态。

SSE 拆为连接、cursor、event router 和业务 event handler。Handler 调用 feature 的公开 action，不直接修改多个 store 的内部字段。UI 组件通过语义 selector 消费状态，不自行判断 active run、queue、cursor 或 optimistic reconciliation。

Desktop 与 Web 可以共享协议、Client resource 和无状态对账规则，但不共享 Electron IPC、React hook、路由生命周期或平台状态容器。只有第二个真实调用方出现后才提取新的共享包。

## 依赖方向

```text
protocol
   ↑
services/storage        agent-runtime
   ↑                         ↑
   └──── server/runtime ─────┘
                ↑
       server/application
                ↑
       server/transport
                ↑
       client / desktop / cli
```

更具体的约束：

- protocol 不依赖 server、services、client 或 UI；
- services 不依赖 server、client 或 UI；
- agent-runtime 不依赖 server/daemon；
- repository 不依赖 application；
- application 不依赖 transport；
- transport 只能通过 application 执行业务；
- UI 不直接访问 Server repository 或实现 Server 状态机。

共享上下文按业务需要保持窄小，只有存在多个实现或测试替换价值时才提取接口。

## 不可破坏的不变量

- prompt 与对应 run 的创建必须在同一事务；
- session fork 的 session、历史、input、message 和 part 一起成功或失败；
- session tree 删除与附件引用保持一致；
- retention 删除和 retention audit 在同一事务；
- owner fence 覆盖所有持久化写入；
- durable event sequence 跨重启单调且不复用；
- terminal run 不留下活动 attempt；
- text delta 可以延迟 checkpoint，但 terminal 和 close 前完整刷盘；
- transaction 失败后不暴露未提交的内存状态；
- session task 状态变化不丢失等待者唤醒；
- required projection 在对应成功结果结算前完成；
- SSE 只发布已提交或明确标为 transient 的状态；
-迁移期间 HTTP/SSE 协议、数据库格式和用户行为保持兼容。

## 分阶段迁移

### 阶段 0：边界护栏

- 记录 package 依赖和大文件职责；
- 固定 session/run/permission/attachment/schedule/workflow/recovery 等关键特征测试；
- 增加依赖方向、循环依赖和退场 API 的增量检查；
- 禁止继续扩大万能入口。

完成标准：无行为变化，职责地图和约束进入仓库，新代码不能增加旧入口调用。

### 阶段 1：共享数据库内核

- 提取连接、迁移、格式检查、owner lease、event sequence、read model、mutation buffer 和 delta flush 基础能力；
- 保持同一数据库、schema、migration、缓存和回滚语义；
- `SessionStore` 继续提供旧 API。

完成标准：数据库生命周期可独立测试，Store 不再直接管理初始化细节。

### 阶段 2：低耦合存储域

依次提取 project、schedule、workflow、channel、goal、attachment 和 permission。每个域先迁测试和 repository，再让旧方法转发，并迁移一组 Server 调用方。

完成标准：领域拥有清晰入口，测试跟随领域，旧调用基线只减不增。

### 阶段 3：Session、Conversation 和 Run 主链路

顺序固定为：只读查询、单实体写、跨域 transaction script、增量输出。增量输出不与普通 CRUD 放在同一个变更中。

完成标准：`SessionStore` 只剩组合、兼容转发和 close；失败注入证明 SQLite 与 read model 不会半提交。

### 阶段 4：Server Application 与 Runtime

先迁简单业务服务，再迁 session query/session service、run control、run admission、session lane、run executor、事件投影、恢复与维护，最后收缩 `DaemonApplication`。

完成标准：route 不直接访问 store/repository；durable record 与 live handle 分离；DaemonApplication 只做组合和生命周期。

### 阶段 5：Client 与传输

提取通用 transport、协议协商和错误转换，再按业务增加 resources。旧平铺方法只转发，内部调用逐步迁移。

完成标准：transport 不拥有 endpoint 业务；resource 可独立测试；兼容方法没有独立规则。

### 阶段 6：Desktop 与 Frontend

先分类状态，再提取 SSE connection/cursor/router 和纯对账规则，然后按 feature 迁 renderer，拆 Desktop main service，最后移动 UI 目录。该阶段不同时做视觉改版。

完成标准：一个事件只有一个对账入口；UI 只消费 selector；Desktop 不复制 Server 业务规则。

### 阶段 7：公共 API 收口

将导出分为长期公共契约、误导性内部导出和已无调用的兼容入口。需要 breaking change 时集中到明确版本，并提供迁移说明和 deprecated 周期。

### 阶段 8：删除兼容层

删除旧 Store/Client 平铺方法、旧目录 re-export 和无调用类型；更新架构文档和目录 README；启用完整依赖限制。

完成标准：业务流程能够按目录从 transport 追踪到 application、runtime/storage，再从 SSE 追踪到 UI，不需要经过万能入口。

## 每阶段交付规则

每个迁移变更遵循：

1. 先迁移或补充行为测试；
2. 提取新模块；
3. 让旧入口转发；
4. 迁移一组调用方；
5. 运行该域测试、类型检查和必要的集成测试；
6. 不夹带产品功能变化；
7. 文件移动和逻辑修改尽量分开；
8. 每个变更可以单独回滚。

主分支始终可构建、测试和发布，不建立持续数月的重构分支。

## 新代码归属规则

新增代码前依次回答：

1. 它属于哪项业务能力？
2. 它是业务流程、活体运行、持久化还是传输适配？
3. 哪个模块拥有相关状态？
4. 是否需要与其他数据共享事务？
5. 是否已有唯一规则所有者？

归属参考：

| 实际职责 | 位置 |
|---|---|
| HTTP、SSE、IPC 格式转换 | transport |
| 完成一个业务动作 | application/domain |
| Agent、Run handle 生命周期 | runtime |
| SQLite 读写 | repository |
| 跨表一致性操作 | transactions |
| 跨进程稳定类型 | protocol |
| Client 请求映射 | client/resources |
| 页面交互和局部状态 | features/domain |
| 多个业务确实共用的无状态逻辑 | 最窄的共享位置 |

无法说明状态所有者的代码不得进入新的共享模块。

## 自动化治理

- 首先用现有 ESLint `no-restricted-imports` 表达包和目录依赖；规则确实超出能力时再引入新工具；
- 为旧 `context.store.*` 和 Client 平铺方法建立只减不增的调用基线；
- CI 检查 package 级循环依赖，文件级循环先覆盖正在迁移的目录；
- 报告增长最快的生产文件，不设置简单行数硬门槛；
- 禁止新增通用 `utils.ts` 接纳无明确归属的业务逻辑。

## 测试所有权

- Repository：SQL 映射、约束和事务回滚；
- Application：业务流程和错误语义；
- Runtime：并发、排队、中断和恢复；
- Transport：协议映射；
- Client：请求构造和响应解析；
- UI state：本地操作与权威状态对账；
- E2E：少量关键用户路径。

同一规则不在每层完整重复测试。紧耦合旧 Store 私有实现的测试改为验证公开结果和提交后的持久状态。

## 风险控制

### 事务被拆散

通过具名 transaction script、最外层事务所有权和 failure injection 测试控制。

### 新旧入口产生两套规则

兼容入口只允许转发，并用退场 API 基线禁止新增调用。

### Read Model 与 SQLite 不一致

第一阶段保持现有提交和回滚语义，缓存调整单独进行。

### 目录移动形成巨大 Diff

一次迁移一个业务域，先提取、再迁调用、最后清理旧位置。

### 迁移长期无法结束

每阶段记录旧入口剩余调用数。没有实际减少兼容入口的阶段不算完成。

### 过度分层

不强制目录模板。每个新增层必须拥有真实规则、状态或多实现价值。

### 主分支冲突

使用小而垂直的迁移变更。新功能优先落在新边界，旧位置只接受必要修复。

## 整体验收指标

- `SessionStore` 从 5,157 行降为约 300 行以内的临时兼容入口，最终删除；
- `http-client.ts` 退化为 transport 或兼容入口，业务 endpoint 进入 resources；
- `DaemonApplication` 只包含组合、启动、关闭和服务暴露；
- Server route 直接访问 store/repository 的数量归零；
- 新增旧 `SessionStore` 平铺调用数量始终为零；
- 退场入口调用数按阶段下降到零；
- 每个业务域拥有独立测试入口；
- 跨域事务都有具名实现和失败回滚测试；
- package 依赖无反向引用和循环；
- 关键用户行为、协议版本和数据库格式保持稳定；
- 每个阶段结束时主分支均可构建、测试和发布。

## 推荐优先顺序

1. `packages/services/src/session-runtime/store.ts`；
2. `packages/server/src/application/daemon-application.ts`；
3. `packages/server/src/application/session/session-application-service.ts`；
4. `packages/server/src/application/session/session-run-engine.ts`；
5. `packages/client/src/transport/http-client.ts`；
6. `apps/frontend/src/hooks/useServerSync.ts`。

大型测试文件、单一职责算法文件和单纯 JSX 较长的组件不因为行数自动获得更高优先级。

## 最终运行流程示例

以“取消排队消息”为例，完成迁移后应能沿一条清晰路径理解：

```text
HTTP route
  → RunService
  → RunControl / admission rule
  → RunRepository 或 transaction script
  → durable event
  → SSE
  → conversation event handler
  → selector
  → queue component
```

每一层只回答一个问题；入口、关键步骤、状态位置和结果返回路径均可直接找到。
