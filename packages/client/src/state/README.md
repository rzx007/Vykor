# 客户端会话状态

把服务端快照与持续事件合并成可展示、可查询的会话状态。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [index.ts](./index.ts) | 统一导出本分类的类型与函数 |
| [reducer.ts](./reducer.ts) | `UnsupportedSessionEventSchemaVersionError`、`createInitialClientState`、`applyEvents` |
| [selectors.ts](./selectors.ts) | `SessionMessageWithParts`、`selectSessionMessagesWithParts`、`selectVisibleSessionMessagesWithParts` |
| [session-stream-state.ts](./session-stream-state.ts) | `applySessionStreamEvent`、`applySessionStreamSnapshot` |
| [session-sync-controller.ts](./session-sync-controller.ts) | `SyncConnectionStatus`、`SessionSyncControllerOptions`、`SessionSyncController` |
| [sync.ts](./sync.ts) | `SyncEventsClient`、`hydrateState`、`syncEvents` |
| [wait-for-run.ts](./wait-for-run.ts) | `waitForRun`、`WaitForRunOptions`、`RunResult` |

## 入口与处理步骤

主要入口或定义见 [index.ts](./index.ts)。

`sync.ts` 保存唯一同步流程：单会话先请求快照，全局视图先读取历史，再打开事件流。断流后等待并重试；会话必须成功刷新快照后才重新开流，快照失败期间保留已有显示状态。网络错误、HTTP 5xx，以及可重试的 408、425、429 会继续恢复；其余 HTTP 4xx（包括会话删除后的 404）直接结束并上报原始错误。全局流发现序号缺口时补读历史，消费方可提供轻量更新函数，避免保存正文。

全局首次历史与缺口补读均以最多 128 条为一页，逐页应用；每条成功应用后立即推进恢复游标。后续记录应用失败或连接因积压被关闭时，从最后成功位置重连，不把整页末尾或服务端排队末尾当作已完成。会话断流仍先刷新快照，以恢复不保留在持久历史中的临时文本增量。

`syncEvents` 把更新作为异步迭代结果返回，保留摘要 `partView` 和可配置空闲超时（默认 60 秒）。`SessionSyncController` 使用同一内部流程，把初始缓存和游标传入，将结果交给回调；它保存当前状态、连接状态、取消信号和订阅代次，保持传输层原有的空闲超时默认值。取消后到达的快照、补读和事件不会更新显示。内部 `runEventSync` 不从公开入口导出。

`waitForRun(client, { sessionId, runId, signal })` 使用 `syncEvents` 等待指定 Run 的终态，返回 `{ run, messages }`。已完成快照、失败和中断都按持久记录返回；无法恢复的同步错误会使等待失败，并保留原始错误。它不自动批准权限。signal 只停止等待，不中断 daemon 上的 Run。

## 状态放在哪里

会话视图和订阅状态由调用方的同步控制器或迭代任务保管；业务持久化由 daemon 负责。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
