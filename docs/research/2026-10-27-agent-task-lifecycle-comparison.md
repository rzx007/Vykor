# 子代理与工作流生命周期调研及架构改进建议

> 状态：源码调研与待评审的架构建议。研究日期：2026-10-27。本文没有宣称建议已经实现。

> 后续方案：已在 `dc654b8a752ddacf659cada5394e473bcc14dad5` 核对相关代码，任务生命周期模块相对本文基线没有变化。明确推荐和文件级步骤以[共同执行核心方案](../superpowers/specs/2026-10-27-shared-execution-core-design.md)及[实施计划](../superpowers/plans/2026-10-27-shared-execution-core.md)为准。下文架构与分阶段建议保留为调研时的初步推导，不能与新方案并列实施；源码观察与验证记录仍按原版本解释。

OpenHarness 应把四件事分开：保留子会话、执行一轮任务、保存结果、观察和控制任务。当前几处边界把它们绑在一起，形成了“旧任务登记冲突影响新任务读取”“完成的会话继续占执行名额”“结果已经产生却一直显示运行中”的问题。

建议保留现有 Agent、Workflow、后台 Shell 和 Terminal 执行器，改造它们的组装、运行身份和收尾约定。运行状态继续由各领域执行器负责，SQLite 继续保存产品记录，Jobs 负责观察与路由。需要调整的是这些角色之间的约定。

## 调研范围与证据

四个本地参考仓库均按现有检出版本阅读，没有拉取更新。Codex 从官方仓库获取当日快照。各仓库调研时工作区均干净。版本不同会改变下文的实现细节。

| 项目 | 提交 | 本次实际阅读范围 |
| --- | --- | --- |
| OpenHarness | `45e30ad25d66a53b4aff2e8fb2b4960910e31bfc` | AgentChildManager、Jobs 组装与控制、Workflow runner、daemon 投影与相关测试 |
| Codex | `6fe77fc12346591b8037a8704640e40196b19044` | 官方 Rust 源码中的 AgentControl、Registry、MAv1/MAv2、运行许可、实例卸载和测试 |
| ZCode | `0ae51b1ce57c8b51ad515e20f693e9e0c35f4282` | 普通 Agent、旧 Workflow、动态 Workflow 三条链路 |
| Synara | `6f54f53c66348a9a19c65779daaabd96113773eb` | 应用会话创建与等待、ProviderService、Hub worker、Claude SDK 任务适配 |
| OpenCode | `1ddb0873aee50d209d1a8d7f91b89c5daf692d49` | 已接线的 TaskTool 与 BackgroundJob；另外阅读 V2 SessionRunCoordinator |
| MiniMax Code | `564e9166d81f87b0b767b005e4779d4697b512be` | 已接线的 LocalBackgroundTaskService、Task runner、Turn 接入、收尾与启动核对 |

MiniMax Code 的根说明明确把该仓库定义为经过审查的公开源码投影；其 release 元数据标记产品基线 `0.4.12`，上游源码版本 `9b9885e42a3cf1a3df1cfa52a46e4fdb034cfcee`。不能据此推断完整内部产品的行为。见 [AGENTS](D:/code/personal-project/minimax-code/AGENTS.md:3) 和 [release 元数据](D:/code/personal-project/minimax-code/release/extraction.json:1)。

本次没有运行参考项目的模型、服务或测试。引用的参考测试表示已阅读其实现和断言。OpenHarness 执行了两个定向测试文件，共 39 个测试通过，并另外做了不修改文件的最小复现。

## OpenHarness 当前问题

### 任务来源发生重叠，指定任务控制却依赖全量列表

`resolveDefaultAgentCapabilities` 无论是否注入外部后台 Shell，都创建一个能枚举本地 Shell 的 LocalAgentJobHost；之后再把外部 Shell 的 Jobs 加入同一个 CompositeAgentJobHost。daemon 注入的后台 Shell 和本地 host 实际看到同一个进程执行，产生重复归属。

Composite 的未缓存读取先枚举所有来源，再建立归属索引。任何一个 ID 被两个来源声明都会抛错。因此读取 child A 时，旧 Shell B 的冲突也能使 A 的读取和取消失败。

证据：[组装入口](../../packages/agent-runtime/src/node/capabilities/default-agent-capabilities.ts#L116)、[本地进程枚举](https://github.com/rzx007/Vykor/blob/f40f276b/packages/agent-runtime/src/node/jobs/local-agent-job-host.ts#L172)、[daemon 注入](../../packages/server/src/application/daemon-application.ts#L530)、[全量发现与冲突](https://github.com/rzx007/Vykor/blob/f40f276b/packages/jobs/src/composite-agent-job-host.ts#L55)。

目标会话最后一轮中，同一旧 Shell 的来源冲突出现 10 次。最小复现也确认：两个来源共同声明旧任务 B，读取和取消另一个唯一存在的 child A，同样抛出 B 的冲突。

### 活跃额度实际统计的是未关闭会话

现有文档明确规定：starting、running、idle、suspended、closing 都消耗 `maxActiveChildren`，直到 close 才释放。默认上限为 8。因此它不是简单的“结束时漏调 release”，而是额度本来就围绕长期保留的子会话设计；一次性 Workflow worker 却沿用这套保留规则。

运行完成后只变 idle 并安排 5 分钟后 suspend；suspend 释放实例但不退会话额度。成功 Workflow 没有关闭这些 worker，连续顺序任务也能耗尽上限。

证据：[现有预算约定](../agent-child-session-flow.md#child-预算防止无限叫人)、[预算登记](../../packages/agent-runtime/src/kernel/children/child-registry.ts#L54)、[结束与挂起](../../packages/agent-runtime/src/kernel/children/child-agent.ts#L720)、[真正释放的位置](../../packages/agent-runtime/src/kernel/children/child-agent.ts#L937)。

最后一轮的验收任务报 `activeChildren: current 8, limit 8` 时，之前的子运行已经结束。这个现象与当前实现及文档一致，需要修改额度和保留策略之间的约定。

### 结果观察误把 Promise 对象当作运行身份

ChildHandle 的 `result` getter 每次生成一个包装后的新 Promise。LocalAgentJobHost 却把 Promise 引用是否相同当作“同一轮运行”的判断，并用它拒绝迟到回调。实际 handle 的 getter 与观察器的假设不匹配，结果会一直被丢弃。

最小复现使用同样的 getter 行为：底层结果已经是 completed，并包含文本，连续三次 read 仍得到 `running` 和空输出。该复现证明本地观察路径存在独立缺陷；它不证明目标会话所有空输出都由这一处造成。

证据：[result getter](../../packages/agent-runtime/src/kernel/children/child-agent.ts#L977)、[观察器的引用比较](https://github.com/rzx007/Vykor/blob/f40f276b/packages/agent-runtime/src/node/jobs/local-agent-job-host.ts#L324)。

### 继承配置没有在统一边界得到具体模型

角色加载器保留字符串 `inherit`，Agent 工具继续传给 child，子配置用空值合并选择模型。由于 `inherit` 不是空值，最终成为 provider 收到的模型名。插件审核代理因此启动失败。

证据：[角色解析](../../packages/coordinator/src/definitions/loader.ts#L116)、[Agent 创建](../../packages/tools/src/agent/agent-tools.ts#L123)、[child 配置](../../packages/agent-runtime/src/node/children/child-agent-options.ts#L59)。

这属于实现错误，但应在统一的子运行配置解析处解决，使 Agent、Workflow、插件角色和系统审核共用一条规则。

### 现有测试验证了局部约定，漏了真实组合

Composite 的 23 个测试通过，包括“两个来源声明同 ID 应拒绝”；LocalAgentJobHost 的 16 个测试也通过，但其 child 测试使用固定 Promise 属性，真实 handle 使用每次返回新 Promise 的 getter。daemon 后台 Shell 测试分别检查注入的 host，没有经过完整的默认 Node 组装再用模型侧 JobRead 读取。

证据：[Composite 测试](https://github.com/rzx007/Vykor/blob/f40f276b/packages/jobs/src/__test__/composite-agent-job-host.test.ts#L23)、[固定 Promise 测试替身](https://github.com/rzx007/Vykor/blob/f40f276b/packages/agent-runtime/src/node/jobs/__test__/local-agent-job-host.test.ts#L376)、[daemon host 测试](../../packages/server/src/application/__test__/durable-agent-application.test.ts#L513)。

这些测试仍有价值。缺的是跨边界验证：真实框架 handle、真实组装工厂和真实控制入口必须一起运行，模型请求可以用可控的假实现替代。

## 五个参考项目怎样处理

| 项目与适用路径 | 已证实的机制 | 最适合借鉴 | 不能直接推出的能力 |
| --- | --- | --- | --- |
| Codex MAv2 | 注册身份、运行许可、常驻实例分别管理；按 thread ID 定点访问；闲置实例可卸载 | 保留历史与占用运行资源分离 | 不代表 MAv1 同样计数，也不代表任意中断实例都能恢复 |
| ZCode 动态 Workflow | 引擎拥有终态，driver 拥有 actor runtime；三种终态走同一出口；按在飞 ask 计数 | 成功路径也完整收尾，资源由创建者释放 | 旧 Workflow 没有同等关闭链；进程内表不构成跨进程唯一执行保证 |
| Synara 应用会话与 Hub | 等待固定 thread 与 turn；写回检查执行代次；Hub 名额与保留会话分离 | 稳定运行身份、迟到结果隔离、定点控制 | SDK Workflow 仍依赖外部实现；批量等待缺失一个目标可整体失败 |
| OpenCode 当前 Task 与 BackgroundJob | 按 ID 查 Map；执行 token 隔离旧回调；保留终态同时关闭执行 scope | 结果保留与执行资源释放分离 | 后台登记只在进程内；不能把尚未迁入的 V2 能力算到 Task 上 |
| MiniMax 实际 LocalTask 链路 | 先持久登记，再启动具体 Turn；前台、后台和 append 共用终态写入；活跃集合随执行结束清除 | 单一终态出口、精确 Turn 取消、owner 死亡后的状态核对 | 活跃集合不是完整限流器；canceled 标签也不总能证明底层清理成功 |

### Codex 将身份、运行和常驻实例分开

MAv2 的 AgentExecutionLimiter 只统计子代理的活动 turn。运行许可随执行 guard 释放，空闲会话不会继续持有运行许可。V2Residency 另外跟踪已加载实例和正在申请的实例名额；需要容量时尝试卸载空闲实例，保留其环境绑定与身份。

卸载会检查实例是否仍是当前注册对象、是否还有活动 turn、持久 sleep 或待处理邮箱；先确认 shutdown 完成，才从常驻集合移除。读取则区分 Loaded、Unloaded 与未知身份，不因为没有活实例就把历史记录当作不存在。

证据：[运行许可](https://github.com/openai/codex/blob/6fe77fc12346591b8037a8704640e40196b19044/codex-rs/core/src/agent/control/execution.rs#L18)、[实例卸载](https://github.com/openai/codex/blob/6fe77fc12346591b8037a8704640e40196b19044/codex-rs/core/src/agent/control/residency.rs#L35)、[定点查询](https://github.com/openai/codex/blob/6fe77fc12346591b8037a8704640e40196b19044/codex-rs/core/src/thread_manager.rs#L1789)、[Loaded 与 Unloaded](https://github.com/openai/codex/blob/6fe77fc12346591b8037a8704640e40196b19044/codex-rs/core/src/agent/control/inspection.rs#L12)。

测试直接验证了运行 guard 释放后容量可复用，以及容量不足时卸载较早的空闲实例。还有一个需要保留的限制：测试明确验证，被中断且没有足够恢复信息的 V2 实例卸载后无法重新加载。因此不能把卸载一律等同于可恢复。

证据：[运行额度测试](https://github.com/openai/codex/blob/6fe77fc12346591b8037a8704640e40196b19044/codex-rs/core/src/agent/control/execution_tests.rs#L18)、[卸载测试与中断限制](https://github.com/openai/codex/blob/6fe77fc12346591b8037a8704640e40196b19044/codex-rs/core/src/agent/control/residency_tests.rs#L23)。

模型继承也先从父 turn 的实际模型和 provider 配置生成子配置，再叠加角色和显式覆盖。参考的是这条解析顺序，不需要引入一个新的 provider 特例。见 [child_config](https://github.com/openai/codex/blob/6fe77fc12346591b8037a8704640e40196b19044/codex-rs/core/src/agent/child_config.rs#L103)。

### ZCode 的动态工作流有统一终态出口

动态工作流的 service 只保留 run 到 controller 和 settlement 的运行连接；引擎创建和结算 journal 记录，driver 创建并释放 actor runtime。completed、stopped、errored 都进入 finishRun，依次保存终态与产物、发出结算事件、调用 driver.dispose。成功结束时也会取消没有等完的 ask，包括 Promise.race 的输家。

并发有明确计数对象：工作流调度器统计在飞 ask；模型请求层另外按 provider 与 model 获取请求 ticket，退避期间不占 ticket。这两种额度都围绕实际工作，空闲 actor 会话不占 ask 名额。

证据：[统一收尾](D:/code/personal-project/ZCode/apps/zcode-cli/packages/dynamic-workflow/src/engine/engine-settlement.ts:14)、[在飞 ask](D:/code/personal-project/ZCode/apps/zcode-cli/packages/dynamic-workflow/src/engine/scheduler.ts:408)、[driver 释放](D:/code/personal-project/ZCode/apps/zcode-cli/packages/bootstrap/src/app/workflow-driver.ts:416)、[模型请求准入](D:/code/personal-project/ZCode/apps/zcode-cli/packages/adapters/src/model/request-admission.ts:7)。

需要限定：driver.dispose 发起清理后不等待所有尾部事件完成，关闭失败会记录 warning；旧 Workflow 的关闭链不完整；动态 resume 的 already_running 检查只覆盖当前 service；普通 Agent 复用 task ID 时没有同等明确的执行代次隔离。可以借鉴所有权和收尾结构，不能据此复制其恢复或清理成功语义。

证据：[dispose 的明确代价](D:/code/personal-project/ZCode/apps/zcode-cli/packages/bootstrap/src/app/workflow-driver.ts:418)、[旧 Workflow 限制](D:/code/personal-project/ZCode/apps/zcode-cli/packages/bootstrap/src/app/script-workflow-child-runtime.ts:109)、[resume 范围](D:/code/personal-project/ZCode/apps/zcode-cli/packages/core/src/tool/handlers/resume-workflow-run.ts:106)。

角色 Markdown 在输入时把 inherit 归一化为没有模型覆盖。具体名称策略属于 ZCode 自身，不应把其中 sonnet 等兼容名称规则直接复制过来。见 [模型选择解析](D:/code/personal-project/ZCode/packages/shared/src/subagent-markdown-selection.ts:8)。

### Synara 固定运行身份并检查迟到写回

等待开始时固定 threadId 与 turnId，之后始终读取这对身份。后续 turn 开始不会改变原等待目标；摘要也从同一 turn 的消息中提取。ProviderService 的写回还检查 dispatch generation，也就是本次派发的代次，旧派发不能覆盖新 turn 的当前绑定。

证据：[固定等待目标](D:/code/personal-project/synara/apps/server/src/agentGateway/threadReadTools.ts:417)、[按身份取摘要](D:/code/personal-project/synara/apps/server/src/agentGateway/threadReadTools.ts:534)、[写回代次检查](D:/code/personal-project/synara/apps/server/src/provider/Layers/ProviderService.ts:1711)。

测试确实模拟了 latestTurn 已经指向新运行，等待旧 run 仍返回旧完成结果；另有旧完成事件与延迟 send 返回不覆盖新 binding 的测试。见 [固定运行的测试](D:/code/personal-project/synara/apps/server/src/agentGateway/Layers/AgentGateway.test.ts:4873) 和 [迟到写回测试](D:/code/personal-project/synara/apps/server/src/provider/Layers/ProviderService.test.ts:4843)。

Hub 的工作名额存放在 work item 的 slotHeld 字段，领取和容量检查在同一条数据库更新中完成。实际工作结束后释放名额，thread 继续保留；给 idle worker 新工作时重新领取。provider runtime 的闲置回收还会等原生后台任务结束，避免父 turn 已完成就提前停掉后台工作。

证据：[原子领取](D:/code/personal-project/synara/apps/server/src/persistence/Layers/HubWorkRepository.ts:153)、[名额释放](D:/code/personal-project/synara/apps/server/src/projectAgent/hubWorkLifecycle.ts:45)、[后台任务结束前保留 runtime 的测试](D:/code/personal-project/synara/apps/server/src/provider/Layers/ProviderService.test.ts:6754)。

这几条机制分别属于应用会话、Hub 和 provider 管理。Synara 的 Claude Workflow 仍由 SDK 执行，部分父子关系来自有限的观察推断；其批量 wait 也会因一个指定 thread 缺失而整体报错。创建操作的持久补偿设计值得参考，但“一轮只允许一个创建计划”不适合直接移入支持多阶段委派的 OpenHarness。

### OpenCode 保留结果，同时结束执行范围

当前 TaskTool 创建或继续子会话，再通过 BackgroundJob 运行。BackgroundJob 以 ID 定点取记录，每次启动另有 token；同 ID 的旧 token 结算不会覆盖新执行。执行结束时保留终态 Info，关闭只属于该 job 的 scope，也就是它创建的执行资源集合。wait timeout 仅结束等待。

证据：[Task 真实入口](D:/code/personal-project/opencode/packages/opencode/src/tool/task.ts:136)、[token 与终态结算](D:/code/personal-project/opencode/packages/core/src/background-job.ts:126)、[定点等待和取消](D:/code/personal-project/opencode/packages/core/src/background-job.ts:292)。

V2 SessionRunCoordinator 还把 active 执行表与持久会话分开，结束时删除 active key。但 Task 尚未迁入该 V2 工具链，不能把两条路径合并描述。见 [coordinator](D:/code/personal-project/opencode/packages/core/src/session/run-coordinator.ts:51) 和 [V2 工具迁移范围](D:/code/personal-project/opencode/packages/core/src/tool/builtins.ts:26)。

BackgroundJob 明确只是进程内登记，重启会丢失，完成通知也可能早于异步资源关闭结束。当前 Task 还复用 sessionID 与 job ID，不能直接满足 OpenHarness 对多次 run 和 attempt 的区分。其具体模型继承可参考 [Task 模型选择](D:/code/personal-project/opencode/packages/opencode/src/tool/task.ts:174)。

### MiniMax 让所有子任务结果经过同一个终态写入入口

产品实际使用 LocalBackgroundTaskService。Task 先创建持久 queued 记录，再创建隐藏子会话并提交指定 Turn。taskId、ownerSessionId、childSessionId、subTurnId、runtimeOwnerId 分别表达工作、发起者、上下文、具体执行和持有运行实例的进程。

证据：[产品接线](D:/code/personal-project/minimax-code/packages/local-runtime/src/api/host-turn-tools.ts:89)、[先登记任务](D:/code/personal-project/minimax-code/packages/local-runtime/src/background-task/subagent-task-row.ts:18)、[指定 Turn 提交](D:/code/personal-project/minimax-code/packages/local-runtime/src/api/injected-conversation-task-turn.ts:63)。

前台、后台和 append 都经过同一个 terminal writer。它保存最终输出，再有条件写终态；停止已先结算时，迟到结果只能补输出，不得重开任务。真实执行的 completion Promise 成功或失败，都会移出本 host 的 active 集合；持久 task 与子会话继续存在。查询和取消按 task ID 与 owner 校验直接定位。

证据：[终态写入](D:/code/personal-project/minimax-code/packages/local-runtime/src/background-task/terminal.ts:43)、[active 集合](D:/code/personal-project/minimax-code/packages/local-runtime/src/background-task/lifecycle.ts:32)、[定点查询](D:/code/personal-project/minimax-code/packages/local-runtime/src/background-task/service.ts:96)、[定点 Turn 取消](D:/code/personal-project/minimax-code/packages/local-runtime/src/api/host.ts:666)。

启动恢复先核对 owner 是否已死亡，再把失去执行者的记录标 lost，并不自动重跑模型。这个边界符合 OpenHarness 近期暂缓完整跨进程执行恢复的决定。见 [启动核对](D:/code/personal-project/minimax-code/packages/local-runtime/src/background-task/startup-recovery.ts:85)。

不能照搬的部分也很明确：active 集合本身没有提供类似 8 个名额的限流；有些 stop 路径在底层停止失败后仍标 canceled，并另记 stopError；持久化本身失败时，执行可以结束而 task row 尚未成功结算。因此 OpenHarness 仍需保留 cleanupUnconfirmed 和持久投影补偿，不能只复制终态标签。

## 建议的架构边界

以下是针对 OpenHarness 的设计建议，不是对参考项目的行为描述。

### 入口保持，执行归属在组装时确定

Agent、BackgroundShellCreate、TerminalOpen 和 Workflow 继续按各自参数创建工作。JobList、JobRead、JobWait、JobSend、JobCancel 继续作为统一观察和控制入口。

每一种工作类型在 host 组装时只选择一个后端，创建和控制必须来自同一份绑定。SDK 使用本地绑定；daemon 使用已有产品绑定。child 的运行仍由框架管理，daemon 的 child 绑定把历史读取接到持久记录，把活动控制接到对应框架 handle；它不因此成为第二个执行者。

选择当前后端只决定新工作归属。已经创建的工作必须继续使用创建时固定的后端身份和执行 owner，不能因重新组装、配置切换或 daemon 重连而改派。运行进程身份与业务发起会话身份分别校验，避免本进程只改了另一进程任务的状态，却没能停止它。

```text
Agent / Workflow / BackgroundShellCreate / TerminalOpen
                         |
             已选定的类型后端，负责创建并返回身份
                         |
              child / process / terminal / workflow
                         |
             现有事件与持久记录，保存运行结果

JobRead / JobWait / JobSend / JobCancel
                         |
        校验 owner 与目标身份，直接找到已绑定的类型后端
                         |
           查询对应记录，或控制对应的活动执行

JobList -> 分别读取各类型列表，只承担浏览与诊断
```

组装允许同一底层工作有多个展示投影，但只允许一个控制后端。新增来源必须声明负责的类型；类型重叠在组装测试或注册时明确失败，不能等到用户读取另一项任务才暴露。

按 ID 的控制不得调用 list 来发现 owner。新任务在创建时登记可信归属；重开后的 daemon 从已有带类型的持久记录直接恢复归属。这个索引只保存身份和路由，不保存第二份状态或输出。旧记录缺少路由时可以对目标 ID 做有界的直接查询，不能扫描并合并所有来源，更不能因查不到而重新创建执行。

列表发生来源故障时，返回可用项并明确标记不完整及对应来源错误；不能伪装成完整空列表。这个响应变化需要同时更新协议、模型工具、client 和桌面读取者。若某个旧入口暂不能表达部分结果，应明确返回 unavailable，仍不得妨碍按 ID 控制。

### 稳定会话与一次运行分别表达

| 对象 | 表达什么 | 生命周期与状态保存位置 |
| --- | --- | --- |
| childId 与 sessionId | 可继续对话的子代理身份与上下文 | 框架保留身份和历史；daemon 使用已有 session 与 transcript |
| runId | 接受一次输入后的执行 | 运行创建时分配，终态不可重开；复用已有 session_run |
| Workflow taskId 与 attempt | 逻辑步骤及本次尝试 | 继续使用现有工作流记录，每次重试绑定真实 child run |
| runtime generation | 同一子身份第几次加载实例 | 框架控制的内部代次，避免旧创建、挂起、定时器和回调影响新实例 |
| execution permit | 当前是否占用一个执行名额 | 内存中的原子预约，确认执行停止后释放 |
| Job 视图 | 本次允许调用方看到的状态和能力 | 从以上已有状态计算；不另建通用 Job 状态库 |

观察身份固定为 owner、childId、runId。Promise 只用来通知结果到达，不能作为运行身份。开始 wait 或 cancel 时固定目标 run；未显式传 runId 时，在入口解析一次当前 run，后续等待和停止操作不漂移到新 run。普通 read 省略 runId 可以读取最新快照，但响应必须携带实际 runId；读历史结果和错误时使用指定的同一个 run。

继续输入产生新 runId，旧 run 的终态和结果继续可读。当前 Job ID 可保持为子代理对象的稳定句柄，但必须同时暴露它所指向的具体 run。旧回调允许保存到它自己的历史 run，不允许覆盖新 run 的状态、结果、取消信号或额度。

runId 已能区分的执行不再增加另一套 attempt ID；runtime generation 只用于同身份实例重建等 runId 不能覆盖的资源竞态。一次重试不能同时被 Workflow、Job 读取器和实例恢复各自启动。

### 执行额度与保留上下文分离

`maxActiveChildren=8` 改为约束实际接纳的子运行，包含启动中、运行中和仍在确认停止的执行。run 创建和并发额度预约必须原子完成。确认尚未启动，或确认执行及对应清理已经结束后，才能回滚运行许可；启动抛错但底层是否运行无法确认时，保留 owner 与预约并进入 cleanupUnconfirmed。同 child 的新输入仍走现有串行 startChain。

idle 和 suspended 本身不消耗运行额度。但界面状态不能作为资源已经停止的证据。run 仍有未结束操作或未确认取消时，相关执行和清理预约仍由 owner 持有。错误恢复不能提前退名额，再用新 worker 绕过未停止的旧执行。

实际执行确认结束后，即使结果的持久投影写入失败，也要释放运行许可。此时保留不可变结果快照、保存失败原因和待补偿记录。执行额度限制正在发生的工作，持久化补偿承担保存责任，两者不能互相替代。

递归深度 4 与累计创建数 64 保留，继续防止无限委派；它们与执行并发分开计算。首次创建检查深度及累计预算，每次新 run 检查运行额度。并发满时返回结构化容量错误及当前占用，不默认重建代理或无限排队；嵌套父子运行的等待也要覆盖测试，避免全部父运行占名额等待子运行而死锁。

本次先沿用现有 5 分钟闲置挂起，不移植 Codex 的完整常驻实例淘汰器，也不新增一个独立的 8 实例硬上限。Workflow 的一次性 worker 在结果保存、运行停止后尽早安全挂起，保留历史和结果，后续显式输入可以按权限加载新实例。

挂起需要确认没有活动后代、排队输入、待处理审批、后台工具工作或未决清理，并与 send、resume、close 共用序列化边界。找不到安全挂起点时继续保留实例，不能为了清理一个 idle 父实例而取消仍在工作的后代。工作树成果按现有保留规则处理，释放模型实例不能顺带丢弃未提交文件。只能承诺恢复已保存的 history、配置与目录状态，不能承诺恢复内存变量、进程或工具句柄。

### Workflow 的一次尝试有完整且唯一的收尾

一次 attempt 的 owner 负责从创建、等待、读取部分结果，到停止确认、保存结果和资源释放。正常完成、超时、失败、上级中断都经过同一个幂等收尾入口，重复通知不得重复释放额度。调用方放弃等待后，owner 仍承担收尾。

| 事件 | 运行结果 | 后续动作 |
| --- | --- | --- |
| JobWait 到时 | 当前 run 可以继续 running | 返回固定 run 的进展，取消本次等待订阅 |
| 执行 deadline 到时 | 记录 timeout 原因并请求停止 | 保留部分结果，确认停止，再保存终态并清理 |
| 用户或父级取消 | 保存明确的取消来源 | 停止对应 run 及其应取消的后代，不误停新 run |
| 正常完成 | 保存 completed 和真实输出 | 释放执行许可；一次性 worker 可安全挂起 |
| 清理无法确认 | 保留 stopping 与 cleanupUnconfirmed 事实 | 不自动重跑整项工作、不宣称资源已释放；读取、等待和再次请求停止仍可用 |
| 查询或投影读取失败 | 查询失败 | 不改变实际运行状态，不自动创建替代 worker |
| 终态持久化失败 | 执行结果与保存状态分别报告 | 确认执行结束后释放运行额度，沿现有投影补偿处理，不能把写盘失败当作授权重跑工具 |

执行已停止但结果投影暂未写成时，要保留已捕获结果与待补偿状态；后续消费者能区分“执行失败”和“结果暂不可用”。现有 `projection-settlement-recovery` 和 `cleanupUnconfirmed` 应继续承担各自职责，不另造第二套恢复调度器。

执行完成只表示流程结束。审核结论、结构化交付是否通过、清理是否确认应分别表达，不能因 `status=completed` 就向用户报告“审核通过”。现有 SubmitResult 与 delivery 回执是可复用的基础。

### 配置在创建副作用前解析

统一子运行配置入口依次处理：父运行已生效配置、角色设置、调用方被允许的覆盖、权限收窄和预算。`inherit` 在这里变成父运行的具体模型；provider 只收到已解析的 provider、model 和对应 effort。

不支持的显式模型应直接失败，不能静默换模型。冷恢复和后续输入仍需检查当前插件、工具和模型权限；保留历史不能冻结过期授权。Agent、Workflow 和系统审核走同一解析入口，避免只修某一个工具。

## 取舍与范围

最小修法是分别去掉重复来源、修 Promise 比较、结束后退名额、处理 inherit。它能缓解当前报错，但仍没有定义下一次运行、迟到回调和真实资源释放的共同约定。

推荐方案把上述约定集中到已有组装工厂、child 运行控制和 Workflow runner；不新增通用 Job 状态服务，不另建数据库，不改变既有工具权限保护。预计会涉及 8 个以上源码与测试文件，属于跨模块改造。

另一个方案是让所有工作迁入全新的统一执行平台，同时引入持久租约、自动恢复调度和通用执行数据库。现有证据不足以支持它的收益，迁移和状态冲突风险也更高。本次建议不选这个方向。

项目近期明确暂缓完整 S2 跨进程执行恢复，见 [当前核心能力方案](../superpowers/specs/2026-10-26-agent-core-capability-completion-design.md)。本建议遵守这一边界：启动时核对 owner 和已有记录，保留结果；确认执行已不存在时标 interrupted，停止情况无法核实则保留 unknown 或清理未确认事实，不自动重放模型和写工具。未知写操作保护、owner 校验和现有投影补偿继续保留，不能因新进程的运行额度重新计数就认为旧副作用已经安全结束。

最需要防守的前提是“运行已结束就能安全卸载实例”。有后台工具或活动后代时这个前提不成立，因此卸载必须检查完整静止条件，无法确认时保留实例与清理责任。不能仅凭 completed 或 idle 标签释放所有资源。

## 分阶段实施建议

每阶段都应独立可用，无须依赖后续阶段才能正确运行。下表是实施边界，尚未修改生产代码。

| 阶段 | 具体改动 | 主要位置 | 本阶段独立收益 |
| --- | --- | --- | --- |
| 一、确定归属与定点控制 | 将宽泛来源聚合改为按类型选择后端；创建时登记路由；read、wait、cancel 不依赖 list；列表明确来源故障 | jobs、default-agent-capabilities、local-agent-job-host、DaemonJobService、daemon 组装 | 一个旧 Shell 故障不会阻止其他 child 读取与停止 |
| 二、稳定运行身份与额度 | handle 暴露稳定 run 快照；观察器按 run 定位；迟到回调核对身份；运行许可独立于会话保留；补齐安全挂起 | agent-contracts、child-agent、child-registry、NodeChildManager、Jobs adapter、持久 child 读取 | 连续执行超过 8 个顺序任务可复用额度；完成结果不再依赖 Promise 引用 |
| 三、统一尝试收尾与配置 | Workflow owner 完整结算与清理；保留 timeout、取消、查询故障区别；统一 inherit 解析；更新真实组合测试与说明 | workflow runner、coordinator task runner、child 配置、角色输入、daemon 投影与 client 契约 | 成功和失败都可靠收尾；重复执行与配置规则一致 |

跨模块实现时保持现有分类目录。运行身份与额度属于 kernel/children；本机默认组装与配置属于 node；Workflow 的依赖调度仍归 coordinator；daemon 持久化、授权与产品查询仍归 server/services；Jobs 共用协议只描述控制和观察，不能依赖 daemon 存储。

公共变化需要一起审查：Job 快照携带具体 run 身份、定点 wait/read 的目标运行、JobSend 的新 run receipt、列表不完整信息、child 活跃额度的语义。具体字段在实施计划中固定，并同步协议版本、client、模型工具和桌面使用方。现有 Job ID、会话 ID 和历史数据不需要整库重写；旧记录无法验证的运行身份只能标不可用，不能补造。

回退按阶段撤销代码和对应新增协议面，保留既有会话、Run、Transcript 和 Workflow 记录。实施中不删除历史输出、不重放工作，不依赖新账号、API Key、服务或用户配置。实际协议迁移仍应遵守项目现有版本规则。

## 必须验证的场景

| 场景 | 通过条件 |
| --- | --- |
| 真实 daemon 注入 Shell，再从模型侧 Jobs 控制 child | 各类型只有一个控制后端，读取和取消都正常 |
| 一个来源声明冲突或抛错 | 其他来源的指定任务仍可读取、等待和取消；列表明确不完整 |
| 真实 child handle 的 getter 返回新 Promise | 仍按 runId 读到 completed 与真实输出 |
| 同一 child 开始新 run | 旧 wait 仍返回原 run 的结果和错误，新 wait 指向新 run |
| 旧 run 回调和旧挂起定时器迟到 | 不修改新 run 状态、结果、实例或额度 |
| 顺序运行 20 个一次性任务 | 不因保留历史耗尽 8 个执行名额，原结果仍可读取 |
| 同时启动 9 个子运行 | 并发额度原子生效，超额请求明确失败且不申请无主资源 |
| 所有父子层级同时等待 | 不无限排队死锁；深度、累计预算和容量错误仍准确 |
| 正常、超时、取消和创建失败 | 各路径只结算一次，名额不重复释放 |
| 底层已启动但回执或登记失败 | 保留执行 owner 与预约，核实和停止原执行，不提前释放或创建替代工作 |
| 请求取消后底层迟迟不停止 | 保留未确认状态，不提前允许替代执行 |
| 结果保存或持久投影失败 | 原输出可补偿；不因保存失败重跑模型或写工具 |
| child idle 但仍有后台工具、活后代或审批 | 不提前关闭实例，不丢成果，不中断后代 |
| 挂起与 send、resume、close 并发 | 通过同一边界协调，迟到实例不会逃过关闭或提交孤立 run |
| 父会话或应用退出 | 停止接纳新执行，按 owner 取消并等待已有工作收束 |
| 用户继续旧会话或插件已撤销 | 新 run 重新检查授权，不继承失效工具权限 |
| Agent、Workflow、插件角色使用 inherit | provider 收到父运行的具体模型；显式错误模型不会回退 |
| daemon 重启后读取旧结果 | 历史仍可读，依证据区分 interrupted 与停止未确认，不自动重放 |
| 审核执行完成但结论 NEEDS_CHANGES | 报告完成与结论分别表达，不误报验收通过 |

测试应以真实组装工厂和真实框架 handle 为基础，用可控模型返回代替联网调用。跨模块场景放在共同上层的测试目录；不再用固定 Promise 属性替代真实 getter，也不只分别断言注入的局部 host。

实施时按范围运行 jobs、agent-runtime、coordinator、server 的定向测试和类型检查；协议变化补 server-client 与 desktop-integration。完成前执行 `pnpm check-docs`、`pnpm check:retired-ui`。只有需要验证真实 provider 行为时才另行开展真实模型验收。

## 本次验证记录

- 已只读核对五个参考项目的关键运行链路，并复查其适用范围与测试断言。
- OpenHarness 的 CompositeAgentJobHost 定向测试：23 个通过。
- OpenHarness 的 LocalAgentJobHost 定向测试：16 个通过。
- 不修改文件的最小复现：无关旧任务冲突会使目标 child 的 read 与 cancel 失败；已完成 child 可连续三次被读成 running 和空输出；inherit 会原样成为子模型；8 次未关闭身份预约后再创建会触发上限。
- 本次没有实施架构修改，因此不能把上述测试通过解释为问题已经修复。
