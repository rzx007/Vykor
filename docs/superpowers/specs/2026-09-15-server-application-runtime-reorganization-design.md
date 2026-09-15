# Server Application 与 Runtime 重组设计

> 状态：设计已确认，等待书面规格审阅。
>
> 本文是业务代码重组阶段 4 的总体规格。阶段 4 只调整 Server 内部所有权和依赖，不改变 HTTP、SSE、IPC、数据库格式、DaemonApplication 对外能力或用户行为。

## 1. 背景

阶段 0–3 已完成 Services 持久化边界重组。SessionStore 已不再拥有 Session、Conversation、Run 的领域读写、跨域业务事务和增量输出 SQL，但 Server 内部仍存在第二层集中化问题：

- packages/server/src/application/daemon-application.ts 约 1119 行，同时负责对象装配、启动恢复、运行时回调、Scheduled Task 执行和关闭；
- session-application-service.ts 约 989 行，同时处理 Session CRUD、Prompt、edit、fork、resume、queue 和部分 Run 控制；
- session-run-engine.ts 约 873 行，同时处理 admission、排队、steer、replay、执行协调和终态处理；
- 多个 Service 接收完整 SessionStore 或宽大的 context，能够访问远超职责所需的状态；
- durable record（SQLite 中可恢复的记录）和 live handle（只在当前进程有效的 Promise、AbortController、Agent、进程句柄）仍通过同一个 context 混用；
- HTTP route 虽已有命名 Application 入口，但缺少自动护栏阻止重新直连 Store/Repository。

阶段 4 要解决的是 Server 内部业务流程和活体运行的所有权，不再继续拆 Services 数据层。

## 2. 目标

阶段 4 完成后：

1. HTTP route 只调用 DurableAgentApplication 上的命名服务，不直接访问 Store 或 Repository。
2. Session Query、Session Command、Run Admission、Run Control、Run Executor、Projection、Recovery、Maintenance 各有唯一规则所有者。
3. Application Service 只拿完成业务动作所需的窄 capability，不拿万能 Store。
4. durable record 与 live handle 分离：持久记录由 Services 拥有，当前进程运行句柄由 Runtime 拥有。
5. DaemonApplication 只负责对象组合、启动、ready、close 和兼容公开属性。
6. 旧 SessionApplicationService、SessionRunEngine 和 DaemonApplication 对外能力在阶段 4 保留，通过转发维持兼容。
7. HTTP/SSE/IPC、数据库格式、错误 code、状态码、用户文案和运行行为保持不变。
8. 架构检查能阻止 Route 新增 Store/Repository 直连，以及新 Service 重新扩大依赖。

## 3. 不在本阶段处理

- 不改变 Client、Desktop、Frontend；它们属于阶段 5–6。
- 不删除公共兼容入口；最终删除属于阶段 8。
- 不修改数据库 schema、migration、storage format 或 Repository 事务。
- 不引入 Command Bus、事件总线、依赖注入框架或 Service Locator。
- 不把所有动作统一包装成命令对象；只有已有输入结构需要复用时才保留 command 类型。
- 不重新设计 queue/steer/replay/resume 产品语义。
- 不改变 Agent provider、模型选择、插件、技能或 Permission 产品规则。
- 不处理已知 WSL/node-pty 全仓并发环境竞争。
- 不借机做 UI 改版、协议重命名或无关文件移动。

## 4. 核心原则

### 4.1 先收窄依赖，再移动逻辑

先让现有类只依赖实际使用的方法。只有当测试证明窄接口足够，才把规则迁到新所有者。禁止先复制一份实现再逐步清理旧实现。

### 4.2 Application 与 Runtime 分工

Application 完成一个用户或系统业务动作，例如“编辑最后一个 Prompt”或“中断 Run”。Runtime 管理当前进程里正在运行的资源，例如 Agent、队列、AbortController 和子进程。

Application 可以调用 Runtime 和持久化 capability；Runtime 可以报告生命周期变化给 Application/Projection。二者都不能绕过 Services 的事务边界自行修改 SQLite。

### 4.3 Durable 与 Live 分离

Durable record 可以关闭进程后重新读取，包括 Session、Input、Run、Attempt、Task、Event。Live handle 只对当前进程有效，包括运行 Promise、abort handle、Agent 实例、child registry entry 和 operation lease。

Runtime map 只保存 live handle 和 durable id，不复制完整 durable record。需要最新状态时通过窄查询 capability 读取。

### 4.4 兼容门面只转发

旧 SessionApplicationService 和 SessionRunEngine 暂时保留。一个动作迁出后，旧方法只能做输入兼容、调用新服务、原样返回；不得保留第二套业务判断。

### 4.5 最小抽象

只创建当前真实需要的 Service/Runtime 单元。不建立 BaseService、通用 command dispatcher、泛型 capability 工厂或为未来多进程模式预留接口。

## 5. 当前状态所有者

| 状态 | 当前/目标所有者 | 说明 |
|---|---|---|
| Session/Input/Message/Part/Run/Attempt/Task/Event | Services Repository/Transaction | 跨重启稳定 |
| Agent 实例和 warm session | AgentPool | 当前进程有效 |
| Session 排队、active run、interrupt handle | SessionRunCoordinator/Session Lane | 当前进程有效 |
| Child Agent live entry | LiveChildAgentDirectory | 当前进程有效 |
| Maintenance operation lease | DaemonOperationGate | 当前进程有效 |
| Transcript 投影的持久结果 | Services Conversation/Run capability | Projection 不拥有副本 |
| SSE subscriber | ApplicationEventService/Publisher | 当前连接有效 |
| startup recovery Promise | StartupRecoveryService + Daemon lifecycle | ready 前完成 |
| owner heartbeat | Daemon lifecycle | 组合根持有 timer |

## 6. 目标目录

packages/server/src/application 下保持按业务职责组织：

- session/session-query-service.ts：只读查询。
- session/session-command-service.ts：Session create/update/archive/fork。
- session/run-admission-service.ts：Prompt admission、queue/steer、replay/resume。
- session/run-control-service.ts：interrupt/cancel/promote/await。
- session/session-run-executor.ts：执行一个已 admission 的 Run。
- session/transcript-projection.ts：Agent 输出到 Message/Part。
- session/session-execution-projector.ts：live execution 到 durable Task。
- recovery/startup-recovery-service.ts：启动恢复总入口。
- session/session-maintenance-service.ts：compact/archive 等用户维护。
- session/session-post-run-maintenance.ts：Run 完成后的 memory 等收尾。
- daemon-assembly/ 或 daemon-application-assembly.ts：仅当 Daemon 构造仍过长时提取装配函数。

packages/server/src/runtime 保留真正 live 的能力：

- run-coordinator.ts；
- session lane/queue（从 Run Engine 迁出后按真实边界命名）；
- session-execution-environment.ts；
- 不新增与已有 AgentPool、LiveChildAgentDirectory 重复的 registry。

具体文件名可在实施计划根据现有目录模式收敛，但职责和依赖方向不得改变。

## 7. 阶段 4A：简单 Application Service 收口

处理已有且相对独立的 Project、Attachment、Channel、Retention、Event、Terminal、Job、Schedule 和 default services。

每个服务建立最窄 context/capability：

- Event 只依赖 listEvents、latestEventSeq 和订阅所需能力；
- Retention 只依赖 applyRetention/listRetentionAudits；
- Project 只依赖 store.projects 的实际方法；
- Attachment 使用 AttachmentApplicationService/Resources，不回退完整 Store；
- Channel 只依赖 channel persistence 与确实需要的 Session/Input 查询；
- Schedule/Job 保留调度和执行策略在 Server，但持久化只用 Schedule/Task capability；
- Terminal 只获取 Session cwd、Task 和 live terminal 能力；
- default services 按 settings/auth/plugins/skills 等职责收窄。

4A 不新建同名替代服务，只收窄构造依赖、迁移调用方和补架构护栏。

完成条件：简单服务测试通过，生产代码不新增完整 Store context，行为无变化。

## 8. 阶段 4B：Session Query 与 Command

### SessionQueryService

拥有：

- list/get Session；
- get SessionState/Snapshot；
- transcript、Run、Task 的只读组合；
- title、过滤、分页等只读展示规则。

不拥有 archive、fork、Prompt、queue、Agent handle 或 SSE 发布。

### SessionCommandService

拥有：

- create/update/archive/begin archive；
- fork Session；
- Session metadata/title 修改；
- 调用 Maintenance/Run Control 完成需要协调的 archive。

不拥有 Prompt admission、Run 执行、查询聚合或 live queue。

旧 SessionApplicationService 保留为兼容门面。迁出的 query/command 方法改为转发；尚未迁出的 Run 相关方法在 4C 前保持原样。

完成条件：查询和 Session 命令可单独测试，Route 通过命名服务调用，旧门面无重复规则。

## 9. 阶段 4C：Run Admission 与 Control

### RunAdmissionService

拥有：

- 普通 Prompt admission；
- queue 与 steer 选择；
- replay/resume admission；
- edit 后 admission；
- owning Run 创建与幂等恢复；
- plugin/skill 输入物化的调用顺序。

不拥有 Agent 执行、live queue 实现、终态投影或 HTTP 解析。

### RunControlService

拥有：

- interrupt/cancel；
- cancel queued Prompt；
- promote queued Prompt；
- await Run；
- 获取 durable Run 与 live handle 的协调结果；
- 对用户请求优先级和目标有效性做现有判断。

不拥有模型执行或 transcript 投影。

SessionRunEngine 暂时作为兼容门面。一个方法迁出后必须删除原规则并转发。

完成条件：admission 与 control 分开测试；同一 input 的 owning Run、queue/steer、interrupt 和 resume 行为保持兼容。

## 10. 阶段 4D：Session Lane 与 Run Executor

Session Lane 指一个 Session 内对 Run 进行排队、选择下一个工作、处理中断的 live 运行单元。优先复用 SessionRunCoordinator；只有现有 coordinator 无法表达真实职责时才提取更窄类。

规则：

- 一个 Session 同时只有现有协议允许的 active work；
- lane 只保存 runId/inputId 和 live handle，不复制 SessionRunRecord；
- durable 状态更新通过 Run capability；
- enqueue、dequeue、interrupt 和 shutdown 的竞态由 Runtime 测试覆盖；
- daemon restart 不恢复旧 live handle，只由 Startup Recovery 终态化 durable record。

SessionRunExecutor 只执行一次已经 admission 的 Run：

1. 读取 Session/Input/Run；
2. 获取 Agent；
3. 建立 attempt；
4. 将 Agent event 交给 Projection；
5. 在事务中完成 attempt/run；
6. 触发 post-run maintenance；
7. 返回执行结果。

它不决定 queue/steer，不创建 Session，不解析 HTTP，不直接管理全局 shutdown。

完成条件：lane/runtime 并发测试覆盖排队、中断、shutdown 和 stale handle；Executor 单次执行测试保持通过。

## 11. 阶段 4E：Projection、Recovery、Maintenance

### Projection

TranscriptProjection 是 Agent 输出到 Message/Part 的唯一规则所有者。ExecutionProjector 是 child agent/process 到 Session Task 的唯一规则所有者。DaemonAgentEventProjector 中与这两者重复的规则应收敛到相应投影，而不是再建第三套 mapper。

Event Publisher 只发布已提交 durable event 或明确 transient event。Projection 不能直接操作 SSE subscriber。

### StartupRecoveryService

按现有顺序统一执行：

- pending Permission 过期；
- active Task/Run/Attempt 终态化；
- orphan Input 终态化；
- closing Session 收尾；
- Workflow recovery；
- Projection Settlement recovery；
- Background shell/child live 状态清理；
- 其他当前 Daemon 构造中的恢复步骤。

run() 失败必须让 Daemon ready() 失败。不得 catch 后只记日志继续 ready。

### Maintenance

SessionMaintenanceService 拥有显式 compact/archive 等命令。SessionPostRunMaintenance 只处理一次 Run 完成后的 memory/dream 等后置动作。Retention 属应用维护但不混入 Session compact。

完成条件：恢复顺序、幂等、失败传播、投影结算和关闭前状态都有真实测试。

## 12. 阶段 4F：收缩 DaemonApplication

DaemonApplication 最终只做：

1. 接收 options；
2. 构造 durable capabilities；
3. 构造 Application Services；
4. 构造 Runtime；
5. 绑定少量回调；
6. 执行 StartupRecoveryService；
7. 暴露兼容属性；
8. ready 和 close。

应迁出的构造内长逻辑包括：

- Scheduled Task 的完整执行函数；
- Agent 输入物化和插件/技能发现流程；
- context usage live assembler；
- attachment tool 装配细节；
- recovery 具体步骤；
- projection 的业务回调。

如果只是多行对象构造，可提取纯 assembly function；不要为每个 new 建 builder class。

close 顺序保持：

- 阻止新操作；
- 等待或中断 live work；
- 停止 schedule/background shell/terminal/agent；
- 完成 projection/recovery 必要结算；
- 释放 heartbeat 和 owner lease；
- 按 ownsStore 决定是否关闭 Store；
- 聚合多个关闭错误，不能遇到第一个就跳过后续释放。

完成条件：DaemonApplication 只含组合和生命周期；其公开接口与错误语义保持兼容。

## 13. 调用方向

允许：

HTTP Route → DurableAgentApplication 命名服务 → Application Service → Runtime 或 Services capability。

禁止：

- HTTP Route → SessionStore；
- HTTP Route → Services Repository；
- Repository → Server Application/Runtime；
- Runtime → HTTP Route；
- Projection → SSE subscriber；
- Application Service → DaemonApplication；
- 新 Service 通过 any 或完整 Store 绕过窄接口。

Route 可以读取 application.sessions/queries/control/events 等公开服务，但不能知道持久化实现。

## 14. 错误和可见性

- 现有 ApplicationError code、HTTP status 和消息不变。
- Store/Repository 错误的映射位置保持唯一，不能在多个 Route 重复转换。
- admission 失败不留下 Input/Run。
- interrupt 返回前 durable Run/Attempt/Part 已提交。
- Task listener 和 SSE durable event 只在 commit 后可见。
- transient event 明确标记，不进入 durable history。
- recovery 失败阻止 ready。
- close 聚合错误，同时保证所有可释放资源都尝试释放。
- compatibility facade 不捕获并改写未知错误。

## 15. 测试策略

### Characterization

迁移前先固定现有调用顺序、返回值、错误和副作用。新增 characterization test 必须先在旧实现通过。

### Application

每个新 Service 直接测试成功、幂等、业务拒绝、依赖失败、错误映射和提交后事件；不只测试旧门面。

### Runtime

使用可控 Promise/AbortSignal 测试 enqueue、并行请求、interrupt、shutdown、stale completion 和 restart 后无 live handle。

### Projection

输入真实 Agent event，断言 durable Message/Part/Task/Event。失败注入验证 projection settlement 和 retry，不只断言 mock 调用次数。

### Recovery

真实 SQLite 构造 active/orphan/closing 状态，运行 recovery 后 reopen；重复运行结果相同。任一步失败时 ready 拒绝。

### Transport compatibility

现有 HTTP/SSE 测试继续通过，Route 不新增 Store/Repository import。

### 每波次验证

- 对应 Server 定向测试；
- Server 全量测试和 check-types；
- Services 回归测试；
- architecture checker 及自身测试；
- docs checker；
- git diff --check；
- 必要时全仓 test，已知 WSL/node-pty 并发问题单独记录。

## 16. 架构护栏

新增或加强：

- packages/server/src/http/routes 不得 import SessionStore 或 services Repository；
- application service 不得 import DaemonApplication；
- runtime 不得 import HTTP route；
- 新建 service context 中禁止 store: SessionStore；兼容旧类按只减不增基线治理；
- context.store.* 生产调用建立只减不增基线；
- DaemonApplication 行数和构造内业务 callback 数记录趋势，不设简单硬上限；
- 禁止使用 any 绕过 capability；测试 fixture 的 any 不计入生产规则。

基线更新只能使用脚本根据真实下降重写，不得调高上限。

## 17. 多人分派

顺序固定：

4A → 4B → 4C → 4D → 4E → 4F。

每波次从最新 main 建独立 worktree。4A 内不同简单服务可以并行分析，但共享 context、DaemonApplication 和公共 index 由一个集成人修改。4B–4F 都会触及 Session 主链路，生产接线必须串行合入。

每个执行者提交：

- 起始 main commit；
- commit 列表；
- 方法迁移表；
- 新旧所有权说明；
- 实际测试命令、退出码和数量；
- architecture baseline 变化；
- DaemonApplication/SessionApplicationService/RunEngine 行数变化；
- 已知失败及是否可单独复现；
- 未提前实施下一波次的声明。

## 18. 审核规则

每个任务两轮审核：

1. 规格审核：完整性、边界、兼容、越界；
2. 质量审核：竞态、错误、测试、依赖、可维护性。

Critical/Important 必须修复并复审。重点检查：

- 旧实现是否删除而非复制；
- capability 是否真的窄；
- durable 与 live 是否又混进同一对象；
- 事件/通知是否在 commit 前可见；
- Route 是否绕过 Application；
- Runtime 是否复制 durable record；
- recovery 是否吞错；
- close 是否漏资源；
- 基线是否人为调高；
- 是否创建只为结构对称的空抽象。

## 19. 阶段完成条件

阶段 4 只有同时满足以下条件才完成：

- 4A–4F 全部完成并通过两轮审核；
- Route 不直接访问 Store/Repository；
- Query、Command、Admission、Control、Executor、Projection、Recovery、Maintenance 有唯一所有者；
- durable record 与 live handle 分离；
- SessionApplicationService/SessionRunEngine 中迁出的动作只转发；
- DaemonApplication 只负责组合、启动、ready、close 和兼容公开属性；
- 外部协议、错误和用户行为不变；
- Server 全量测试与类型检查通过；
- Services 回归通过；
- architecture/docs/diff 检查通过；
- 旧调用基线实际下降且未上调；
- docs/architecture-migration-status.md 记录真实指标并标记阶段 4 完成、阶段 5 未开始。

## 20. 后续边界

阶段 5 才处理 Client transport/resource。阶段 6 才处理 Desktop/Frontend 状态和目录。阶段 7–8 才收口公共 API 并删除兼容层。

阶段 4 不提前删除兼容接口。它的最终价值是让一次请求能够从 Route 进入一个明确 Application Service，再进入 Runtime 或 Services capability；维护者不需要阅读 DaemonApplication 或万能 context 才能理解流程。
