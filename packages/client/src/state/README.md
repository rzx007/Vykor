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

## 入口与处理步骤

主要入口或定义见 [index.ts](./index.ts)。

同步控制器取得快照并订阅事件，更新函数合并事件，查询函数从当前状态提取界面数据。

## 状态放在哪里

会话视图、事件缓冲和订阅状态保存在客户端实例；业务持久化由 daemon 负责。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
