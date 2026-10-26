# OpenHarness-ts 核心 Agent 能力补齐方案

> 状态：当前分阶段设计；S1 已接入并完成限定范围验证，见[验收记录](../reviews/2026-10-26-s1-tool-operation-safety.md)。S2、S3 与 P1 仍为拟议内容。

> 日期：2026-10-26。源码基线：`25812866`。
> 范围：OpenHarness-ts/Vykor 核心执行能力。初版仅交付方案；S1 实施范围见[实施计划](../plans/2026-10-26-s1-tool-operation-safety.md)，不讨论 Boban 业务迁移。

> 本次补充：状态转换与竞争处理、现有工具恢复能力表、请求冻结与重建规则；S2 拆为单执行、子 Agent、Workflow 三段。

## A 目标、优先级与设计选择

目标是让一次 Agent 任务能够可靠等待、恢复和提交工具操作，并能说明已完成什么、还有什么不确定。

| 顺序 | 级别 | 能力包 | 交付目标 |
|---|---|---|---|
| 1 | P0-A | 可恢复执行 | 在明确边界保存执行位置，进程退出后可以继续；已确认操作不重跑 |
| 2 | P0-B | 可恢复审批 | 等待审批不依赖活跃 Promise；审批支持重启、修改参数与并发响应 |
| 3 | P0-C | 安全工具提交 | 操作有稳定身份、回执和核对流程；强制规则失败时不能执行 |
| 4 | P1-A | 结构化交付与验收 | 根任务和子任务返回可校验数据；运行结束与任务验收分开 |
| 5 | P1-B | 通用结果引用与补读 | 长工具结果能够分页、检索、跨回合和重启后读取 |
| 6 | P1-C | 显式任务事实 | 目标、约束、计划、产物、已确认事实独立于聊天摘要保存 |
| 7 | P1-D | 访问范围与记忆归属 | 统一执行主体、数据归属和授权检查；记忆标签不能充当权限 |

P0-A、P0-B、P0-C 是需求排序，不表示能跳过安全提交直接承诺自动恢复。
P0 的首个执行包必须先建立操作记录和强制检查基础，再开放恢复能力。

**推荐方向：给现有 QueryEngine 增加可序列化的继续执行状态，复用现有 Kernel、事件、存储与调度。**

- 保留 `core → Kernel → Node/Server` 的职责分工。
- 复用 SessionStore 的同一 SQLite、事务协调、写入 owner 与事件序号。
- 正式 SQLite 会话提供持久恢复；memory 会话保持临时性质。
- 独立 SDK 通过宿主接口接入持久化，不默认创建数据库。
- 恢复生成新的 Run，关联同一个 Execution；已经结束的 Run 不重开。

Execution 表示一次逻辑执行，包含多段运行。Run 表示某个进程中实际推进的一段运行。
Execution 不替代现有 Goal、Workflow、Session 或业务任务。

最小方案是保存历史后重新发送原 prompt。它可以作为“重新执行”入口，但不能满足本方案的恢复验收。
另一条路线是整体引入通用持久工作流引擎。本方案选择沿用现有执行循环，不新增外部服务和运维依赖。

本方案依赖一个前提：工具宿主能正确声明操作性质，并提供所承诺的去重或结果查询能力。
若前提不成立，结果未知时进入 blocked，不能通过模型推断“应该没有执行”。

本次涉及 8 个核心包、现有客户端状态消费和文档，预计超过 8 个文件。
方案不增加 Redis、消息队列、新网络服务或新的第三方账号。
不增加面向终端用户的环境变量或 CLI 开关。

## B 核心分层、身份与原子提交

### B1. 唯一所有者

```text
Client / SDK
    │ 提交、继续、审批、取消
    ▼
Server 应用用例 ───────────────► Services Repository / Transaction
    │ 读取可信恢复状态                       │
    │ 注入能力与可靠接收器                   ▼
    ▼                                同一 SQLite / memory 路由
Kernel：Run / Child 活跃生命周期
    │                         ▲
    ▼                         │ 可靠边界批次，提交成功后才推进
core：模型循环 / 工具批次 / 继续执行状态
    │
    ▼
Node 工具绑定 / 操作适配器 ─────► 实际文件、进程、远端工具
```

| 内容 | 唯一所有者 | 约束 |
|---|---|---|
| 当前模型循环、工具批次、历史与继续位置 | core | 通过纯数据快照导出；不导入 Services 或数据库 |
| 当前 Run、Child 句柄、取消和资源释放 | Kernel | 不保存 Promise、回调或活体句柄到数据库 |
| 工具实现、插件版本、环境绑定 | Node 宿主 | 恢复时重新构造并核验；不反序列化执行函数 |
| Execution、检查点、操作记录、审批 | Services | 与现有记录共用事务、写入 owner 与存储归属 |
| 继续执行、启动恢复、人工核对策略 | Server 应用层 | 调用现有车道和 AgentPool，不创建第二套运行控制器 |
| 界面、SDK 状态 | Client / Protocol | 从已提交状态展示，不从 SSE 文本猜测完成或授权 |

Kernel 继续禁止依赖 server、Services、Protocol、domain-contracts、plugin-contracts 和 json-data。
新增的纯执行合同放在 agent-contracts。
产品记录和数据库记录放在 domain-contracts/Services。

### B2. 身份规则

| 标识 | 生命周期与用途 |
|---|---|
| executionId | 一次逻辑执行；暂停、进程重启和恢复后保持不变 |
| runId | 每一段实际运行；每次继续生成新的值 |
| stepId | 已确认的模型回合或工具批次；恢复后保持不变 |
| operationId | 一次逻辑工具操作；恢复和安全重试沿用 |
| toolCallId | 模型生成的调用身份，作为原始关联保留 |
| generationId | 宿主分配的模型回合身份；不同回合复用 toolCallId 仍是独立操作 |
| toolAttemptId | 每一次真正派发工具的尝试；每次派发生成新值 |
| requestId / intentRevision | 审批请求与待执行意图版本；参数修改后形成新版本 |
| boundaryId / checkpointRevision | 原子提交的身份与检查点版本；用于防重复和并发校验 |

同一批次的每个调用分别分配 operationId。
相同参数的两次独立操作必须允许拥有不同 operationId。
参数摘要只用于判断内容是否变化，不能独自充当业务去重键。
业务连接器提供业务去重键时，需要与 operationId 一起保存和校验。

### B3. 一次边界只提交一次

新增通用 `AgentEventSink` 合同，由一个可靠接收器同时处理普通事件和边界批次。
它包含普通事件接收与 `commitBoundary` 两类职责。
边界批次包含检查点、操作变更、历史变化和相关执行事实。

在 daemon 中，由现有投影器与具名 Transaction 完成同一次提交：

1. 校验 Execution 当前版本与现有 application owner。
2. 保存检查点、操作状态及确认结果。
3. 更新相关 Run、审批、消息与事件记录。
4. 提交 SQLite 和内存 read model。
5. 提交成功后，通知订阅者并发布 SSE。

core 必须等待提交回执，才能进入下一模型请求或派发工具。
提交失败时停止推进，不发送成功回执，不移动已应用事件水位。
边界内事件不能再由普通事件路径重复落库。
普通文本 delta 保留现有批量持久化策略，不逐 token 创建执行检查点。

同一 boundaryId、相同内容重复提交返回已有回执。
同一 boundaryId、不同内容必须拒绝。
继续操作使用 expectedRevision 校验，两个请求只能有一个取得继续权。
继续复用现有单 daemon owner 与会话车道，不新建第二套 owner lease。

旧 `onEvent` 可作为普通 SDK 的可靠事件入口。
持久执行要求提供完整 AgentEventSink；不能由普通 observer 假冒。
两个可靠出口不得同时配置；配置冲突在创建 Agent 时失败。

## C P0-A：可恢复执行怎样设计

### C1. 状态与暂停

Execution 使用这些状态：ready、running、waiting_approval、waiting_children、recoverable、reconciling、blocked、completed、failed、cancelled。

| 状态 | 含义 | 下一步 |
|---|---|---|
| ready | 已受理，尚未运行 | 现有车道创建 Run |
| running | 某个 Run 正在推进 | 提交下一个安全边界 |
| waiting_approval | 已保存待办与执行位置，无活跃等待者 | 审批决议形成继续请求 |
| waiting_children | 等待已登记子执行 | 子执行结算后安排继续 |
| recoverable | 进程已失去活体运行，检查点可读取 | 校验版本、身份和未决操作 |
| reconciling | 有操作可能已发生，正在查询实际结果 | 确认结果，或转 blocked |
| blocked | 缺少可信结果、授权、资源或兼容实现 | 人工处理或条件变化后显式继续 |
| completed / failed / cancelled | 逻辑执行结束 | 不自动重开 |

Run 新增终态 suspended，表示这段运行已安全让出，逻辑执行尚未结束。
`AgentRunResult` 增加可判别的 suspended 结果，携带 Execution、检查点和暂停原因。
不要用 completed 表示“等审批”，也不要用异常失败伪装正常让出。

进入 suspended 前，必须提交边界并释放本段运行拥有的模型连接与工具租约。
Kernel 回到可接收后续操作的 idle；没有待审批 Promise 常驻。
旧 Run 保持 suspended，继续创建新 Run。

显式取消沿用现有中断收尾路径，并将 Execution 标记为 cancelled。
暂停与取消是两种动作；父级暂停不能被转换成对子执行的业务取消。

#### C1.1 状态转换与提交规则

下表是拟议的允许转换。Services 的具名 Transaction 是状态写入入口，Server 负责发起用例，core/Kernel 提供执行事实。
客户端、工具返回文本和 SSE 订阅者不能直接修改状态。
表中的“继续受理”表示将新 Run 排入现有会话车道，实际开始时才进入 running。

| 从哪里到哪里 | 谁触发 | 必须满足的条件 | 同一事务写入 |
|---|---|---|---|
| 无记录 → ready | Server 输入受理 | 输入身份未受理，归属与权限有效 | Execution、Input、首个排队 Run、受理回执和事件 |
| ready → running | 现有会话车道 | 当前 owner 有效；指定 Run 尚未开始；Execution 版本匹配 | Execution 状态、当前 Run 的开始状态和事件 |
| running → waiting_approval | core 授权阶段，Kernel 让出 | 整批未派发；等待项和完整批次可保存 | 检查点、Operation、审批待办、Run.suspended 和事件 |
| running → waiting_children | core/Kernel 等待子执行 | 子身份和依赖已登记；本段无未结算的工具调用 | 检查点、父子依赖、Run.suspended 和事件 |
| running → reconciling / blocked | 工具结算或恢复前检查 | 有未知操作，或缺少可信资源；检查点已可靠保存 | 检查点、Operation、具体原因、Run.suspended 和事件 |
| running → recoverable | 启动恢复 | 旧活体已失效；存在完整且可读取的检查点 | 旧 Run 的 interrupted 终态、Execution 状态和事件 |
| recoverable / blocked → reconciling | 启动恢复或显式继续 | owner 与版本有效；存在需核对的原操作 | 核对计划、原因和命令受理回执；此时不派发业务操作 |
| reconciling → blocked | 核对服务 | 证据仍不足，或身份、权限、资源不兼容 | 核对证据引用、Operation 状态、阻塞原因和事件 |
| waiting_approval → waiting_approval / ready | 审批决定或参数修改 | 请求、意图、到期时间和回复权限有效；无未知操作 | 决议或替代请求、批次和检查点；仅全部等待解除时创建新排队 Run |
| waiting_children → waiting_children / ready | 子执行结算 | 结算绑定原子执行；依赖版本匹配；无未知操作 | 子结果引用、依赖和检查点；仅依赖满足时创建新排队 Run |
| recoverable / reconciling / blocked → ready | 恢复服务 | 兼容检查与当前授权通过；无未知操作；无未满足等待条件 | 最新检查点、继续命令回执、Execution 与新排队 Run |
| running → completed / failed | core/Kernel 最终结算 | 最终结果明确；无未决操作或子依赖；失败不能掩盖 unknown | 最后检查点、结果引用、Execution、当前 Run 终态和事件 |
| 任意非终态 → cancelled | 已授权取消命令 | owner、Execution 版本及命令身份有效 | 取消标记、未派发操作与待办取消、活跃或排队 Run 的收尾状态和事件；既有终态 Run 不变 |

ready 允许有排队 Run，但不能有正在推进的 Run；同一 Execution 最多有一个排队或活跃 Run。
正常暂停不能将旧 Run 改回可运行；异常退出也不能把旧 Run 补写为 suspended。

waiting_approval 和 waiting_children 在重启后保留，恢复服务先检查原等待条件，不统一改成 recoverable。
核对发现仍有待审批或子依赖时，reconciling 回到对应等待状态，并与证据、检查点一起提交，不创建 Run。
缺少检查点、检查点损坏或版本不支持时，保存具体 blocked 原因；旧式 Run 仍走原中断策略。

每次状态变化都校验 application owner、expectedRevision 和涉及记录的当前版本，再增加 Execution revision。
并发工具逐项结算由接收器按最新已提交批次合并，不以整份旧快照覆盖另一项结果。

同一 commandId / boundaryId 先检查已存内容与回执，再处理版本冲突；相同内容重投返回原回执。
命令身份、内容摘要和回执与状态变更同一次提交，不能只在内存去重。
未列出的转换拒绝执行；终态只允许追加审计事实，不允许转回 ready/running。

#### C1.2 取消、暂停与迟到结果的竞争

| 竞争情况 | 提交顺序与结果 |
|---|---|
| 取消与审批批准同时发生 | 两者争用同一 Execution 版本；取消先提交则批准失效；批准先提交也只产生排队 Run，取消仍可阻止尚未开始的派发 |
| 取消与工具派发同时发生 | 派发权必须与 Operation 的 dispatching、当前意图和 Execution 未取消条件一起提交；取消先提交则不调用工具；派发权先取得则保留“可能已发生”，尽力中止并核对 |
| 取消后收到合法回执 | 当前 owner 校验 attempt、意图与证据后更新 Operation 审计结果；Execution 保持 cancelled，旧 Run 不重开，不继续模型或后续工具 |
| 暂停后子执行完成 | 只结算原依赖并最多受理一次继续；父级暂停不取消子执行；显式取消才按现有父子取消策略处理 |
| 旧 owner 收到迟到结果 | 旧 owner 不写权威记录；新 owner 通过可信核对入口取证。取不回回执就保留 unknown，不能据此发起第二次写入 |
| 边界提交失败 | 保留上一次已提交状态并停止推进；不能宣称已暂停、已取消或已完成。运行资源仍需释放，下一次启动按已存事实恢复 |

取消与外部调用之间没有跨系统事务。已经取得派发权的请求可能在取消之后才对外生效，界面应保留未决操作提示。
截止时间或额度耗尽时停止新派发；存在 unknown 就保留 blocked 和原因，不能用 failed 清掉核对责任。

### C2. 检查点保存什么

新增 `EngineCheckpointV1`，只允许经过校验的可序列化数据。
它不是现有 text delta checkpoint，也不是 session memory。

| 内容 | 必须保存的事实 |
|---|---|
| 身份与版本 | executionId、stepId、checkpointRevision、schemaVersion、continuationVersion、运行构建标识 |
| 继续位置 | model_ready、tools_ready、awaiting_approval、awaiting_children、turn_committed、finished |
| 模型上下文 | 当前已确认历史、压缩结果、已消费输入序号、冻结请求正文与配置的持久引用及摘要 |
| 当前工具批次 | 完整已确认的模型工具调用、规范化参数、顺序、serialGroup、每项 operationId 和结算状态 |
| 工具与环境身份 | 工具来源、插件/内置实现版本、参数结构摘要、环境类型与工作目录绑定 |
| 资源引用 | 附件、工具结果、工作目录等已授权引用及必要完整性信息 |
| 控制与预算 | 已接受的追加输入、已消费游标、已用回合、实际模型尝试、根树额度和截止时间 |
| 子执行 | 父子 Execution 关系、原 sessionId/childId、确认结果、未决依赖与预算归属 |

执行所需的 API Key、临时凭据、执行函数、AbortSignal、Promise 和句柄不能进入检查点。
恢复时从可信配置重新获取凭据，并重新创建工具与环境。
同一执行的计时、用量和子任务额度不能因为恢复而清零。
历史中的敏感用户内容沿用原存储保护策略，不复制到额外日志。

P0 使用关键边界的完整快照，优先保证正确性。
“完整”表示状态能够完整重建，不表示每次复制全部正文。
历史按不可变版本保存；检查点引用对应版本，工具逐项结算只更新批次与结果引用。
大结果使用现有已持久化结果或附件引用，不复制到每个快照。

正文或引用无法可靠保存时，本次边界提交失败，不能静默裁剪后声称可恢复。
P1-B 再补统一结果补读接口，不阻塞 P0 对确认结果的内部保存。
活动 Execution 和未决 Operation 必须持有资源引用，防止结果、附件和工作目录被提前清理。

#### C2.1 冻结什么，恢复时重新获取什么

冻结单位是一次 generation 对应的模型请求，以及它确认产生的工具批次。
“冻结”表示保存实际使用的数据或不可变持久引用；摘要用于查验内容，没有正文或可读取引用就不能据此恢复。

| 内容 | 检查点中冻结 | 恢复时的处理 |
|---|---|---|
| 模型请求 | 实际消息与顺序、system 提示词正文、模型/provider/API 格式、effort、输出上限及实际请求选项 | 同一未确认 generation 重试使用原冻结数据；每次实际请求新增 Attempt；模型不可用时 blocked，不自动换模型 |
| 动态上下文 | 本次实际拼入的记忆、Skills、环境说明、宿主 contribution 的可序列化内容及引用版本 | 不重新检索来替换原请求；依赖资源已撤权则 blocked。新的检索只能在后续新 generation 建立新快照 |
| 工具可见集合 | 该请求实际公开的定义、参数结构、来源/实现版本、代理与目标绑定、已加载工具目录状态 | 从可信 Node 宿主重建函数并逐项比对；同名不同实现不接受；ToolSearch 的加载状态随检查点恢复 |
| 已确认工具批次 | 原始 toolCallId、顺序、operationId、规范化完整输入、串行组、intentRevision、结果与业务键 | 复用原批次；content_from 等输入引用在派发前解析并固定，不依赖后来已压缩的聊天正文 |
| 环境与资源 | local/WSL 类型、工作目录、可核验环境身份、路径解析结果、附件/结果版本与完整性信息 | 重新获取环境句柄并核验；同路径但环境不符、引用损坏或缺失时 blocked |
| 权限与规则 | 原执行主体、资源范围、意图摘要、原策略版本与审批证据 | 凭据和当前规则重新获取；重新检查当前权限。原授权不能覆盖撤销、收紧或身份变化 |
| 执行预算与控制 | 累计用量、已用回合、绝对截止时间、输入消费游标、根树额度及子关系 | 继续累加，不能重置；时间流逝与新限制只会缩小可用范围 |
| 活体依赖 | 仅保存模型路由和宿主绑定标识，不保存客户端实例、函数、密钥或句柄 | 从可信配置获取模型客户端、凭据、适配器与信号；保持原执行主体和目标范围 |

实际请求选项按明确字段保存，认证 header、临时签名和凭据引用中的秘密值不进入冻结正文。
同一 generation 的重试保留 generationId，实际 Attempt 身份变化；已确认完整输出以后禁止重试该 generation 来替换工具批次。

到达完整 turn_committed 或 model_ready 后，才可以为下一 generation 接受已提交配置变更和新输入，并保存新冻结版本。
凭据轮换可以重新绑定，但不得暗中切换执行主体、目标服务或授权范围；无法验证等价绑定时 blocked。

审批修改参数时，原始模型输出保留审计，新意图、规范化批次输入与检查点同一次更新；后续模型历史明确记录用户修改及实际执行参数。
参数修改还要重新计算目标资源、serialGroup 和工具绑定；若改变工具身份则另建 Operation，不能套用旧批准。

#### C2.2 重建前的查验顺序

1. 读取已提交检查点及其不可变引用，校验格式版本、正文摘要和原存储归属。
2. 校验当前执行主体、资源授权、绝对截止时间和剩余额度；不可用时先停止。
3. 重建模型路由、环境和工具绑定，比对冻结内容；只重新获取活体依赖。
4. 核对原批次未决操作，复用已确认结果；处理审批的新意图版本和子执行依赖。
5. 原子提交检查结果和继续受理，再由会话车道创建活体运行。

查验不通过时，由当前 owner 保存可定位的原因与资源标识并进入 blocked；不退回原 prompt 重跑。
保存本身失败或已经失去 owner 时停止推进，保留上一次已提交状态，不宣称 blocked 已落库。
P0 必须保存上述正文与引用；P1-B 只补模型可用的统一补读入口，不推迟恢复所需的内部持久化。

### C3. 在哪里保存

| 边界 | 提交要求 |
|---|---|
| 输入受理 | Execution、输入和首个 Run 同一事务建立 |
| 模型请求前 | 固定本次请求和 generation 身份；沿用 ModelAttemptGate 记录实际请求 |
| 模型完整返回 | 先保存完整文本和完整工具调用，再允许执行工具；残缺参数不能执行 |
| 工具派发前 | 保存整批调用，完成授权；每项操作先记录派发意图，再调用外部工具 |
| 每个工具返回 | 保存该项确认结果和批次进度；并发调用分别结算 |
| 下一模型回合前 | 只有当前批次全部有明确结果，才组装并提交下一份模型历史 |
| 追加输入消费 | 消费序号与新历史同一次提交，防止恢复后重复插入 |
| 压缩完成 | 新历史与检查点同一次提交；提交失败继续保留旧历史 |
| 等待审批/子执行 | 保存等待条件与继续位置后正常让出 |
| 最终结束 | Execution、Run、最后检查点和确认结果一起结算 |

模型流中断时可以重新请求模型，但必须撤换未确认的残缺输出。
已经确认的模型工具调用不能重新生成另一批操作替代它。
恢复请求形成新的实际模型尝试，用量保持已知、部分和未知的区别。

### C4. 恢复路径

Server 的继续入口只接收 executionId、expectedRevision 和 commandId。
客户端不能提交任意检查点、工具函数或伪造的结果。

恢复顺序固定为：修复未完成投影 → 读取最新检查点 → 校验版本与资源 → 处理未决操作 → 重建运行 → 继续推进。
版本不支持、工具身份变化或必要资源缺失时，进入 blocked。
不能自动将旧参数交给同名的新工具执行。

已确认操作读取保存的结果，不再调用工具。
有派发意图但缺少确认结果的操作进入 reconciling。
没有派发的操作可以在当前规则重新校验后执行。
不支持持久恢复的旧 Run 保留明确的 prompt replay 入口；不能伪称从检查点继续。

core 提供独立恢复入口，不再次追加原 prompt。
有未决工具批次时，先按操作记录填齐结果，不使用普通历史清理把未决调用删掉。
只有到 model_ready 或完整 turn_committed 边界，才继续请求模型。

### C5. 子 Agent、Workflow 与不可恢复资源

子 Agent 的创建身份先持久化，再实际启动。
恢复重建原有逻辑 childId/sessionId 关系，创建新的运行句柄。
已完成子执行复用确认结果；未完成且具备检查点的子执行各自恢复。
父执行只重新连接依赖，不重复创建同一子任务。
根树 active/total/depth 额度从持久关系重建，保持现有额度语义。

Workflow 复用现有快照、结果与 runner。
启动恢复改为按工具操作记录核对各 worker，再恢复未完成步骤。
不能直接取消全部在途 Workflow，也不能将未确认 worker 当成从未执行。

终端、后台进程、浏览器活体和不支持恢复的第三方调用不保证复活。
已保存输出可以读取；无法确认外部工作是否继续时进入 blocked。
不得以“新开一个进程”代替恢复旧操作。

正常关闭先停止新派发，尽量结算在途调用，再保存检查点。
强制退出时未确认的调用保留 unknown，由启动恢复处理。

## D P0-B：可恢复审批怎样设计

### D1. 审批绑定具体意图

复用 PermissionRepository，不另建第二套审批权威。
扩展记录以绑定 Execution、operationId、intentRevision、参数摘要、工具身份、执行主体、访问范围、策略版本和到期时间。
执行主体表示真正发起操作的一方；不能由模型自由文本声明。

默认待审批有效期拟定为 7 天，保存绝对 expiresAt。
宿主可以设置更短期限；过期后创建新请求，不能修改旧记录延长授权。
这是一项拟议默认值，不是当前代码行为。
PermissionStatus 拟增加 superseded 和 cancelled；已有终态决议不原位修改。

批准针对一个逻辑 Operation，不授予后续新操作权限。
安全重试仍需要当前规则通过，且使用同一个操作身份。
已有 session 授权可以作为规则判断输入，但不能跳过强制规则与恢复检查。

### D2. 等待与回复

对需要持久审批的工具批次，先完成整批参数检查和授权，再派发工具。
存在待审批项时，保存完整批次、待办、检查点及 Run.suspended，随后释放本段运行。
这样等待审批期间不会遗留同批次尚未结算的写操作。
权限模式变更类控制操作单独形成边界，后续调用不能沿用变更前的授权。

回复包含 commandId、requestId、expectedRevision、动作和意图摘要。
批准与继续受理在同一事务中完成，但实际执行由现有会话车道安排。
提交后通知和 SSE 失败不丢失已批准的决议，启动恢复仍能发现待继续执行。

同一命令、相同内容重复回复返回同一结果。
同一请求的不同决议竞争时，只有首次有效提交成功。
迟到回复、越权回复和已过期回复不能启动工具。

拒绝只给对应操作写入 not_started 的拒绝结果。
其他操作是否继续沿用已有串行组与失败规则，不把拒绝解释为授权。

### D3. 修改参数

修改动作先产生新的意图版本和新的待审批请求。
旧请求标记为 superseded，并保留原始内容与决议记录。
界面读取规范化后的新参数，再对这一版本执行批准。
禁止先批准旧摘要，再偷偷替换实际输入。

新参数必须重新经过：参数结构检查 → 当前权限与强制规则 → 参数摘要 → 审批绑定。
正式派发前再次核对参数、工具身份、策略版本及授权范围。
版本变化会使原授权失效，不自动扩大能力。
追加输入可以改变后续任务，但不能原位改掉已经审批的参数；需要变更时另建意图版本。

### D4. 重启、取消与子任务

启动恢复不再对有有效 Execution 绑定的待审批请求统一 expire。
缺少绑定的旧式活体等待请求继续沿用旧恢复策略。
用户问题也使用同一持久等待机制，避免 AskUser 仍只能依赖内存回调。

取消 Execution 时，原子取消未消费待办；之后收到批准也不能派发。
已开始的外部调用按 P0-C 结算，不能因为取消而删除其回执。
子执行审批关联原子执行，父会话可以负责展示，但不能因此扩大访问主体或存储归属。

独立 SDK 保留交互式回调能力。
持久模式下，未立即取得决定时返回等待标识并暂停；不要求宿主一直挂住 Promise。

## E P0-C：安全工具提交与强制规则

### E1. 操作记录与派发尝试分开

新增 ToolOperation 记录，保存一次逻辑操作及其确认结果。
实际每次调用另存 ToolDispatchAttempt，不能将尝试编号固定为 1。
它们与现有模型调用 Attempt 分开，不混合计费与外部副作用。
副作用表示发送消息、改文件、创建记录等对外部状态的实际改变。

| 操作状态 | 含义 | 恢复动作 |
|---|---|---|
| prepared | 参数和身份已保存，未允许派发 | 重新校验规则 |
| authorized | 对应意图已获允许，仍未派发 | 校验授权有效性后争取派发权 |
| dispatching | 派发意图已提交；操作可能已发生 | 不盲目重试，先按适配器核对 |
| confirmed | 有可信结果或回执 | 复用结果，不再次提交 |
| not_applied | 有可信证据确认没有生效 | 按当前策略决定是否重试 |
| unknown | 不能确认外部效果 | 查询或人工处理；禁止自动重复写入 |
| rejected / cancelled | 尚未派发即被拒绝或取消 | 记录 not_started 结果 |

操作被确认失败但可能部分生效时，仍属于 unknown。
工具的 isError、错误文本或模型判断，不能证明 not_applied。
普通工具的 confirmed 只确认调用结果已保存；业务是否验收通过由 P1-A 的核验器判断。

### E2. 工具声明与适配器

工具宿主提供可信的 operation 声明，和模型可修改的参数分开。
继续保留 safeToRetry 的现有用途，但不能由它单独授权恢复重试。

| 类型 | 宿主承诺 | unknown 后的规则 |
|---|---|---|
| read_only | 操作无业务写入，可重复读取 | 可以按原范围重新读取 |
| idempotent_write | 支持稳定业务键；重复提交同一键不会重复生效 | 先查询；必要时沿用原业务键安全重试 |
| non_replayable | 不承诺去重或无法确认是否写入 | 只查询或人工处理，不自动重放 |

未声明工具按 non_replayable 处理。
本机文件写入可用前后摘要与预期内容核对；不支持核对的 Shell 按 non_replayable 处理。
MCP 的提示性 annotations 不能直接作为可信去重承诺。
插件原生工具、MCP 工具和手动 runTool 都必须经过相同检查管道。

查询适配器只能返回 applied、not_applied 或 unknown，并附可信回执或证据。
查询本身必须是只读操作。
每次恢复先做一轮核对；仍未知则 blocked，不新增后台无限重试循环。

恢复只能保证自己管道内的记录和派发顺序。
外部系统没有去重、查询或可核验前置条件时，不能承诺业务只发生一次。
普通文件写入也不是跨系统事务；强制退出窗口同样需要核对。

#### E2.1 现有工具的恢复能力表

下表按源码基线 `25812866` 的默认工具注册及按宿主注入的能力整理，表示拟议接入范围。
当前工具尚未接入本方案的 Operation 记录与恢复合同；表内 read_only 等分类都需要宿主声明、当前规则检查及对应验收后才能启用。
idempotent_write 表示以稳定业务键去重的写入；当前不能确认任何一组写工具已完整满足本方案的自动重试要求。

| 工具或操作 | 当前可确认的行为 | 拟议分类与核对方式 | 最早接入阶段 |
|---|---|---|---|
| Read、Glob、Grep、Lsp | 读取文件、检索路径/内容、查询代码信息 | read_only；未知后可在原授权范围重读，数据变化要标记新观察时间，不冒充原时点结果 | S2.1 |
| WebFetch、WebSearch | 通过当前 Web provider 取内容或检索 | 仅可信只读 provider 可声明 read_only；覆盖实现重新审查，未知 provider 默认 non_replayable | S2.1 |
| Brief、ListSkills、ToolSearch、Skill | 文本处理、目录发现与读取 Skill；ToolSearch 会加载工具定义 | 可信内置实现按 read_only 接入；Skill 正文和工具加载状态随冻结上下文恢复，不重复执行 Skill 文本里的指令 | S2.1 |
| Config(action=show)、ScheduleList、JobList、JobRead、JobWait | 读取设置、定时任务或已有 Job；JobWait 等待已有身份 | read_only；恢复游标和绝对期限，只读取原 Job，不重启其底层进程 | S2.1 |
| Sleep | 等待一段时间，没有业务写入 | read_only；持久化绝对唤醒时间，恢复只等剩余时长，不重新计时 | S2.1 |
| Write、Edit、ApplyPatch | 有文件变更校验与可信摘要；尚无跨重启的操作核对适配器 | 初始 non_replayable；拟保存派发前后摘要、预期内容和逐文件进度，只读核对当前效果；部分匹配保持 unknown。自动重试另需可核验前置条件和并发写入保护 | S2.1 首批核对适配器；自动重试另验收 |
| TodoWrite、NotebookEdit、Remember | 分别追加待办、修改 notebook、写入用户或项目记忆 | non_replayable；相同参数重跑可能追加或改错对象。需独立意图/版本与回执适配器，不能沿用文件工具分类 | S1 记账；S2.1 未知即 blocked |
| Shell、TerminalOpen、BackgroundShellCreate | 执行任意命令或创建活体进程；Shell 在部分宿主转交终端 | non_replayable；只查原进程身份与已保存输出，无可信状态就 blocked；不能靠解析命令文本认定只读 | S1 记账；S2.1 不复活进程 |
| JobSend、JobCancel | 给终端或子 Agent 发输入，或请求取消 | non_replayable；需要宿主命令去重回执。终端写入保持保守；子输入在 S2.2 绑定原子执行与稳定命令身份 | S1 记账；S2.2 补子输入核对 |
| Agent | 创建子执行并关联子会话/运行 | 初始 non_replayable；S2.2 将创建意图和稳定子身份同事务保存，按原身份查询，验证后才声明 idempotent_write | S2.2 |
| Workflow | 创建工作流并调度 worker | 初始 non_replayable；S2.3 绑定原 workflow/step/worker/Operation，逐项核对，禁止重新创建整条工作流 | S2.3 |
| ScheduleCreate/Update/Delete/RunNow | 创建、修改、删除定时任务或立即触发运行 | non_replayable；需要命令回执、目标版本及触发身份。查询到相似配置不能证明本次已执行 | S1 记账；S2.1 未知即 blocked |
| EnterPlanMode、ExitPlanMode、Config(action=set) | 改变权限模式或配置；模式工具已有串行组 | non_replayable；单独控制边界，以配置版本和操作回执核对；完成后后续调用重新授权 | S1 强制检查；适配器未完成时 blocked |
| EnterWorktree、ExitWorktree、TeamCreate、TeamDelete | 修改工作目录绑定、Git 工作区或内存团队 | non_replayable；目录与团队同名不足以证明同一操作；内存团队须在 S2.2 补持久关系，Git 操作另需适配器 | S1 记账；依赖无法重建时 blocked |
| FeishuPush | 直接发送消息；当前请求未传业务去重键，也未向工具返回消息身份 | non_replayable；超时不自动重发。补稳定业务键、可信发送回执和查询能力并验收后，才可升级分类 | S1 记账；S2.1 未知即 blocked |
| McpToolCall、ListMcpResources、ReadMcpResource、McpAuth、插件/自定义/浏览器工具 | 由外部服务器、插件或宿主实现；认证、读取和写入可能混合 | 默认 non_replayable；按真实目标及动作声明能力，不能信任提示性 annotations；认证结果不能连同凭据写入检查点 | S1 默认保护；可信适配器逐个接入 |

工具名只用于导航。实际声明必须绑定来源、实现版本、参数中的动作、目标及环境；装饰器、覆盖工具和代理都需要重新核验。
内部转交沿用同一实际副作用的 operationId；若代理会发起多个不同操作，应登记子 Operation 及派发顺序，避免内外层各自重放。

未知写操作不能通过换工具、改写参数或新建 Operation 绕过核对；恢复服务只在可信证据形成后继续。
只读重试也消耗 Attempt 和时间预算；已确认的只读结果仍复用，不为刷新数据而覆盖旧事实。

文件摘要匹配只能确认预期文件效果，不能证明某次调用只执行了一次。
其他人中途改写文件后，摘要也不能补全丢失的证据。
多文件 ApplyPatch 必须逐文件核对，不能以一个文件匹配宣告整批 confirmed；原内容相同也不能单独证明 not_applied。

S1 建立默认保护和操作记账；S2.1 首批开放可信只读工具及文件效果核对，其余写工具结果未知时一律 blocked。
S2.2、S2.3 分别扩展子执行和 Workflow；没有通过适配器验收的工具继续保留保守分类。

源码入口：[默认注册](../../../packages/agent-runtime/src/node/tools/default-tool-registry.ts)、[文件工具](../../../packages/tools/src/file/README.md)、[Job 工具](../../../packages/tools/src/job/job-tools.ts)、[飞书发送](../../../packages/tools/src/channels/feishu-push.ts)、[MCP 工具](../../../packages/tools/src/mcp/mcp-tools.ts)、[记忆写入](../../../packages/agent-runtime/src/node/memory/remember-tool.ts)。

### E3. 执行顺序与强制规则

标准管道固定为：规范化输入 → 参数校验 → 普通权限 → 强制规则 → 审批 → 派发前复核 → 记录派发意图 → 调用 → 保存确认结果。

强制规则放在单独的 RequiredPolicyGate 合同中。
它由可信宿主注入，检查执行主体、资源范围、业务限制和授权版本。
规则异常、超时或不可用时，当前操作停止。
host-internal 工具、嵌套工具调用、代理调用和子 Agent 都不能绕过它。
持久模式没有配置 RequiredPolicyGate 时拒绝受理，不能悄悄按允许处理。
没有业务限制的宿主也需要显式提供允许规则，以便记录所用策略版本。

保留可选 Hook 的现有观察和增强用途。
不要简单将全部 Hook 异常改为拒绝，以免混淆可选扩展与强制规则。
同样，不能把必须生效的检查放进当前会抛错放行的 pre_tool_use Hook。

串行组继续约束同类写操作；并发调用独立结算。
某项超时不能抹掉其他已经确认的结果。
非合作式工具超时后如果仍可能运行，保留 unknown，不启动第二次相同写入。

### E4. 必须覆盖的崩溃窗口

| 退出位置 | 数据库应看到什么 | 下一次动作 |
|---|---|---|
| 派发意图提交前 | prepared / authorized | 可以重新检查后派发 |
| 派发意图提交后、外部调用前 | dispatching | 按“可能已发生”核对；不能凭时间判断未执行 |
| 外部已生效、回执未保存 | dispatching / unknown | 查询实际系统，找回回执或停止等待人工处理 |
| 结果已提交、下一回合前 | confirmed | 复用结果继续，不再调用 |
| 宿主丢失 owner 后收到迟到结果 | 旧尝试结果待核对 | 旧 owner 无权推进；新 owner 核验后保存回执 |

复用现有数据库 owner 和会话互斥。
每次写入校验 owner 身份及记录版本，旧进程不能继续提交状态。
owner 互斥不能防止已经发出的外部请求生效，所以仍需要业务键和结果核对。
取消或 Run 终态不阻止合法迟到回执的审计结算，但不能重新打开旧 Run。

## F 核心模块、存储与交付顺序

### F1. 涉及哪些模块

以下“新增”为拟议文件，不表示已经存在。
每个新增分类同时提供 README，测试放在所属分类的 __test__。

| 包或层 | 现有关键文件 | 拟议新增或主要调整 |
|---|---|---|
| agent-contracts | `src/execution/execution.ts`、`events.ts`；`src/tools/tools.ts`；`src/policy/permissions.ts` | 新增 `execution/recovery.ts`、`execution/boundaries.ts`、`tools/operations.ts`、`policy/required-policy.ts`；定义纯数据与宿主合同 |
| core | `src/engine/query-engine.ts`；`types/runtime.ts`；`engine/tools/checked-tool-execution.ts`、`query-tool-permissions.ts` | 新增 `engine/recovery/checkpoint.ts`、`restore.ts`、`tool-batch-state.ts`；工具派发接入操作记录与强制规则 |
| agent-runtime Kernel | `src/kernel/agent.ts`、`framework-agent-run.ts`、`event-source.ts`；`kernel/children/` | 支持 suspended、恢复输入、可靠边界批次、子树重建；新增 `kernel/run-suspension.ts` |
| agent-runtime Node | `src/node/agent/agent-options.ts`、`agent-composition.ts`；`node/children/`、`node/workflow/workflow-host.ts` | 新增 `node/tools/tool-operation-adapters.ts`、`node/runtime/node-recovery-binding.ts`；核验工具来源与环境，不读取数据库 |
| domain-contracts | `src/sessions/records.ts` | 新增 `src/executions/records.ts` 与公开入口；Run.suspended、操作和检查点持久记录；审批版本字段 |
| services | `src/session-runtime/store.ts`、`schema.ts`；`database/transactions/`；`permissions/`、`runs/` | 新增 `src/execution-records/` 的 Repository/Transaction/commands 与 `src/tool-operations/` 的 Repository/commands；接入持久与临时路由，保留旧 executions 路径退役规则 |
| server | `application/session/execution/`、`session/interactions/session-interaction-service.ts`；`application/agent/daemon-agent-event-projector.ts`；`permissions/`、`application/recovery/` | 新增 `execution-recovery-service.ts`、`execution-boundary-sink.ts`、`tool-operation-service.ts`，放入现有 `application/session/execution/`；替换有检查点记录的启动恢复路径 |
| protocol / client | `protocol/src/session/`、`client/src/`；现有 HTTP route 与 mapper | 增加 Execution 查询/继续及版本化审批动作；客户端明确展示等待、可恢复和需核对状态 |
| 文档与测试 | 生命周期、框架边界、存储架构、权限流程、契约测试索引 | 同步新状态、新事务、恢复边界和验收编号；不把提案描述为当前已实现 |

### F2. 持久记录

| 记录 | 关键内容 | 原子关系 |
|---|---|---|
| execution | 身份、父子关系、owner session、状态、最新检查点、revision、当前 Run、截止时间 | 与 Run admission、暂停和结束联合写入 |
| execution_checkpoint | Execution + revision 唯一；版本、继续位置、冻结配置、历史与批次引用 | 与该边界的结果和事件联合写入 |
| tool_operation | operationId 唯一；意图版本、来源绑定、状态、业务键、确认结果引用 | 与派发意图、确认结果和审批联合写入 |
| tool_dispatch_attempt | 实际尝试身份、owner、开始/结束时间、查询与回执 | 不覆盖旧尝试，不与模型 Attempt 混用 |
| 现有 permission | Execution / Operation 绑定、版本、摘要、expiresAt、替代关系 | 回复与继续受理联合写入 |

新记录必须进入当前 mutation buffer、read model、SQLite 保存和回滚路径。
同一事务失败时，数据库、内存视图、事件序号和提交后通知一起回滚。
memory 会话的执行记录留在临时存储，不因开启恢复能力自动写入 SQLite。
启动时只加载必要记录头和活动索引；历史检查点正文按需读取，不全量装入内存。

新增表与状态变更按现有 Drizzle schema 和增量链维护。
新旧检查点与通信事件显式带版本；未知版本拒绝，不在读取时猜测升级。
变更 Run/审批事件合同的发布必须同时更新 Protocol 与 Client 解析。
旧客户端缺少能力时明确报告版本不支持，不能把 suspended 显示为 completed。

### F3. 对外合同

| 入口 | 行为 |
|---|---|
| SDK 创建/提交选项 | 宿主选择持久执行模式并提供 AgentEventSink；缺少可靠边界提交能力时拒绝该模式 |
| Execution 查询 | 返回状态、最新检查点版本、等待或 blocked 原因、关联 Run；不返回凭据或执行函数 |
| Execution 继续 | 使用 executionId、expectedRevision、commandId；Server 读取可信检查点并安排新 Run |
| 审批修改 | 对当前版本修改参数，生成新的意图与待审批记录 |
| 审批决定 | 针对确定版本批准或拒绝；相同命令幂等，竞争决议只有一个成功 |
| 操作核对 | 宿主/授权人工提交实际查询证据；模型文本不能直接将 unknown 改为 confirmed |
| 执行取消 | 停止后续派发，取消待办；保留已确认和未知操作的审计记录 |

### F4. 独立交付包

| 交付包 | 先决条件 | 可以独立验收的成果 |
|---|---|---|
| S1 操作安全基础 | 无 | P0-C 的操作身份、派发记录、强制规则、unknown 结算；现有 Agent 主流程仍可使用 |
| S2.1 单执行恢复 | S1 | P0-A 的冻结检查点、原子边界、新 Run 继续、追加输入与预算；先支持无子执行/Workflow 依赖的逻辑执行 |
| S2.2 子 Agent 恢复 | S2.1 | 稳定子身份、创建去重、父子依赖重连、子输入回执、根树额度；已完成子执行不重建 |
| S2.3 Workflow 恢复 | S2.2 | 原 workflow/step/worker 与 Operation 关联、逐项核对、复用确认结果和恢复未完成步骤 |
| S3 可恢复审批 | S2.3 | P0-B 的持久等待、参数修改和重启审批；旧式活体审批仍按原合同处理 |
| S4 业务交付能力 | S3 | 按 P1-A、P1-B、P1-C、P1-D 顺序逐项交付，每项有单独结果合同与验收 |

S1 不承诺重启续跑，S2 不承诺旧式审批跨重启保留。
S1 建立 Execution 头记录供操作关联；S2.1 才开放检查点继续入口。
每个包都保留明确可用边界，不依赖未交付包才能启动。

S2 表示 S2.1、S2.2、S2.3 的合集；三段依次交付，完成全部段后才宣称支持子树和 Workflow 恢复。
P0 全部完成后，才对外宣布“持久执行 + 持久审批 + 安全提交”能力。

#### F4.1 S2 每段的独立验收范围

| 阶段 | 重点验收编号 | 未交付能力的处理 |
|---|---|---|
| S2.1 单执行 | A01 至 A08、A11 至 A17、C01 至 C13；C07 本段覆盖 root、runTool、嵌套与代理入口 | 持久执行在新派发前拒绝 Agent/Workflow 创建；已有子树/Workflow 依赖进入 blocked，不套用旧恢复收尾去取消它们。旧式非持久入口沿用原合同 |
| S2.2 子 Agent | 继承 S2.1；增加 A09、A10 的子 Agent 部分、A18、C07 的 child 部分 | 已完成子结果复用、未完成子独立恢复、父级暂停不取消子执行；Workflow 创建与存量依赖仍明确阻断 |
| S2.3 Workflow | 继承前两段；增加 A10 的 Workflow 部分、A19 | 按原 worker 和操作记录核对；缺失回执或不可恢复资源继续 blocked，不能一键重开整条工作流 |

同一编号中尚未覆盖的入口或分支标为未验证，不能提前计入整体 P0 验收通过。
S1 先验收 C01 至 C10 中不依赖检查点续跑的操作安全部分；S3 再完成 B01 至 B11，并复跑受到新等待逻辑影响的恢复场景。

### F5. 现有规则需要显式更新的地方

现行生命周期合同 D7 要求正常关闭后无 pending permission。
P0-B 拟改为：不遗留活体 waiter；有效逻辑执行的持久待办可以保留。
该规则应与实现同时评审和更新，不能直接绕过。

现有启动恢复会统一中断 Run、过期待办并收尾在途 Workflow。
新路径只处理带完整版本化检查点的 Execution；旧记录不假装可恢复。
现行 terminal 不可逆规则继续成立，新增 suspended 也属于 Run 终态。

应用状态仍归宿主，Node 不获得数据库，Kernel 不获得产品记录。
可靠边界提交属于通用执行合同；业务事实与租户模型不能因此进入 Kernel。

## G P0 怎样验收

### G1. 测试方法

单元测试验证状态转换、摘要绑定、重复命令和版本冲突。
集成测试使用独立 worker 进程和真实临时 SQLite。
在确定的派发/提交边界设置测试暂停点，再强制终止 worker。
重新打开同一数据库，以新的 application owner 恢复。
不要只在同一进程里抛异常模拟崩溃。

外部工具使用可记录真实效果的测试服务。
服务分别提供：按键去重、只读结果查询、无去重无查询三种模式。
验收以外部真实效果次数和保存的回执为准。
测试服务独立于被终止的 worker，其效果记录必须在 worker 重启后仍可查询。
模型使用可控流式 fake client，确定性复现残缺输出、重试与追加输入。

### G2. 必过场景

| 编号 | 故障/操作 | 必须观察到的结果 |
|---|---|---|
| A01 | 输入受理事务中断 | Execution、Input、Run 全有或全无，没有孤立记录 |
| A02 | 模型输出到一半杀进程 | 没有残缺工具被执行；恢复撤换残缺输出，用量不伪装成零 |
| A03 | 完整模型工具批次落盘后杀进程 | 恢复原批次，不重新让模型生成替代工具调用 |
| A04 | 三个并发工具中一个确认、一个未知、一个未派发 | 确认项零次重跑；未知项核对；未派发项重新授权后执行 |
| A05 | 已记录结果、下一模型请求前杀进程 | 恢复复用结果；工具调用与结果配对完整 |
| A06 | 两个客户端同时继续同一版本 | 只有一个新 Run 被受理，另一个取得已有结果或版本冲突 |
| A07 | 同一继续命令重复投递 | 同一 commandId 只有一个继续结果；不同内容明确冲突 |
| A08 | 追加输入受理后、消费前/后分别杀进程 | 输入不丢、不重复消费，原顺序保持 |
| A09 | 子任务确认完成后父进程退出 | 父恢复复用子结果，不重复创建子任务或重置额度 |
| A10 | 子任务或 Workflow worker 未确认即退出 | 先恢复或核对原执行；不可恢复资源进入 blocked |
| A11 | 恢复时工具版本、环境绑定或资源已变化 | 不执行同名替代工具；给出具体 blocked 原因 |
| A12 | 事务在写表后、commit 前失败 | SQLite、read model、事件水位和通知全部回滚 |
| A13 | memory 会话退出并重新打开 | 不出现持久恢复记录，也不自动转为 SQLite |
| A14 | 已结束 Run/Execution 收到迟到 started | 终态不回到 running |
| A15 | 未列出的状态转换、旧版本写入和相同命令重投 | 非法转换拒绝；相同内容返回持久回执，内容不同冲突；并发结果不互相覆盖 |
| A16 | 未确认模型请求后退出，随后记忆、提示词、Skill 或设置变化 | 同一 generation 使用原冻结正文，实际 Attempt 新增；下一 generation 才接受已提交变更 |
| A17 | 冻结正文丢失、摘要不符、环境不符或授权撤销 | 恢复前 blocked；不重新检索或重放原 prompt 掩盖缺失；凭据轮换不改变执行主体 |
| A18 | 父级暂停后子完成，与继续请求并发 | 子结果只结算一次；至多受理一个新父 Run；子输入去重且根树额度不重置 |
| A19 | Workflow 部分 worker 已确认、部分未知时退出 | 沿用原 workflow/step/worker 身份；已确认零次重跑，未知先核对，后续步骤不提前开始 |
| B01 | 等待审批时退出并隔日启动 | 同一有效待办仍可显示和处理；无旧 Promise 被复活 |
| B02 | 批准提交成功、SSE 发布前退出 | 恢复可发现决议，最多受理一次继续，不要求用户重复批准 |
| B03 | 修改参数后提交旧版本批准 | 旧请求不执行；新参数重新走结构、权限和强制检查 |
| B04 | 两端同时批准/拒绝 | 只有首次有效决议成功，工具最多取得一次派发权 |
| B05 | Execution 取消后收到批准 | 不派发工具，待办保持取消终态 |
| B06 | 权限收紧或工具身份改变后继续 | 原批准不能突破新限制；重新审批或 blocked |
| B07 | 请求过期 | 不执行；新请求有新身份，旧记录保留 |
| B08 | 子任务审批由父会话展示 | 原执行主体和存储归属不变，不能跨范围批准 |
| B09 | AskUser 等待期间退出 | 用户问题与回答可恢复，不丢失或重复消费 |
| B10 | 取消分别先于/晚于批准提交或派发权取得 | 取消先提交不派发；已取得派发权的操作保留核对责任，迟到回执只更新审计，不重开 Execution |
| B11 | 参数修改后退出，再恢复并继续模型 | 批次、检查点与新意图一致；串行组及资源重新计算，旧批准失效；模型可看到用户修改和实际执行参数 |
| C01 | 外部成功、客户端收到超时 | 查询找回同一回执，真实效果次数为 1 |
| C02 | 无去重也无查询的工具超时 | unknown → blocked；自动重试次数为 0 |
| C03 | 派发意图已提交但实际调用尚未发生 | 仍按未知窗口核对，不伪造 not_applied |
| C04 | 同一操作安全重试 | operationId 与业务键不变，toolAttemptId 变化 |
| C05 | 相同参数的两次独立正常操作 | 两个不同 Operation 均可执行，不被参数摘要错误合并 |
| C06 | 强制规则抛错、超时或不可用 | 工具真实调用次数为 0 |
| C07 | root、child、runTool、嵌套调用与工具代理分别执行 | 全部经过强制规则和操作记录，没有旁路 |
| C08 | 非合作式工具超时后迟到回执 | 不启动第二次危险调用；回执被核验并保留 |
| C09 | 旧 owner 迟到写入 | 无权推进；新 owner 只核验事实，不重开旧 Run |
| C10 | 结果提交失败 | 不宣布完成，不调用下一步写工具；保留可核对状态 |
| C11 | 覆盖工具、代理或 MCP 仅声明 safeToRetry/提示性 annotations | 不自动取得可恢复写入资格；未知写入不能换工具、改参数或换 Operation 身份重试 |
| C12 | ApplyPatch 多文件部分匹配，或存在并发文件修改 | 逐文件保留证据；整批保持 unknown/blocked，不以摘要相同证明只执行一次或确认未执行 |
| C13 | 只读重读、Sleep 和 JobWait 跨重启 | 已确认结果不重读；新观察有时间标记；沿用原游标和绝对期限，Attempt 与累计预算不清零 |

### G3. 测试放在哪里

| 层 | 拟新增测试入口 |
|---|---|
| core | `packages/core/src/engine/recovery/__test__/checkpoint.test.ts`、`restore.test.ts`；`engine/tools/__test__/operation-execution.test.ts`、`required-policy.test.ts` |
| Kernel | `packages/agent-runtime/src/kernel/__test__/run-suspension.test.ts`、`boundary-delivery.test.ts` |
| Services | `packages/services/src/execution-records/__test__/execution-transactions.test.ts`；`tool-operations/__test__/tool-operation-repository.test.ts`；权限版本与事务回滚用例 |
| Server | `packages/server/src/application/session/execution/__test__/execution-recovery-service.test.ts`；审批重启与参数修改用例 |
| 跨进程 | `tests/agent-integration/__test__/durable-execution-recovery.integration.test.ts`、`durable-tool-operations.integration.test.ts` |
| API 与 Client | `tests/server-client/__test__/execution-recovery.test.ts`、`durable-permissions.test.ts` |

后续阶段的定向检查命令如下，其中包含尚未创建的 S2/S3 测试。S1 已执行的检查见验收记录。

```powershell
pnpm --filter @vykor/core exec vitest run src/engine/recovery src/engine/tools/__test__/operation-execution.test.ts src/engine/tools/__test__/required-policy.test.ts
pnpm --filter @vykor/agent-runtime exec vitest run src/kernel/__test__/run-suspension.test.ts src/kernel/__test__/boundary-delivery.test.ts
pnpm --filter @vykor/services exec vitest run src/execution-records src/tool-operations src/permissions src/database/transactions
pnpm --filter @vykor/server exec vitest run src/application/session/execution/__test__/execution-recovery-service.test.ts src/permissions src/application/recovery
pnpm exec vitest run --config tests/agent-integration/vitest.config.ts tests/agent-integration/__test__/durable-execution-recovery.integration.test.ts tests/agent-integration/__test__/durable-tool-operations.integration.test.ts
pnpm exec vitest run --config tests/server-client/vitest.config.ts tests/server-client/__test__/execution-recovery.test.ts tests/server-client/__test__/durable-permissions.test.ts
```

包发布前再运行 Kernel 依赖检查、SDK 打包检查、类型、架构和文档检查。
数据库结构更新还需生成增量并运行 db:check、数据库测试和打包基线检查。
不要用所有进程正常退出的演示替代上表的强制退出验收。

验收门槛是全部必过场景通过，并且每个 blocked 都能说明原因。
不能靠跳过 unknown、取消全部任务或删除待办让测试变绿。
跨进程结果至少在 Windows、Linux、macOS 的 SQLite 环境核验。
没有相应环境的结果应标为未验证，不能按通过计入。

## H P1 补齐、风险控制与参考

### H1. P1 的明确范围

| 能力包 | 主要设计 | 核心模块 | 验收 |
|---|---|---|---|
| P1-A 结构化交付 | 新增宿主提供的结果 Schema、结构校验和有限纠错；任务结果区分 done/partial/blocked/waiting；用业务核验器确认完成 | agent-contracts 的结果合同、api 的输出约束、core 收尾、Kernel/Server 结果投影 | 根任务和子任务非法结果不进入已验收状态；格式正确但回执不成立也不能算完成 |
| P1-B 结果补读 | 给已保存结果提供稳定 ResultRef、授权、分页、检索、引用生命周期；复用 Shell 日志与现有持久结果 | agent-contracts 的结果引用、core 预算、Node Tool、Services 保存、Server 授权 | 长结果尾部记录在压缩和重启后仍可找到；未授权主体读不到 |
| P1-C 显式任务事实 | 持久化目标、约束、计划步骤、产物、下一步及 verified facts；通过宿主 contribution 注入模型，摘要不写成唯一事实 | Server Goal/Workflow/会话维护、Services、Node compact context | 连续 3 次压缩和恢复后关键约束保持，旧摘要不能覆盖后续确认事实 |
| P1-D 数据与记忆归属 | 以执行主体和资源范围核对员工、workspace、用户与任务访问；scope 仅作为标签；共享与撤销显式处理 | permissions、MemoryRuntime、MemoryManager、Services/Server 资源入口 | 同目录两位员工的未授权记忆、结果、审批不可互读；撤销后继续执行也不能访问 |

P1-A 先支持工具式结构化收尾与统一校验，再为具备能力的模型增加原生输出约束。
Schema 合法只表示结构正确；业务核验器是独立步骤。
如核验不可用，结果保留 partial 或 blocked，不让模型自证成功。

P1-D 不表示 P0 允许忽略现有权限。
P0 始终执行当前权限与强制规则；P1-D 统一多种资源的细分归属与授权入口。

### H2. 主要风险与应对

| 风险 | 设计处理 |
|---|---|
| 外部系统不能确认效果 | 降为 non_replayable；未知时 blocked，不承诺自动续跑 |
| 检查点与事件分开提交 | 使用同一可靠边界批次和具名 Transaction，禁止两条独立写入路径 |
| 工具身份或策略在等待期变化 | 继续前重新绑定、比对意图版本并执行当前限制 |
| 恢复导致费用或子任务额度重置 | 持久记录累计用量、回合、deadline 与根树关系 |
| 存储量随长任务增长 | P0 只在关键边界保存并复用结果引用；结束后按现有 retention 规则保留审计，不删除未决操作 |
| 新版本不能理解旧执行状态 | 明确阻断并保留状态；通过审核后的显式转换处理，不自动猜测 |
| 发布后需要停止新能力 | 停止受理新的持久执行；使用具备新合同的版本完成或终止存量 Execution |

数据库新增状态生效后，不承诺旧二进制可直接接管。
实现时用十倍历史与结果规模核对写入放大，确认未重复保存整份工具正文或启动加载全部检查点。
发布前保留数据库备份，按现有 schema 版本规则运行。
停止功能不能撤回已经发生的外部操作，也不能通过回滚数据库伪造“未执行”。

### H3. 设计依据

本方案复用当前项目事实：

- [框架能力边界](../../agent-framework-capability-boundary.md)：Kernel/Node/Server 分工。
- [生命周期合同](../../agent-lifecycle-contract.md)：终态不可逆、可靠事件和资源收尾。
- [存储架构](../../session-runtime-storage-architecture.md)：共享 Transaction、SQLite/memory 路由、提交后通知。
- [权限流程](../../permission-flow.md)：当前回调、待办与取消语义。
- [核心循环](../../../packages/core/src/engine/query-engine.ts)、[工具管道](../../../packages/core/src/engine/tools/checked-tool-execution.ts)：模型与工具边界。
- [审批控制器](../../../packages/server/src/permissions/permission-controller.ts)、[启动恢复](../../../packages/server/src/application/recovery/startup-recovery-service.ts)：当前仍依赖活体等待并统一过期待办。
- [WorkflowHost](../../../packages/agent-runtime/src/node/workflow/workflow-host.ts)：已有快照、结果和宿主生命周期。
- [事务协调器](../../../packages/services/src/database/transactions/transaction-coordinator.ts)：已有回滚与提交后回调。

外部实现只借鉴机制，不引入它们的依赖：

- [LangGraph runner](https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/pregel/_runner.py)：分别保存任务结果、错误和中断写入。借鉴“确认结果与未决任务分开”，不重建其通用图执行器。
- [Temporal Activity worker](https://github.com/temporalio/sdk-python/blob/main/temporalio/worker/_activity.py)：区分 Activity 身份、派发尝试、心跳与完成回执。借鉴“逻辑操作与实际尝试分开”，不引入 Temporal 服务。

设计依据形成于 2026-10-26。S1 的实现和限定范围验证见[验收记录](../reviews/2026-10-26-s1-tool-operation-safety.md)。
其余阶段仍为方案，不代表完整 P0 能力已实现或验收通过。
