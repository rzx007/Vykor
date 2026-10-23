# 渠道管理

[`manager.ts`](manager.ts) 实现 `ChannelManager`，由 `@vykor/channels` 的 [`../index.ts`](../index.ts) 公开导出。它接收宿主创建的适配器、`MessageBus` 和白名单配置。

`startAll()` 注册入站回调、启动出站消费循环并逐个连接适配器。入站消息检查白名单和 `chatId` 后进入队列；出站消息按渠道配置过滤进度提示、检查消息能力，再调用适配器发送，并向宿主报告发送状态。单个渠道启动或发送失败会记录状态或告警。

管理器在内存中保存适配器表、运行状态、停止信号和出站序号。`stopInbound()` 先停止接收新消息，已有回复仍可发出；`stopAll()` 停止出站循环并断开适配器。配置、会话和发送结果的持久化由宿主承担。

通用启停和路由规则放在本目录，平台协议放到 [adapters](../adapters/README.md)。相关测试放在 [`__test__`](__test__)，跨分类测试放到 `src/__test__/`。返回[源码导航](../README.md)。
