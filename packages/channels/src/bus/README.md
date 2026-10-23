# 事件与消息总线

提供进程内事件订阅，以及宿主和渠道之间的异步消息队列。公开 API 从 `@vykor/channels` 的 [`../index.ts`](../index.ts) 导出。

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | `EventBus`，按事件名订阅、发布与清空订阅 |
| [queue.ts](queue.ts) | `MessageBus`、入站和出站消息类型、会话键计算 |
| [acl.ts](acl.ts) | `isAllowed`，按发送者或聊天标识检查白名单 |
| [__test__](__test__) | 队列等待、容量和取消行为测试 |

渠道管理器调用 `publishInbound`，宿主调用 `consumeInbound` 取消息；回复走 `publishOutbound` 和 `consumeOutbound`。每个方向最多缓存 1000 条，容量满时发布者等待，消费或发布可以用 `AbortSignal` 取消。白名单缺失或为空时拒绝，`*` 表示全部允许。

订阅表、队列内容和等待者均保存在实例内存中，不写磁盘。新增队列和事件通用逻辑放在本目录，对应测试放在同层 `__test__/`。返回[源码导航](../README.md)。
