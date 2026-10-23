# 标准输入输出适配器

[`stdio.ts`](stdio.ts) 实现 `StdioAdapter`，由 `@vykor/channels` 的 [`../../index.ts`](../../index.ts) 公开导出。

`onMessage()` 保存回调，并通过 `readline` 逐行读取 `process.stdin`，每行转成消息后交给回调。`send()` 把消息正文和换行写到 `process.stdout`。`connect()` 和 `disconnect()` 当前为空操作。

消息回调和输入监听属于当前进程，不写磁盘。当前入站消息不带 `chatId`，接入要求聊天路由的 `ChannelManager` 时，需要调用方补齐路由信息。

标准流转换逻辑放在本目录，新增测试放同层 `__test__/`，跨渠道流程测试放到 `src/__test__/`。返回[适配器导航](../README.md)。
