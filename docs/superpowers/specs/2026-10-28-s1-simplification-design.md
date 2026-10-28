# S1 彻底简化方案：移除操作控制，只保存工具结果

> 状态：B 方案已实施并通过独立 review。核对日期：2026-10-28；[验收记录](../reviews/2026-10-28-s1-remove-control.md)，迁移仅在测试数据库执行。

移除 S1 的多阶段操作状态机，保留正常权限、工具实际调用的收尾和长结果补读。普通失败只影响本次调用，新的调用按当前权限继续工作。历史 S1 记录和旧补读引用不要求兼容，不再保留 A 作为过渡实施路线。

目标执行路径只有：**检查权限与当前归属 → 执行工具 → 保存已返回结果 → 交给模型**。执行前不创建持久操作记录，不登记“已授权”或“已派发”，也不等待账本放行。

## 1. 本次选择与变更边界

主工作区基线为 `main` 的 `b714d3e702e4a719a671a33ec438f605abc9231f`，已包含紧急提交 `ede38d5113b46d19d45278da3a4820c1e94b8785`。目前 `blockOnUnknownToolOutcome` 默认 false，但操作状态机、记录票据和部分保存失败封锁仍存在；这些全部退出新方案。

用户已明确选择 B，并取消历史记录兼容要求。因此本方案替代此前“先删连带封锁，保留原记录接线”的建议。新补读只对新保存的结果负责，不迁移旧 Operation/Attempt 正文，不解析旧引用，不提供旧接口适配。

这改变了[原 S1 计划](../plans/2026-10-26-s1-tool-operation-safety.md)中的两项规则：派发前必须保存操作意图，以及未知写操作必须阻止其他新操作。实施时同步改写[生命周期契约](../../agent-lifecycle-contract.md)的 S1 相关约束和[当前阻断决策](../../tool-outcome-blocking-decision.md)；此处描述当前实现。

代价明确接受：不再提供通用的“同一 Operation 已确认结果复用、防重放、人工核对、迟到审计补写”承诺。仍不自动重试结果未知的工具调用。付款、发消息或创建记录的业务去重由具体工具和外部系统负责。

## 2. 参考 Codex 的取舍

沿用前次已核对的官方 Codex 提交 `d63fe536ee2bf4ea7d18d81e0e1be17543bf5b5b`，没有重新编译或运行 Codex。

| 已检查的处理方式 | 新方案的对应选择 |
| --- | --- |
| 普通工具错误返回对应调用；Fatal 单独上报 | 普通报错交还模型；无法继续执行的宿主错误才终止当前 Run。[源码](https://github.com/openai/codex/blob/d63fe536ee2bf4ea7d18d81e0e1be17543bf5b5b/codex-rs/core/src/tools/parallel.rs#L125-L141) |
| 审批与沙箱围绕当前动作 | 每次调用检查当前权限，不查询历史 unknown 账本。[源码](https://github.com/openai/codex/blob/d63fe536ee2bf4ea7d18d81e0e1be17543bf5b5b/codex-rs/core/src/tools/orchestrator.rs#L135-L225) |
| 活跃进程保留句柄，可继续读取 | 保留 Job/进程句柄和实际调用收尾，不增加持久操作状态机。[源码](https://github.com/openai/codex/blob/d63fe536ee2bf4ea7d18d81e0e1be17543bf5b5b/codex-rs/core/src/unified_exec/process_manager.rs#L613-L667) |

这些源码支持上述范围选择，不证明所有错误都可忽略，也不提供外部业务只执行一次的保证。不照搬 Codex 的整套审批或沙箱实现。

## 3. 保留与删除

Run 指一次 Agent 执行；owner 指当前有权写入数据的后台实例。Operation/Attempt 是旧 S1 的操作和派发账本，新方案不再创建它们。

| 保留 | 唯一职责 |
| --- | --- |
| 正常权限、审批、沙箱、计划模式、路径与命令限制 | 决定当前动作能否执行 |
| 当前 owner、会话/Run、输入、工作目录、最终工具绑定与权限范围检查 | 防止过期对象、错误来源或结束后的 Run 发起调用 |
| 实际调用 Promise 的登记、取消、等待结束、释放资源 | 工具超时后仍在运行时，正确收尾 |
| 新结果的完整正文、来源和稳定结果 ID | 在截断后读取、检索，并在重开后继续补读新结果 |
| 正常 Run/Job/Task 启动恢复与终态投影规则 | 收束真实运行，不恢复或重放旧工具调用 |
| 现有短期重复失败提示、串行组依赖、文件事实校验 | 保留各自局部作用，不扩大成历史封锁 |

| 删除 | 包含内容 |
| --- | --- |
| 整个 `ToolOperationGate` / `AgentToolSafety` | prepare、authorize、dispatch、settle、reject，配套票据、回执与注入传参 |
| 旧 `RequiredPolicyGate` 的票据协议 | 两阶段检查、返回 policyVersion、Operation 修订与意图摘要；真实权限检查按下一节保留 |
| 操作状态机及通用重放处理 | prepared/authorized/dispatching/confirmed/not_applied 状态、结果复用、同 Operation 拒绝重放、businessKey 和风险 kind 分类 |
| 所有历史封锁及开关 | 整树/同会话扫描、`unsettledFailures`、操作层的持久失败 Map、`blockOnUnknownToolOutcome`、缺参严格模式 |
| S1 可信只读例外 | 标记、动作判断、Browser/Job/Read 注册包装、公开导出；真实只读权限模式继续保留 |
| 人工核对链 | Review Service、list/inspect/reconcile 路由和 Client 方法、专用 pending Map、操作专用 observeInvocation |
| 旧审计持久层 | S1 的 ExecutionRepository、ToolOperationRepository、Operation/Attempt 数据模型、SessionStore 接线、启动恢复与清理条件 |
| 迟到结果审计链 | onLateOutcome、initialSettlement、迟到 settle、audit_failed 事件和围绕它建立的补偿处理 |

保留 `AgentExecutionContext.observeInvocation`，它跟踪真实工具是否结束。删除的是另一份人工解锁专用观察集合。保留 `markToolResultReader`，它避免补读工具再次归档自身；它不属于 S1 只读放行。

S1 的 `ExecutionRecord` 是 Run 状态的额外镜像，随旧账本删除。后台进程的 `SessionExecutionRecord`、真实 Run、Job、Task、Workflow 和投影恢复表继续保留，不能按相似名称一起删除。

## 4. 执行路径与职责

```text
模型 / 显式调用 / 嵌套调用
  → Core 准备输入，执行普通权限、审批与工具前置检查
  → Server 提供的本次宿主检查确认当前归属和最终工具绑定
  → Runtime 登记真实调用，执行工具
  → Core 收到成功、错误或超时反馈
  → 已完整返回的结果交给 ToolResultService.retain
  → Services 保存正文，返回新 resultRef
  → Core 按现有预算截断展示，交给模型
```

### 当前调用检查独立于记录

原 `requiredPolicy` 中的真实检查迁出 S1，收敛为统一执行入口的一次宿主派发前回调。只接收当前 Run 范围、最终工具绑定与实际输入；不传 Operation、票据、phase 或授权版本回执，不落盘。

Daemon 在最终工具集合确定后，为每个 Run 装配捕获该集合和当前运行范围的检查。调用前核对 owner、后台是否接纳工作、会话/Run 是否活跃、input/cwd 是否匹配，以及工具来源、定义和调用函数是否仍为宿主捕获的对象。运行范围或权限修订已变化时拒绝旧调用，不能让已授予权限扩大。

该检查不是普通可选 Hook。Daemon 启用时，模型、手动 runTool、嵌套调用和子 Agent 都必须经过它；替换 preparation 不能移除宿主检查。子 Run 使用自己的范围和最终工具集合，不能直接复用父 Run 的范围闭包。独立 SDK 未装配持久宿主时，继续按自己的正常权限执行，不要求数据库。

工具贡献已有的 `beforeDispatch` 仍检查具体工具的业务前提，不能仅靠它覆盖所有工具的宿主归属。不要新建 Guard Service、规则总线或另一组多阶段 Gate 来替换旧名称。

### 生命周期只跟踪实际调用

Runtime 继续在调用真正开始前登记 Promise。超时只结束本次等待，不代表工具已经停止；取消停止新派发，并按原流程等待实际调用结束后释放能力和资源。

删除迟到审计补写：通用工具在超时后返回的结果不再自动存入账本，也不追改已返回结果。它的完成仍被观察，以便收尾。后台任务仍可通过原 Job/进程句柄读取已有输出，不另造恢复入口。

工具进度由当前 Run、当前模型回合、活动工具消息和宿主生成的实际调用 ID 校验。Projector 不再查 Operation/Attempt 表，也不接受工具自由 metadata 冒充运行身份。保留普通 `toolAttemptId` 作为实际调用标识，不把它解释为数据库 Attempt 行；删除 `operationId / parentOperationId` 的旧事件和上下文接线。

## 5. 长结果补读：只存结果，不存执行手续

复用现有 `RunToolResultStore.retain/list/read/search`、Server `ToolResultService` 和 Services `tool-results/` 目录。`retain` 从“验证结果已经在 S1 账本里”改为“保存本次已返回的结果文本”。不再建立 ToolOperationRepository 依赖。

新建一张专用 `tool_result` 表，替代原来承载正文的 S1 三张表。使用现有 SQLite 连接、SessionStore 的事务、内存会话路由、会话删除及提交失败处理，不另建数据库、后台保存队列或缓存层。

| 存什么 | 用途 |
| --- | --- |
| 宿主生成的随机结果 ID | 唯一补读身份；新引用采用 `result:<UUID>` |
| sessionId、runId、toolUseId | 记录结果属于哪次调用；不是业务去重键 |
| toolName、来源 kind/id | 读取时核对当前是否有该来源的工具权限 |
| 完整文本、totalChars、createdAt | 分页、搜索和列表；字符位置沿用 UTF-16 规则 |

只保存正文视图：沿用 `toolResultText` 的块间换行、非文本占位和私有 MCP 数据排除规则。完整工具结果仍走原消息与交付流程，不为补读复制另一份输入、函数身份、环境快照或授权状态。

正常完整返回且 `executionState: completed` 的成功和错误结果都可以保存。只保存一次，先保存再截断并发布引用。未启动、结果未知、用户取消后的反馈和补读工具自身不进入完整结果库，不建立待完成行。没有派发前持久写入，也没有“记录保存后才能启动工具”的规则。

结果 ID 和来源由宿主生成或来自最终绑定，忽略工具提供的 resultRef 和伪造归属。读取仍限定精确会话，并核对当前活跃 Run、owner、运行修订和工具来源；父子会话不自动互读。`list` 先筛权限和分页，再加载当前页正文，不能先复制全部长文本。

新结果支持同一版本下关闭/重开后的补读。旧格式 `result:operation_...:tool_attempt_...` 不解析、不映射，统一按不可用引用处理。历史对话原本可见的消息不要求删除，但其中旧补读链接不再可用；不扫描改写全部历史消息来伪装兼容。

## 6. 错误处理只表达本次事实

| 情况 | 反馈与行为 |
| --- | --- |
| Shell 非零退出、Browser 正常返回导航错误、MCP 正常返回错误结果 | `completed + isError: true`；保留原输出，下一轮可核查、修正或执行其他调用 |
| 实际工具合法返回但未声明执行状态 | 只在真实返回路径补 completed；不推断业务目标成功，不给普通错误硬塞 unknown_outcome |
| 调用已开始，但超时、断连或异常导致影响不确定 | 返回 unknown 和错误；不自动重试，不建立持久 unknown 账本，不限制其他新调用 |
| 调用前权限/前提拒绝或取消 | not_started；修正后按正常权限判断新动作 |
| 工具已被实际调用，却声明 not_started 且无法证明未开始 | 保守反馈 unknown；只表达本次事实 |
| 用户中断 | 停止该请求的新派发，原调用按原生命周期收尾 |
| owner 失效、宿主检查不可执行、正常生命周期投影失败 | 当前 Run 失败；不得跳过检查或伪造持久成功 |
| 已返回结果无法写入补读库 | 通过现有宿主错误通道终止当前 Run，不发布无效引用；保留调用已返回的事实，不重试工具、不封锁其他 Run |

`completed` 表示调用已返回，不代表业务成功或没有部分副作用。补读保存失败也不把已知 completed 改成 unknown；输出交付和宿主错误分别处理，不能声称完整结果已保存。

移除 S1 专用的持久失败记忆。当前 Run 的普通失败/取消传播使用既有 Run 控制器，避免换个名称重建禁止派发 Map。其他 Run 若因相同真实数据库故障失败，是它自己的保存失败，不是读取历史封锁集合后的拒绝。

[ADR 0001](../../adr/0001-projection-settlement-failure-policy.md)约束的正常终态投影恢复继续有效。不能为了消除 S1 错误而跳过真正尚未保存的 Run/Task 状态；也不再从已删除的迟到审计诊断链触发投影补偿。

## 7. 数据、接口与设置退役

### 不兼容旧 S1 记录

实施时通过现有增量迁移创建 `tool_result`，删除 `execution / tool_operation / tool_dispatch_attempt` 三张 S1 表及其索引。删除对应的状态加载、MutationBuffer、事务回滚登记、写入、会话清理和 Run 镜像更新代码。历史迁移文件保留以维持迁移链；最终 schema 不保留旧表。

不把旧数据导入新表，不做双读双写，不保留旧 DAO、引用解析或只读适配器。普通会话、消息、附件、真实 Run/Job 数据不因本次删除 S1 而清空。新旧数据库都只运行新结果路径。

迁移仅在测试数据库验证；发行升级属于明确有损升级：旧审计正文及补读能力丢弃；升级前按现有备份流程保存数据库副本，回退需成套恢复副本与旧版程序，不能承诺只回退代码就恢复旧结果。

### 公开接口直接替换

删除 Operation/Attempt、AgentToolSafety、RequiredPolicyGate 的旧类型、参数、事件字段、公开导出、Review 路由和 Client 方法，不保留 deprecated 空壳。ToolResult 的读写接口和新引用校验改为唯一新格式，transcript 与模型 metadata 也同步更新；不添加版本分流兼容。

当前源码协议为 6。实施的同一发行版本递增协议，Server、Client、CLI 与 Desktop 成套更新；旧客户端明确不匹配。自定义 SDK 宿主必须迁移到独立派发前检查和结果存储，不能静默丢掉原强制规则。

### 阻断设置退出

删除 `blockOnUnknownToolOutcome` 的类型、默认值、允许字段、运行 getter、派发参数和 Config 转换入口。读取用户/项目设置时，在现有严格校验前仅剔除这个退役键；不重写启动文件，下一次正常保存不带出旧键。该定向配置清理不延伸成历史记录兼容框架。

GET 不返回旧键；两种在线 PATCH 均拒绝它，不能让通用 path 转换再次写入。其他未知或非法设置仍报错，不新增兼容开关。

## 8. 一个完整交付批次

结果存储替换、宿主检查迁出和 Gate 删除需要一起交付，避免中间版本有补读能力却没有正文，或删了 Gate 后漏掉真实权限。因此以下是同一批中的实施顺序，不分成先上线 A 再转 B。

| 顺序 | 文件范围与完成条件 |
| --- | --- |
| 1. 独立真实检查与结果契约 | Agent Contracts 的 execution/tools/policy、Runtime 的 kernel/node 组装：去掉安全能力成对注入；只留下派发前宿主检查、结果存储和真实调用观察 |
| 2. 结果库替换 | Services `tool-results/`、SessionStore、schema/迁移/持久化：新增唯一结果表和保存入口，Reader 不再依赖 Operation，新增无旧数据导入的迁移 |
| 3. 执行入口收敛 | Core `checked-tool-execution.ts`、`query-tool-limits.ts`、`query-engine.ts`：删除票据和迟到审计，完成结果直接 retain；模型、手动、嵌套、child 共用路径 |
| 4. 宿主与投影切换 | Server `tool-result-service.ts`、Daemon 组装、工具生命周期 Projector、维护清理与启动恢复：改用当前调用身份和新结果库，保留真实 Run/Job/Task 保护 |
| 5. 删除旧模块与公开入口 | 删除 `operation-execution.ts`、Runtime `tool-safety.ts`、S1 只读分类、Operation/Review Service、Services 旧两个分类及所有旧导出、HTTP/Client/DTO/配置引用 |
| 6. 验证、文档与成套产物 | 更新协议、SDK、生命周期、存储、权限、运维、模块 README 和契约测试索引；旧计划保留历史语境并链接新方案 |

涉及超过 8 个文件，跨 Core、Runtime、Server、Services、Host Config、契约和 Client。主要风险在宿主校验漏接和结果保存位置错误；不能只删除 toolSafety 注入后认为完成。只新增一张结果表，删除三张审计表；不新增服务、运行开关、环境变量、恢复队列、自动重试或外部账号。

## 9. 验收以普通失败后的完整工作流为准

以下是实施验收要求，实际执行结果见实施报告。测试放在模块 `__test__/`；跨模块场景放 `tests/agent-integration/__test__/`。

| 场景 | 必须观察到的结果 |
| --- | --- |
| 真实 Node Agent Browser 报错 → JobList/Read/Wait → Shell 构建 → 汇报 | 同 Run 完成；覆盖真实 agent 来源，不清记录、不切开关 |
| Shell 非零退出、MCP 返回错误后调用不同工具或修正输入 | 错误保持可见；合法返回为 completed+isError；后续合法调用真实执行 |
| 权限拒绝、计划模式、旧 owner、终态 Run、来源替换、运行修订变化 | 实际调用零次；不能通过手动/嵌套/child/替换 preparation 绕过 |
| 工具超时但实际仍运行；用户取消；同步抛错 | 不重放；已开始的调用都登记并收尾；资源不提前释放 |
| 超时后迟到完成或失败 | 只完成原调用收尾，不审计补写、不二次工具输出、不封锁其他调用 |
| 成功或错误结果超过 300 KB | 截断前正文完整保存；list/read/search 能取尾部；只引用已保存结果 |
| 保存新结果后关闭重开；memory 会话关闭 | 新持久结果可补读；memory 结果按原约定消失 |
| 跨会话引用、来源冒用、自带 resultRef、未授权列表条目 | 不读正文、不泄露列表、不接受伪造身份；补读工具不递归保存自身 |
| 结果保存失败 | 当前 Run 报真实宿主错误，无假引用，不改写执行事实、不重试工具；其他 Run 不因旧集合拒绝 |
| 旧 S1 数据库升级、新建数据库、旧格式引用 | 最终只有新结果表，无旧记录导入/双读；旧引用不可用，其余会话数据保留 |
| 旧账本状态曾为 prepared/dispatching/unknown；真实任务/审批仍活跃 | 旧账本不参与清理；实际活跃对象继续阻止危险清理 |
| 旧设置 true/false、非法其他字段、两种 PATCH、旧 Client | 仅退役键被读取剔除；PATCH 拒绝旧键；协议不匹配明确可见 |

运行受影响的 Core、Runtime、Server、Services、Host Config 和 Client 定向测试，尤其真实 SQLite、实际 Node 装配、模型/手动/嵌套/child 路径。再运行 `pnpm check-types`、`pnpm check:client-api`、`pnpm check-docs`、`pnpm check:retired-ui`。移除旧模块后核对全仓引用与 schema 清单，删除只验证旧 Gate 的测试，保留真正的权限、收尾和补读回归。

重建受影响的内部包，使用同一版本的实际构建产物执行 Browser 失败后继续构建的用例，避免源码与旧 bundle 混用。Windows 夹具用临时文件和 Node 子进程，不依赖 POSIX 命令。按实际改动运行相关构建与定向测试。

## 10. 简化完成的判断

新调用路径中没有 Operation、Attempt、票据、授权持久状态或历史未知扫描；工具执行不依赖补读库提前写入。已返回的正文只保存到一个结果库，当前权限和真实生命周期各走自己的入口。

本方案最关键的前提是：真实宿主校验可以独立于旧票据执行。所有调用入口必须用真实权限拒绝测试证明这一点；如果某入口仍依赖旧 Gate，就修正该入口的统一接入，不能保留旧 Gate 作暗中兜底。结果保存失败不构成重新引入全局控制层的理由。

本方案已实施并合入 main；未操作真实用户数据库。
