# 架构、拆分粒度与复杂度审查计划

> 状态：批次一至五已完成实施、验证和分批独立审查（2026-10-27），并在拉取最新 `main` 后完成合并前复核、按五批独立提交。审查日期：2026-10-26；下文旧审查基线与规模数据保留为取证背景，不是回退目标。首次实施与后续整合记录见文末。

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

原审查阶段未运行行为测试或真实模型。以下是实施时按批次选择的入口；本次实施结果见文末，不应在每批重复运行整个仓库：

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
pnpm --filter @vykor/frontend exec bun test src/hooks/useServerSync.test.tsx
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

## 实施记录（2026-10-27）

本节记录首次交付时的状态，后续提交与整合见下一节。实际工作区为 `E:/code/openharness-ts`，分支为 `codex/architecture-simplification`。请求中的 D 盘路径在当前环境不存在；首次实施基线 HEAD `748c9de1` 已包含计划提交 `758ac024`。开始时暂存区和已跟踪文件均无未提交修改；原有未跟踪 `plugins/` 未修改、未清理。没有回退到旧审查基线，首次交付时尚未提交或推送。

五批按顺序分别实施、验证并通过独立审查：

1. **统一同步规则。** `sync.ts` 保留唯一快照、补洞与重连算法，控制器只适配缓存、回调、代次和取消。会话刷新快照成功后才重新开流；连续快照失败保留已有显示状态。保留两接口原有默认超时差异、摘要、初始缓存与游标。新增共用回归覆盖断流、重复、快照失败、各异步阶段取消及旧订阅迟到；Desktop IPC 投递确认未改。Client 定向 **50/50**、全套 **218/218**，Desktop pump/coalescing/IPC **28/28**，TUI **23/23**。
2. **删除测试专用生产路径。** 投影身份改为必填，删除内存待补偿字段、内存重试及持久能力探测；测试接入真实 SQLite 结算依赖。四种子任务关闭结果均验证写入失败、重启恢复和重复事件。删除 `saveWorkflowRun/loadWorkflowRun/listWorkflowRuns/listWorkflowEvents` 四个纯转发，保留类型导出及 `appendWorkflowEvent` 的聊天事件发布。Server **56/56**，Services **70/70**。
3. **显式传入 Desktop client。** 分支操作持有调用参数中的 client，删除共享临时 client 和穿透连接私有 Promise 的入口；测试改为构造依赖注入。新增三个先失败后通过的交错、迟到连接回归；默认连接、IPC 参数和生命周期保持。Desktop **39/39**。
4. **减少队列转发。** 控制和准入共用一份队列能力对象，删除组装处 **12 个**逐方法纯转发；其余直连方法绑定原 Coordinator。保留接纳时抢占、执行前复核、事件发布、steer 拒绝恢复和 Goal 结算。插件宿主操作仍与模型共用排序、取消和等待，等待包含 Goal 结算；状态变更串行器与长任务队列未合并。Server **238/238**，含四项新增表征回归及插件、Goal 路径。
5. **提取恢复决策。** `tools/tool-batch-recovery.ts` 的普通函数返回下一轮状态或原有错误，状态仍归本次 `submitMessage()`。保留结果保存、交付、失败/取消、成功结束运行、纠错上限、轨迹观察、恢复额度、轮数与后续输入的顺序。三个顺序表征在提取前已通过；提取后 Core **209/209**，覆盖混合结果、切换工具/失败种类、阈值、取消/迟到回执、子任务收尾、补读与用量结算。

收尾联合类型检查发现第二批还遗漏了三个仓库级测试构造。已补齐 `tests/server-client/model-retry-flow.test.ts`、`tests/server-client/tool-progress-projection.test.ts` 和 `tests/desktop-integration/__test__/session-write-generation.test.ts` 的实际投影及根会话身份，沿用真实存储，不放宽生产必填要求。全仓核实 37 个构造均已完整；补跑跨包测试 **29/29**、联合类型检查通过。这是本次遗漏并已修正，不归为原有问题。

上述定向命令另补以下入口：批次一的 `src/main/features/session/session-subscription-service.coalescing.test.ts`、`ipc.test.ts`；批次二的 `src/application/agent/__test__/tool-lifecycle-identity.test.ts`；批次三的 `src/main/features/session/__test__/session-branch-client.test.ts`；批次五的 `src/engine/tools/__test__/tool-batch-recovery.test.ts`、`operation-execution.test.ts`、`checked-tool-execution.test.ts`、`tool-discovery.integration.test.ts`、`src/engine/trajectory/__test__/` 及 `src/engine/__test__/integration.test.ts`。所有测试仍使用上方对应包的 `pnpm --filter ... exec vitest run`；TUI 文件导入 `bun:test`，因此修正为上方 Bun 原生入口，没有改测试框架或削弱检查。

每批受影响包的类型检查和 `node scripts/architecture-boundaries.mjs`、`pnpm check:retired-ui`、`pnpm check-docs`、`git diff --check` 均通过。Desktop 实际入口为 `pnpm --filter @vykor/desktop typecheck`，包含 node、web、MCP SDK 三项。收尾还执行：

```powershell
pnpm --filter @vykor/agent-runtime build
pnpm -r --workspace-concurrency=2 --filter @rzx/client --filter @vykor/core --filter @vykor/services --filter @vykor/server --filter @vykor/frontend check-types
pnpm --filter @vykor/desktop typecheck
pnpm check:client-api
pnpm check-types:server-client
pnpm --filter @vykor/frontend exec bun test src/hooks/useServerSync.test.tsx
pnpm exec vitest run --config tests/server-client/vitest.config.ts tests/server-client/model-retry-flow.test.ts tests/server-client/tool-progress-projection.test.ts
pnpm exec vitest run --config tests/desktop-integration/vitest.config.ts tests/desktop-integration/__test__/session-write-generation.test.ts
```

以上收尾命令均退出 0；重建后 TUI 仍为 **23/23**，Client API 消费者类型、66 项边界检查和 4 项公开 API 测试通过。Core 会打入 Agent Runtime 发行文件，因此先重建，再检查消费方和真实 daemon，避免陈旧产物掩盖结果。

环境中原有的 Agent Runtime 生成文件陈旧、两个已声明 DiceBear 依赖未安装，分别通过构建和冻结锁文件安装恢复，未改依赖声明、版本或锁文件。原有 React `act(...)` 测试警告及审计输出保留，没有修改无关测试来消除输出。首次交付没有新增未解决的生产问题；当时验证范围为计划定向测试和受影响类型，尚未运行全仓完整测试，后续完整尝试及环境限制见下一节。

协议、SQLite 格式、外部 SDK 入口、权限及来源校验保持；持久补偿、启动恢复、事件去重、IPC 投递确认、两个串行器、恢复阈值 8/5/2、重试、预算、压缩和历史规则继续保留。工具结果补读、结构化交付及防重复执行未删除。没有新增 Manager、服务、框架、依赖或配置，也未实施工具面板整理、Daemon 组装拆分或存储性能优化；桌面未搭预览、未截图。

## 最新 main 上的合并前复核（2026-10-27）

用户随后授权先 pull、重新 review，无问题则合并到 `main` 并推送。先单独备份本任务 36 个文件，排除原有 `plugins/`，再执行 `git pull --ff-only origin main`，基线从 `748c9de1` 快进到 `3ac9f7aa`。恢复五批改动没有文本冲突；重点复核了自动合并的五个文件，确认最新主线的交付元数据清除、真实工具调用登记、可信只读身份、人工核对入口和相关说明均完整保留。

独立源码审查未发现 Critical、Important 或需要本轮修复的 Minor。代码按五批分别提交，保留独立回滚边界：`ec8cad24`（同步）、`0a54aaaa`（持久结算）、`2a92965d`（Desktop client）、`75c75941`（运行队列）、`8cecb9a9`（恢复决策）。默认预提交钩子始终开启，各批提交前均再次通过 `pnpm check-types`；暂存检查发现并删除了新 Core 文件末尾一个多余空行，没有改变执行行为。

在这份最新主线与五批改动的组合上，重新执行以下验证：

- `pnpm --filter @vykor/agent-runtime build`：退出 0。
- `pnpm test`：退出 1，包任务 71/73 成功；只有三项测试在创建文件符号链接的准备阶段因 Windows `EPERM` 失败。两项位于 `packages/server/src/application/visual-tools/__test__/daemon-image-to-text-tool.test.ts`，一项位于 `packages/plugins/src/components/__test__/app-resources.test.ts`。对应测试和产品文件相对 `origin/main` 没有差异；只导入 Node 标准库的独立临时文件探针也复现相同 `EPERM`，因此归为本机权限限制，不归为架构简化回归。没有跳过、放宽或修改这些测试，完整测试不记为全绿。
- 同次包测试中，Client 219、Core 494、Services 624、Runtime 794、Desktop 2822、CLI 243 项通过；Server 1947 项通过，另有上述两项环境失败。
- 因包任务失败而未自动进入的后续链逐项补跑：`pnpm test:scripts` 为 32 项通过；`pnpm test:agent-integration` 为 60 项通过；`pnpm test:desktop-integration` 为 1 项通过；`pnpm test:server-client` 为 124 项通过，均退出 0。`pnpm test:execution-integration` 退出 0，但 4 项 Windows 内 Linux 环境（WSL）用例因本机不可用按原条件跳过，未计为通过。
- `pnpm check-types`：72/72 个任务成功，并完成 Server/Client 联合类型检查，退出 0；`pnpm --filter @vykor/desktop typecheck` 的 node、web、MCP SDK 三项也全部通过。
- `pnpm check:client-api`：消费者类型、66 项 Node 检查和 4 项公开 API 测试通过。
- `node --test packages/agent-runtime/scripts/__test__/tool-identity-bundle.test.mjs`：实际发行产物的三项身份检查通过，确认可信只读与结果读取身份没有在打包后失效。
- `node scripts/architecture-boundaries.mjs`：104 个存储平铺调用、0 个策略例外；`pnpm check:retired-ui` 无错误；`pnpm check-docs` 的 4 项策略测试与 911 个 Markdown、403 个模块 README 通过；`git diff --check` 和各批暂存差异检查通过。

合并结论依据独立源码审查、完整类型和上述运行验证；三项文件链接权限失败与四项 WSL 跳过作为已证实的环境限制保留，没有通过修改无关文件或削弱检查来取得通过。本次提交范围仍只有五批代码、受影响测试与文档，原有 `plugins/` 未纳入提交。

## Windows 文件符号链接权限修复（2026-10-27）

用户要求继续解决上一节三项文件链接权限失败，明确不允许跳过用例或削弱断言。先重跑原测试，确认插件一项、ImageToText 两项均在 `fs.symlink()` 创建真实文件链接时被 Windows 拒绝，尚未进入业务断言；独立 Node 标准库探针也稳定返回 `EPERM`。本机当时未设置开发者模式开关，普通进程也没有创建符号链接的系统特权。

用户明确授权开启开发者模式，首次 Windows UAC 未完成，按用户要求重新发起后成功。只设置本机 `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock` 下的 `AllowDevelopmentWithoutDevLicense=1`，未启用设备发现或远程调试。随后确认测试进程仍为非管理员，并实际创建文件链接，检查 `lstat().isSymbolicLink()`、最终目标路径及通过链接读取目标更新后的内容，全部成功；临时探针文件已清理。

原测试、断言和生产代码均未修改。仓库根 README 补充 Windows 测试的权限前置条件，不能用普通文件、硬链接、模拟文件系统或跳过来替代真实文件符号链接。

定向重跑 `pnpm --filter @vykor/plugins exec vitest run src/components/__test__/app-resources.test.ts` 为 **6/6**，`pnpm --filter @vykor/server exec vitest run src/application/visual-tools/__test__/daemon-image-to-text-tool.test.ts` 为 **19/19**，均退出 0、无跳过，原三项失败全部实际执行通过。

随后先运行 `pnpm exec turbo test --force --continue=always --concurrency=2`，**73/73 个包任务成功，0 个缓存命中**，确认环境修复后全部重新执行；其中 Plugins **104**、Server **1949**、Desktop **2822** 项通过，原失败的两个文件也在全仓测试中再次通过。再运行根入口 `pnpm test`，复用这轮成功的包任务，并完整执行后续链，**退出 0**：脚本 **32**、Agent 集成 **60**、Desktop 集成 **1**、Server/Client 集成 **124** 项通过。

全仓已有的条件跳过未改：包测试共 **19** 项（Sandbox 4、Plugins 1、Hooks 2、Tools 3、Agent Runtime 9），执行环境集成另有 **4** 项 WSL 用例按原条件跳过。它们不计为通过；本次三个文件链接用例均没有跳过，也没有新增条件、放宽超时或改动检查命令。根 README 和本记录为仅有的已跟踪文件改动，原有 `plugins/` 继续保留且不纳入提交。

`pnpm check-docs`、`pnpm check:retired-ui`、`node scripts/architecture-boundaries.mjs` 和 `git diff --check` 均通过。文件链接权限问题在本机已修复，无需修改产品协议、存储格式、依赖或测试实现。

## 原 23 项跳过的补齐与实际执行（2026-10-27）

本轮从 `981bd24f` 继续，开始时已跟踪文件与暂存区干净，原有未跟踪 `plugins/` 保留。23 项均已在对应环境实际执行通过，没有无法运行项；Windows 单端仍保留四项平台跳过，它们已在 Linux 实际补跑，不计入 Windows 通过数。没有修改生产代码、删除平台边界、放宽超时或减少断言。

### 逐项结果

官方源码原先未通过 `VYKOR_OFFICIAL_PLUGINS_DIR` 显式提供。干净检出 `rzx007/vykor-plugins` 的固定提交 `4adc372eca251feeb4ed6199f184e98ed8283a43`，knowledge-work 为 1.1.2，office-work 为 0.12.4。仅对测试子进程提供路径，不使用根目录原有 `plugins/`；knowledge-work 离线构建校验通过，办公入口用例只需已有技能文件，无需下载 Office 引擎。

1. [办公入口](../../../packages/plugins/src/__test__/office-work-entry.test.ts)：主 Agent 和四项官方技能入口，已通过。
2. [研究写作插件](../../../packages/agent-runtime/src/node/plugins/native-tools/__test__/knowledge-work.test.ts)：真实工具注册与 WebFetch 来源记录，已通过。
3. 同文件：两位专家与它们引用的技能解析，已通过。
4. 同文件：来源与引文绑定校验，已通过。
5. 同文件：缺失证据、未知来源和被修改引文的逐条报告，已通过。
6. 同文件：本地材料引用不擅自读取，已通过。
7. 同文件：拒绝歧义的来源与断言身份，已通过。
8. 同文件：拒绝带额外字段的输入，已通过。
9. 同文件：拒绝超过 24,000 字符的来源文本，已通过。
10. 同文件：拒绝空引文，已通过。

下面五项原先写死 `C:/Program Files/Git/bin/sh.exe`，而本机 Git 实际安装于 D 盘。[公共测试帮助代码](../../../tests/helpers/README.md)现在实际执行候选 Shell，支持 PATH、Git 的实际安装位置及默认位置。保留原脚本和所有断言；文件操作的 Linux 分支仍强制执行，缺少或损坏 `/bin/sh` 时失败。

11. [WSL 脚本边界](../../../packages/sandbox/src/environment/__test__/wsl-process-boundary.test.ts)：保留导出的 HOME 和 SHELL，已通过。
12. 同文件：未导出 HOME/SHELL 时从账号信息恢复 HOME，已通过。
13. 同文件：通过外部进程组终止命令执行取消监督脚本，已通过。
14. [文件操作](../../../packages/tools/src/file/__test__/operations.test.ts)：可搜索祖先下缺失父目录与目标的错误分类，已通过。
15. 同文件：并发出现目标目录时不把原子替换文件移入目录，已通过。

下面三项验证 POSIX 行为，Windows 的 cmd 和文件权限模型不能原生验证同一断言。在独立 Debian 文件系统中按现有锁文件安装 Node 依赖，使用与宿主相同的 Node 24.10.0 和 pnpm 10.30.2，原文件分别为 Hooks 43/43、文件操作 21/21，通过且无跳过。

16. [Hooks](../../../packages/hooks/src/__test__/index.test.ts)：带单引号和空格的 JSON 作为完整单个参数交给子进程，已通过。
17. 同文件：参数中隐藏的命令替换、分号与引号不执行注入命令，已通过。
18. [文件操作](../../../packages/tools/src/file/__test__/operations.test.ts)：原子替换保留原文件 `0755` 权限位，已通过。

本机已有 WSL 2 和内核，原先没有 Linux 发行版。通过 WSL 官方命令安装 Debian 13，补齐 Bash、ripgrep、procps、util-linux，并完成首次账号初始化，使用锁定口令的普通测试账号 `vykor-test` 作为该新发行版默认用户。真实终端原先停在首次用户名提示，初始化后正常退出和中断；没有修改终端实现。

19. [真实 WSL 集成](../../../tests/execution-node/wsl.e2e.test.ts)：cwd、环境变量、退出码和文件读写，已通过。
20. 同文件：AbortSignal 取消长任务且无残留进程，已通过。夹具的 `exec -a` 需要 Bash；原 Debian `/bin/sh` 为 dash，提前退出后又错过迟到注册的退出监听。现改用 Bash、立即监听退出、取消前断言任务仍存活，保留非零退出、5 秒取消时限、进程残留检查和 10 秒总超时。
21. 同文件：真实搜索与后台 Shell，已通过。
22. 同文件：stdio MCP 与真实交互终端的输出、退出和中断恢复，已通过。四项完整原命令 `pnpm test:execution-integration` 为 4/4、无跳过。

23. [SRT 沙箱](../../../packages/sandbox/__test__/e2e/srt.e2e.test.ts)：真实受限 Shell 命令，已通过。在 Debian 内安装固定 `@anthropic-ai/sandbox-runtime@0.0.81`、bubblewrap 和 socat，实际隔离探针及原 SRT 端到端测试均成功，未用模拟隔离替代。Linux 专属两个文件及此项合计 65 项通过、0 跳过。

安装真实 SRT 后，Hooks 原有的“运行器不可用时阻止命令”用例暴露了隐含环境假设。该用例现在显式指定隔离临时目录中不存在的运行器，继续走真实不可用分支，保留阻止执行的断言；在同时安装了真实 SRT 的 Linux 中完整 43 项也全部通过。

独立审查发现仅把官方插件路径加入 Turbo 缓存不足以跟踪同路径的外部源码更新。已为 Plugins 和 Agent Runtime 两个测试任务显式传入已有变量、禁用结果缓存，并保留构建依赖；公共测试帮助代码纳入缓存输入。审查复核通过，无剩余阻断，不新增产品依赖、配置项或生产服务。

收尾先显式提供上述固定官方源码路径，运行 `pnpm exec turbo test --force --continue=always --concurrency=2`，**73/73 个任务成功、0 个缓存命中**；再按最终配置运行完整 `pnpm test`，**退出 0**，两个外部插件测试包再次实际执行。Windows 包测试现为 Sandbox **41 通过/1 平台跳过**、Plugins **105/105**、Hooks **41 通过/2 平台跳过**、Tools **650 通过/1 平台跳过**、Agent Runtime **803/803**；这四项保留的平台标记均已有本节 Linux 实际通过的证据。脚本 **32**、WSL **4**、Agent 集成 **60**、Desktop 集成 **1**、Server/Client 集成 **124** 项全部通过，不再有 WSL 环境跳过。

`pnpm check-types` 为 **72/72** 个任务成功，Server/Client 联合类型也通过；`pnpm check-docs` 为 **912** 个 Markdown、**404** 个模块 README 通过。`pnpm check:retired-ui`、`node scripts/architecture-boundaries.mjs` 与 `git diff --check` 通过。独立审查再次核对逐项记录与原始日志，一致且无过度声称；原有未跟踪 `plugins/` 未修改、未清理、未纳入提交。
