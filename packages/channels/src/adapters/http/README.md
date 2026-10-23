# HTTP 出站适配器

[`http.ts`](http.ts) 实现 `HttpAdapter`，由 `@vykor/channels` 的 [`../../index.ts`](../../index.ts) 公开导出。

宿主传入目标 URL 后调用 `send()`，适配器把完整 `ChannelMessage` 序列化为 JSON，通过 HTTP POST 发送。未配置 URL 时直接返回。`connect()` 和 `disconnect()` 当前为空操作，`onMessage()` 只保存回调，不创建 HTTP 服务或轮询入站消息。

目标地址和消息回调保存在实例内存中；配置与发送结果的保存由宿主负责。HTTP 传输实现继续放在本目录，新增测试放同层 `__test__/`，涉及管理器的测试放到 `src/__test__/`。返回[适配器导航](../README.md)。
