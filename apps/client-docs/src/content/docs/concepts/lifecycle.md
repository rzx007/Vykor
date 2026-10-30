---
title: 生命周期与状态归属
description: 理解 Session、Input、Run、Permission 和 Job，以及请求、事件与持久化结果的关系。
---

一次任务从应用提交输入开始，在 daemon 中执行，结果通过快照和事件回到应用。断开网页或结束脚本不会自动停止后台 Agent。

```text
应用调用资源方法
  → SDK 检查通信协议并发出 HTTP 请求
  → daemon 保存输入，安排 Run 执行
  → daemon 保存消息、权限和终态
  → SDK 读取快照，持续接收 SSE
  → 应用从合并后的状态读取结果
```

SSE 是服务端持续推送事件的连接。SDK 将快照和事件合并为 `VykorClientState`，应用可以直接用选择函数读取它，不必从日志猜测当前任务状态。

## 记录各自表示什么

| 记录 | 实际用途 |
| --- | --- |
| Session | 保存工作目录、模型配置、历史和会话状态，允许提交多轮输入 |
| Input | 一笔已接纳的用户输入，保存调用方请求 ID、文本项、附件和投递方式 |
| Run | 一次执行，具有独立 ID 和 `pending/running/completed/failed/interrupted` 状态 |
| Message 与 Part | 组成可展示的消息；Part 分别保存正文、工具记录、附件等内容 |
| Permission | 一次待审批工具操作，保存请求内容和明确的批准、拒绝或过期结果 |
| Job | 后台任务或子任务的当前快照，带完整目标标识和支持的操作 |

`Input` 和 `Run` 不是一一对应的假设。排队输入通常创建新 Run，`delivery: "steer"` 可以补充正在执行的任务；运行在边界处结束时，服务端还可能安排后续执行。每次以返回的 `input` 和 `run.id` 为准。

## 提交成功与运行结束

`admitPrompt()` 的 HTTP 返回表示输入已被接纳。查看 `queue_state` 可以知道返回时处于运行还是排队；最终状态从快照和事件取得。

脚本用 `waitForRun` 等待一个确定的 Run。交互界面用 `syncEvents` 或 `SessionSyncController` 持续观察会话。两种方式使用相同的恢复规则，都不会替用户回复权限请求。

Run 的终态与业务交付进展也不同。结构化任务可能正常结束，但交付仍是 `partial`、`blocked` 或 `waiting`，详见[结构化交付](../../guides/structured-delivery/)。

## 状态放在哪里

daemon 保存 Session、Input、Run、消息、权限和持久事件。SDK 在客户端维护这些记录的本地视图，并保存事件游标，用来判断已经合并到哪个位置。游标不是任务 ID，也不能单独恢复完整状态。

应用自己保存草稿、选中项、面板开关和连接提示。不要在收到准入结果后手工补造 Message 或把本地“已停止”标记写成服务端 Run 真相，后续快照可能与这些副本冲突。

单会话观察从原子快照和它对应的事件游标开始，断流后刷新快照再继续。临时文本增量用于即时显示，持久化的完整正文用于恢复。具体流程见[快照与事件同步](../../guides/sync-recovery/)。

## 三种停止操作

| 操作 | 作用范围 |
| --- | --- |
| 取消 HTTP、同步或等待的 `AbortSignal` | 结束本次客户端请求或观察 |
| `sessions.interrupt(sessionId, { expectedRunId })` | 请求 daemon 中断会话运行 |
| Node 入口的 `Service.stop(endpoint)` | 停止整个本机 daemon，影响共用它的所有客户端 |

会话运行控制见[会话与输入](../../guides/sessions/)，本机进程管理见[可选本机服务管理](../../guides/local-service/)。
