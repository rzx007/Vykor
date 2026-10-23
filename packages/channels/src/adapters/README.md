# 渠道适配器

适配器把平台消息转为统一的 `ChannelMessage`，并实现连接、断开、发送和接收回调。公开类由 `@vykor/channels` 的 [`../index.ts`](../index.ts) 导出。

| 目录 | 主要实现 |
| --- | --- |
| [feishu](feishu/README.md) | 飞书与 Lark 长连接、消息和附件、扫码注册、凭据验证 |
| [http](http/README.md) | 向配置地址发送 JSON 消息 |
| [stdio](stdio/README.md) | 从标准输入收文本、向标准输出写回复 |

宿主创建适配器并交给 [ChannelManager](../core/README.md) 管理。平台连接和回调由各适配器保存，入站白名单与出站路由由管理器负责，消息队列由 [bus](../bus/README.md) 保存。

新增传输方式放到独立的 `<渠道名>/`，实现 `ChannelAdapter` 并在包入口导出。测试放在该渠道目录的 `__test__/`；只有跨适配器行为才放到 `src/__test__/`。返回[源码导航](../README.md)。
