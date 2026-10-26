# 架构、拆分粒度与复杂度审查计划

> 状态：基于当前工作区的审查与改造提案，尚未实施。审查日期：2026-10-26。

## 结论

整体分层有实际用途，不属于需要推倒重来的过度设计。局部存在三类问题：相同规则维护两遍、拆分后通过多层转发接回原处、一个函数集中承担过多决策。优先删除重复路径，随后收拢相关规则；不以减少包数或把所有文件压到某个行数作为目标。

本计划由一名架构师代理独立审查 Server/Runtime/Core，另一名代理检查 Desktop/Client，主代理复核调用点、存储实现与依赖检查。审查基线为 `1ba5452f` 加当前未提交改动，包含正在进行的工具结果补读和结构化交付改造。历史计划中的完成标记不作为本次验证证据。

最小方案是先执行批次一、二，消除已确认的重复实现和测试专用生产分支，其余保持现状。推荐在此基础上逐批处理运行转发和核心决策；不进行整体重写。

## 当前运行流程与合理边界

```text
Desktop / CLI / TUI / 外部渠道
  → Client 把用户动作转换为请求
  → Server 接纳输入，事务保存 Input 和 Run
  → 会话运行队列取得 Agent
  → Agent Runtime 组装本轮能力，Core 顺序调用模型与工具
  → Server 将运行事件写成持久记录
  → 提交后通过 SSE 持续推送，Client 合并完整快照和后续事件
  → 界面呈现结果

SQLite：正式会话、运行、审批和操作事实
Runtime：当前进程中的历史、执行对象、取消信号与资源
界面：草稿、面板、当前选择和待确认操作
```

应保留以下边界：

- Client、Protocol、Server、存储分开，使不同入口共享同一份运行事实，也支持独立发布客户端。
- Kernel 管执行顺序，Node 管文件、进程、插件和连接，Server 管长期记录；独立 Agent SDK 是这层分离的真实消费者。
- `SessionOperationRunner` 串行处理会话状态变更，`SessionRunCoordinator` 排队并取消长任务，两者不能因为都有队列就合并。
- 事务回滚、提交后发布、子 Agent 关闭补偿、未知写操作防重放都有具体失败场景，不应作为“复杂代码”直接删除。
- Desktop 的 IPC 投递确认用于主进程与界面间的背压和恢复，与 HTTP/SSE 断线重连不是同一机制。

## 规模与依赖证据

当前 `apps/*`、`packages/*` 有 38 个工作区包，其中应用 3 个；运行依赖声明形成 125 条内部依赖边，未发现包声明层面的循环。Server 直接依赖 29 个内部包，Agent Runtime 依赖 21 个；这说明它们承担较多组装工作，本身不能证明边界错误，也不代表不存在对象之间的回调环。

按 TypeScript 非测试命名文件统计，Desktop 约 10.7 万行，Server 约 4.3 万行，Services 约 1.5 万行，Agent Runtime 约 1.4 万行，Core 约 0.7 万行。此口径包含组件库、夹具等源码，只用于定位阅读重点，不作为复杂度评分。

`node scripts/architecture-boundaries.mjs` 本次执行通过：`sessionStoreFlatCalls: 104`，`policy exceptions: 0`。它证明现有导入边界检查通过，不能替代行为测试或证明设计已足够简单。

## 主要发现

### 1. Client 同一同步规则维护两遍，已发生行为分叉

证据：`packages/client/src/state/sync.ts:58` 与 `packages/client/src/state/session-sync-controller.ts:120` 都实现读取快照、消费 SSE、补事件和断线重连。Desktop 在 `apps/desktop/src/main/features/session/session-subscription-service.ts:431` 使用前者，TUI 在 `apps/frontend/src/hooks/useServerSync.ts:556` 使用后者。

两种外部调用形式有用途，但不需要两套恢复算法。`sync.ts:65` 传递摘要选项 `partView`，`:135` 使用 60 秒空闲超时；controller 没有对应选项。刷新快照失败时，前者继续尝试事件流，后者再次尝试快照，恢复规则已经不同。

判断：这是最明确、优先级最高的重复实现。应保留迭代器和回调两种接口，让同一套内部同步规则供两者使用。

### 2. 测试便利反过来增加生产分支

证据：`packages/server/src/application/agent/daemon-agent-event-projector.ts:52` 明确说明 `projectorId` 只因测试而可选。生产组装 `packages/server/src/application/daemon-application.ts:646` 始终提供相关标识，但投影器的 `apply():85` 仍选择持久补偿或内存补偿；`:1006`、`:1074` 为内存路径独立维护重试和未结算状态。

判断：可以删除测试专用的生产降级路径；持久补偿本身必须保留。测试应提供完整依赖，不能让生产长期维护两套失败恢复方式。

同类低成本清理是 `packages/services/src/session-runtime/store.ts:352`、`:356`、`:360`、`:386` 的四个 Workflow 纯转发，当前未检索到生产调用。`:366` 的 `appendWorkflowEvent` 还追加聊天事件，不属于纯转发，不能机械删除。

### 3. 运行编排粒度偏碎，转发层没有减少理解成本

证据：`packages/server/src/application/session/execution/session-run-assembly.ts:35` 先声明尚未初始化的对象，再通过闭包互相接线：Admission 调 Engine 排队，Engine 回调 Admission 做执行前检查或恢复被拒的补充输入，Admission 又调用 Control 判断用户工作。`:55` 开始转发到 `engine.runtimeBridge`，后者在 `session-run-engine.ts:21` 再转发给 `SessionRunCoordinator`。

判断：业务职责本身成立，但重复桥接增加跳转次数。应先消除重复的队列能力包装，不强行把所有合法回调改成单向调用，更不新增通用调度框架。

`daemon-application.ts:286` 的构造函数持续到约 1092 行，也反映组装集中。单纯把它搬进一个更大的 Context 不解决问题；只有能连同资源关闭责任一起划清的功能，才适合提取现有目录内的具名组装函数。

### 4. Core 的问题是决策集中，不是抽象太多

证据：`packages/core/src/engine/query-engine.ts:313` 的 `submitMessage` 同时处理历史、记忆、压缩、模型请求、工具执行、纠错、执行轨迹与最后收尾。`:380` 保存多组相互影响的恢复状态，`:803` 至 `:840` 在同一段更新纠错次数、强制收尾与剩余恢复轮数。

判断：要减少需要同时理解的规则，而不是继续拆出若干转发服务。适合把“这批工具结果之后，下一轮允许做什么”提成普通决策函数；模型和工具调用继续保留可顺序阅读的循环。

### 5. Desktop 拆分后仍有隐藏依赖，局部界面职责集中

证据：`apps/desktop/src/main/features/session/session-service.ts:315`、`:323` 先调用 `setEphemeralClient`，`session-operations.ts:550` 再从共享字段取 client。异步分支操作依赖该隐式字段，增加并发和重连时的推理成本；本次未证明已发生线上竞态。`session-service.ts:622` 还通过类型强转穿透连接服务的私有 `clientPromise`，检索到的外部写入用途为测试。

另一个热点是 `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/utility-panel.tsx:464` 的关闭流程，同时协调草稿、多个标签集合、当前标签和外部 store。文件长不是唯一问题，一次关闭需要修改多处状态才是成本。

判断：先显式传入 client，删除测试穿透；工具面板只收拢关闭这一条完整流程，不建设通用面板框架。

### 6. 存储有随全部历史增长的成本，但尚未证明是性能瓶颈

证据：`packages/services/src/database/persistence/read-model.ts:30` 起全量加载 Execution、Operation、Attempt，后续也读取全部消息、正文、Run 和事件。`packages/services/src/tool-operations/tool-operation-repository.ts:211`、`:218` 等路径扫描所有工具操作，再筛选当前需要的记录。操作与尝试还各自保存完整结果，增加驻留数据量，但两者承担不同审计语义，不能直接删除其中一份。

当前代码已减少结果正文搬运，不能重复建议已经完成的优化。`packages/services/src/database/transactions/transaction-coordinator.ts:86` 与 `transaction-journal.ts:7` 已按实际修改记录保留回滚信息，也不能根据旧文档指控“每个事务复制整个数据库”。

判断：这是明确的增长风险，缺少当前性能测量。暂不改存储架构；需要处理时用固定历史样本验证，再仅优化实测热点。

## 分批实施计划

各批独立可合并、可回滚，不依赖后续全部完成。整体涉及超过 8 个文件，必须拆批，避免与当前未提交的结果交付改造混成一个变更。实施前重新核对工作区差异，保留现有修改。

| 批次 | 交付范围和具体做法 | 验收标准 | 风险与力度 |
| --- | --- | --- | --- |
| 一：统一同步规则 | 在 Client 的 `state/sync.ts` 保留唯一快照和重连流程；`session-sync-controller.ts` 保留状态、回调、代次隔离与取消适配。内部流程接收现有初始状态、游标和 reducer，保持全局及单会话两种消费方式；透传 `partView`、空闲超时。会话重连时先成功刷新快照，再恢复事件流；刷新失败保留已有显示状态并重试，不跳过临时正文恢复。 | 两种 API 使用同一套断流、重复事件、全局补洞、快照失败、取消、旧代次迟到结果用例；Desktop 的摘要模式和 TUI 的初始状态续接均保持。公开导出、请求格式和默认超时不变。 | 中等；优先实施。 |
| 二：清除测试专用生产路径 | 投影器的 `projectorId/rootSessionId` 必填，测试补齐结算存储接口，删内存补偿与能力探测；四个 Store 纯转发的测试迁至 `store.workflows` 后删除方法。保留 `appendWorkflowEvent` 的事件发布行为，本批不改它。 | 子任务关闭失败能保存待结算事实，重启恢复后收束；成功/失败事件不重复。Workflow 存储测试通过。 | 小到中等；无数据库格式变化。 |
| 三：明确 Desktop client 依赖 | 分支操作像其余方法一样显式接收 client，删 `ephemeralClient/setEphemeralClient`；通过构造参数注入测试连接依赖，删穿透私有字段的 `clientPromise` 入口。 | 分支创建、worktree、连接重建、关闭流程测试通过；异步操作持有所属调用的 client；不改变 IPC 参数。 | 小；可与批次二分别提交。 |
| 四：减少运行转发 | 调整 `session-run-assembly.ts` 和 `session-run-engine.ts`，让控制与准入共用同一份队列能力对象；删除重复的逐方法包装。保留 Engine 的执行前复核、执行和 Goal 结算；保留插件界面操作通过 `enqueueHostWork` 使用同一会话队列。不合并接纳与长任务队列，不新增包或通用 Manager。 | 相同会话串行、不同会话可并发；排队取消、steer 被拒后重新排队、用户输入优先、审批等待及 Goal 结算保持。插件宿主操作与模型 Run 共用排队、取消和等待语义。完成后的调用链应少一层无规则转发。 | 中等；避免与新的执行安全能力同时改。 |
| 五：收拢核心决策 | 在 `packages/core/src/engine/tools` 放置批量工具结果后的恢复决策函数，输入纠错次数、剩余恢复轮数、轨迹决定和本批结果，返回下一轮控制状态或现有错误；`submitMessage` 只保留执行顺序与事件发出。 | 成功与失败混合批次、切换工具或失败类别、达到纠错上限、子任务最后收尾、取消期间的结果保存保持；失败恢复不重放已执行工具，用量不重复结算。 | 中等；行为等价后停止，不继续抽象成插件流水线。 |

批次四允许保留业务必需的闭包回调，不以“消除全部回调环”为验收目标；消费者还包括 `packages/server/src/application/session/plugins/plugin-app-operation-service.ts:93`，不能只检查 Admission/Control。批次五只搬出一个决策边界，不同时改重试次数、预算、压缩或历史规则。

后续候选单独排序：工具面板关闭流程收拢、Daemon 按功能组装与关闭配对、历史规模优化。它们不阻塞前五批，也不因本计划存在而自动启动。存储优化的前置证据由实施者用固定样本补齐：分别用 100、1,000、10,000 个历史 Run，固定每 Run 的消息、事件和结果大小，记录启动耗时、内存、当前会话结果查询及危险工具准入耗时；不调用真实模型，不计入用户数据。只有热路径显著随无关历史增长时，才增加针对该查询的索引；只有正文主导内存时，才另提按引用读取正文的存储方案。

## 验证入口与完成条件

本次是审查，未运行行为测试或真实模型。以下是实施时按批次选择的入口，不应在每批重复运行整个仓库：

- 批次一：Client `state/__test__/sync.test.ts`、`session-sync-controller.test.ts`；Desktop `session-subscription-pump.test.ts`；TUI `apps/frontend/src/hooks/useServerSync.test.tsx`。
- 批次二：Server 的 `daemon-agent-event-projector.test.ts`、`projection-settlement-recovery.test.ts`、`child-mode-recovery.integration.test.ts`；Services 的 `session-runtime/__test__/store.test.ts`。
- 批次三：Desktop `session-operations-worktree.test.ts`、`session-service.test.ts`、`session-service.lifecycle.test.ts`、`daemon-connection-service.lifecycle.test.ts`。
- 批次四：Server `session-run-assembly.test.ts`、`run-admission-service.test.ts`、`run-control-service.test.ts`、`session-run-engine.test.ts`、`session-run-executor.test.ts`、`runtime/__test__/run-coordinator.test.ts`、`session-plugin-app-action.test.ts`、`session-plugin-app-conversation.test.ts`，以及 Goal 定向回归。
- 批次五：Core `tools/__test__/tool-input-corrections.test.ts`、`engine/__test__/recovery-evidence.test.ts`、`execution-profile.test.ts`、`model/__test__/model-retry.integration.test.ts` 与结果取消交付用例。

定向测试命令从仓库根运行：

```powershell
# 批次一
pnpm --filter @rzx/client exec vitest run src/state/__test__/sync.test.ts src/state/__test__/session-sync-controller.test.ts
pnpm --filter @vykor/desktop exec vitest run src/main/features/session/session-subscription-pump.test.ts
pnpm --filter @vykor/frontend exec vitest run src/hooks/useServerSync.test.tsx
# 批次二
pnpm --filter @vykor/server exec vitest run src/application/agent/__test__/daemon-agent-event-projector.test.ts src/application/agent/__test__/projection-settlement-recovery.test.ts src/application/agent/__test__/child-mode-recovery.integration.test.ts
pnpm --filter @vykor/services exec vitest run src/session-runtime/__test__/store.test.ts
# 批次三
pnpm --filter @vykor/desktop exec vitest run src/main/features/session/session-operations-worktree.test.ts src/main/features/session/session-service.test.ts src/main/features/session/session-service.lifecycle.test.ts src/main/features/session/daemon-connection-service.lifecycle.test.ts
# 批次四
pnpm --filter @vykor/server exec vitest run src/application/session/execution/__test__/session-run-assembly.test.ts src/application/session/execution/__test__/run-admission-service.test.ts src/application/session/execution/__test__/run-control-service.test.ts src/application/session/execution/__test__/session-run-engine.test.ts src/application/session/execution/__test__/session-run-executor.test.ts src/runtime/__test__/run-coordinator.test.ts src/application/session/goals/__test__/session-goal-service.test.ts
pnpm --filter @vykor/server exec vitest run src/application/session/plugins/__test__/session-plugin-app-action.test.ts src/application/session/plugins/__test__/session-plugin-app-conversation.test.ts
# 批次五
pnpm --filter @vykor/core exec vitest run src/engine/tools/__test__/tool-input-corrections.test.ts src/engine/__test__/recovery-evidence.test.ts src/engine/__test__/execution-profile.test.ts src/engine/model/__test__/model-retry.integration.test.ts src/engine/__test__/tool-result-reading.integration.test.ts
```

测试文件迁移时同步调整入口，新的回归放入所属模块的 `__test__/`。每批运行受影响包的 `check-types`；改变 Client 公开面时增加 `pnpm check:client-api`，改变 Server/Client 联合契约时增加 `pnpm check-types:server-client`。如触及 Agent Runtime 的发行入口，应先构建该包，再检查消费方，避免用过期声明文件判断类型结果。

每批收尾运行 `node scripts/architecture-boundaries.mjs`、`pnpm check:retired-ui`、`pnpm check-docs` 和 `git diff --check`。涉及目录移动时同步导入、公开入口、README、当前手册和精确历史引用。桌面样式由用户查看，不搭预览或截图。

完成应以删除了哪套重复规则、状态是否仍由唯一负责人持有、错误和取消路径是否保持来证明，不以新增类数、拆文件数或测试数量证明。前五批保持现有协议、SQLite 格式与外部 SDK 入口，无新服务、依赖、环境变量或凭据需求，回滚只需撤销对应代码变更，不改用户数据。

本计划假设继续保留多端入口、独立 SDK 和持久运行记录。若产品明确放弃这些能力，相应边界才值得另行收缩；在此之前合包不能消除这些职责。
