# Agent Child Session Flow

> 状态：当前实现。framework owns child execution/live handles；daemon owns durable child session/task/run projection。

## 总图

```mermaid
flowchart LR
  Tool["Agent / Workflow producers + Job controls"]
  Manager["AgentChildManager"]
  Registry["tree-wide AgentChildRegistry"]
  Child["child VykorAgent"]
  Events["shared AgentEventBus"]
  Projector["DaemonAgentEventProjector"]
  Store["child session/run/task/transcript"]
  Directory["LiveChildAgentDirectory"]

  Tool --> Manager --> Child --> Events --> Projector --> Store
  Manager --> Registry
  Manager --> Events
  Projector --> Directory
  Directory -. rootAgent.children .-> Registry
```

## Spawn 闭环

1. Agent/Workflow tool 调用 `context.agent.children.spawnChildAgent()`。
2. `AgentChildManager` 生成 canonical `childId` 与 `sessionId`。
3. manager 在 tree-wide registry 预检 sessionId，并原子预占整棵树的 child 预算；超过递归深度、活跃数或累计数时直接返回结构化错误，不获取环境资源，也不发布假的 `child.created`。
4. `AgentChildEnvironmentProvider` 获取 shared cwd 或 git worktree lease。环境申请或后续创建失败会回滚这次未成功的预算预占。
5. manager 把 handle 放入 root tree 共享的 `AgentChildRegistry`，发布并等待 `child.created`。
6. daemon projector 创建 durable child session、parent-visible task，并登记 `rootAgent + childId` 路由；既有 durable session 还必须匹配同一个 childId。
7. framework 递归创建共享 effects/event bus 的 child `VykorAgent`。
8. child 启动普通 run，发布 input/run/output/tool/terminal events；`run.started` 投影成功且 receipt 与 manager 预分配的 session/input/run ID 完全一致后，spawn receipt 才返回。
9. daemon 使用同一个 event reducer 创建 child input/run/transcript 并绑定/完成 task；child input metadata 由 `input.accepted` 原样携带，application 不再补造记录。

daemon 不向 framework 返回 run host、controls 或 opaque state。parent-visible task 使用 `childId` 作为可见 ID，因此 `Agent` 返回的 `jobId` 可以直接交给 `JobRead/Wait/Send/Cancel`。

## Wait 闭环

```text
Agent / Workflow -> spawnChildAgent() -> jobId
JobWait(jobId)
  -> AgentJobHost.resolve(jobId)
  -> standalone 观察 live child；daemon 刷新 durable task
  -> completed / failed / killed snapshot

BackgroundShellCreate -> shell jobId
  -> AgentJobHost 读取 DetachedProcessSupervisor 状态
```

framework child 的执行不依赖 daemon task projection。daemon projector 可以并行建立同 ID 的 durable task，负责 UI、恢复和审计；它不是 SDK 执行闭环的一环。`JobWait` timeout 只返回当前快照，不会 interrupt；只有显式 `JobCancel` 才停止 child。

## Child 预算（防止无限“叫人”）

默认预算是 `maxDepth=4`、`maxActiveChildren=8`、`maxTotalChildren=64`。现有 Workflow 默认并发是 3，因此活跃上限 8 能容纳常规 Workflow 和少量交互式 Agent，同时会挡住失控的递归创建；累计上限 64 防止通过“创建一个、关闭一个、再创建一个”的循环绕过限制。可以用 Settings 或创建 Agent 时的 `childBudget` 覆盖。

- depth 从 root agent 的 0 开始；child 是 1，grandchild 是 2。
- `activeChildren` 统计尚未确认实际停止的 child run。每轮在创建或恢复实例前原子申请许可；工具调用与附属清理都完成后归还。idle、suspended 身份不占运行名额，取消回执、工具超时和保存错误也不能提前归还。
- total 统计 root agent 生命周期内成功分配过的 child；close 后不退。root agent 关闭后，共享账本随整棵 live tree 一起释放。
- `agent.inspect().childBudget` 返回当前上限、active 和 total，供 debug/metrics 读取。

## Child 失败后谁做决定

`AgentChildManager` 只报告事实：`completed`（正常完成）、`failed`（执行失败）、`interrupted`（被上级中断）或 `stopped`（尚无活动 run 就被停止）。它不替父级决定要不要继续。

- 单次 Agent + JobWait：失败会作为 `failed` 和 `failureKind` 返回给父模型；父模型可以改方案、继续其他工作或明确停止，父 run 不会被 ChildManager 暗中判失败。
- Workflow：默认 `failurePolicy=skip-dependents`，失败任务的下游会跳过；`fail-fast` 会停止调度新任务；`continue` 仍调度下游。只有任务自己的 `retry` 配置会自动重试。
- Workflow 每次 retry 都调用一次新的 `spawnChildAgent`，生成新的 child session/run；不会把已经 terminal 的 run 重新打开。
- parent run abort 不属于可选策略：它始终向所有直属 child 传播 interrupt，child 再向自己的 descendant 传播。

## Follow-up

```text
JobSend(jobId)
  -> AgentJobHost.send(jobId, input)
  -> context.agent.children.sendChildInput(childId, input)

HTTP child prompt
  -> SessionInteractionService
  -> LiveChildAgentDirectory.send(childSessionId)
  -> rootAgent.children.get(childId).send(input)

JobSend 的 ChildManager 的定点 run 记录 路由
  -> registered session-task callback
  -> rootAgent.children.get(childId).send(input)
```

- child 有 active run 且 delivery 不是 queue：调用 `run.steer()`，输入在 turn boundary 注入同一 run。
- active run 正在收尾、不再接受 steer：等待其 settle 后串行启动下一轮。
- delivery=queue 或 child idle：沿 `startChain` 启动下一轮 run，复用 history。
- caller 提供 input ID 时，manager 在现有 256 条 requests 内保持幂等；同轮 steer 输入引用同一份 run 结果。明确未接纳的失败占位项会移除；活动与未保存结果不能淘汰，未保存记录占满时明确拒绝新输入。已保存结果可淘汰；SDK 返回 `RUN_RESULT_NOT_RETAINED`，daemon 定点读该 run 的归档。相同 ID 不同 payload 失败关闭。
- child/grandchild 共用 tree-wide directory，所以 daemon 从 root agent 可以直接路由任意深度 descendant。
- live child HTTP 只返回 receipt 已对应到 durable input/run 的结果；投影缺失或身份不一致会明确失败，不补造第二份 durable 事实。

## Stop / interrupt / close

```text
JobCancel(runId)           -> handle.interruptRun(runId)，立即返回 stopping
确认单轮已经停止          -> handle.waitRun(runId)
parent run abort          -> 原 run 的可信取消信号
parent agent close        -> manager.closeAll()
```

close 会先把 record 置为不可逆的 `closing`，从这一刻起 `send/steer/queue` 都拒绝新输入；然后 abort active run、等待 settlement，也等待首次创建或 suspend-resume 正在创建的 agent。随后关闭资源、释放 environment lease、发布并等待唯一一次 `child.closed`，最后置 `closed` 并从 directory 删除 handle。异步创建或 run settlement 续体发现 `closing/closed` 后不得回写 `idle/running` 或提交孤立 run。

`FrameworkAgentRun.settled` 确认本轮模型、真实工具 invocation 和准备清理已停止，先固定实际结果，再归还许可与保存终态。已经发生的执行失败保留原失败；模型先正常结束、真实调用或清理仍未停止时，第一个可信停止信号可以把暂算的成功改为取消/超时。已经 settled 的结果不会因迟到信号改变。`result` 继续遵守可靠保存的错误约定；保存失败只在原 run 增加 `projectionError`，不改写结果。清理失败返回 `stopping` 与 `cleanupUnconfirmed`，保留原资源和许可；再次明确取消/关闭只重试原清理，不调用模型或工具。

daemon 收到 terminal/closed event 后完成 durable run/execution 并移除 live route。若 durable close completion 失败，projector 保留带原始 `child.closed` event 的 pending projection state；后续有序事件或同一事件重试会先完成该 terminal projection，再推进 event sequence 水位。若 child 普通执行事件投影失败，projector 会先把已建立的 durable run、transcript part 和 parent execution 收束为 failed，再把 required event failure 传播给 framework。ChildManager 的定点 run 记录 的 live completion 失败不会阻止 durable execution terminal 落盘，durable completion 自身失败也不会被静默丢弃。

durable task 已 terminal 后，延迟到达的 live `pending/running` snapshot 不得让它回退。显式 follow-up 启动新 run 时才重新置为 `running`，并清除上一轮的 `finishedAt/output/error` 与 live output file。

## Suspend / resume

child run 完成后进入 idle。默认 5 分钟无输入：

1. snapshot history。
2. close child MCP/sandbox/runtime。
3. 保留 invocation/handle/session identity。
4. 发布 `child.suspended`。

后续输入创建新 child agent、load history、发布 `child.resumed`，再执行新 run。恢复创建与 close 共享同一个 creation barrier；close 不会在新 agent 仍可能出现时提前返回。

## 所有权

| 状态 | 所有者 |
|---|---|
| child ID、instance、run、abort、result、history | `AgentChildManager` |
| root tree 的 descendant handle 索引 | framework `AgentChildRegistry` |
| worktree acquire/release | framework child environment provider |
| child session/input/run/task/transcript | daemon `SessionStore` + projector |
| childSessionId -> rootAgent/childId 路由 | daemon `LiveChildAgentDirectory` |
| child execution callbacks | daemon `SessionExecutionProjector` + `ChildManager 的定点 run 记录` |

## 代码位置

```text
packages/agent-runtime/src/kernel/children/child-agent.ts
packages/agent-runtime/src/kernel/children/child-environment.ts
packages/tools/src/agent/index.ts
packages/agent-runtime/src/node/workflow/agent-workflow-runner.ts
packages/server/src/application/agent/daemon-agent-event-projector.ts
packages/server/src/application/agent/live-child-agent-directory.ts
packages/server/src/application/session/transcript/session-execution-projector.ts
packages/server/src/application/session/interactions/session-interaction-service.ts
```


阶段 A 已接通 Jobs 协议 6 与共同执行来源；最新接口和所有权说明见 [Jobs 协议](./jobs-protocol.md)。额度和 Workflow runner 的后续收拢仍按阶段 B/C 计划执行。
