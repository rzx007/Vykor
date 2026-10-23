# 渠道源码

[`index.ts`](index.ts) 定义 `ChannelMessage`、`ChannelAdapter` 和能力类型，并作为 `@vykor/channels` 的唯一公开入口导出实现。

| 目录 | 主要文件与职责 |
| --- | --- |
| [bus](bus/README.md) | `EventBus`、双向消息队列、发送者白名单判断 |
| [core](core/README.md) | `ChannelManager` 的启停、过滤和消息路由 |
| [adapters](adapters/README.md) | 各渠道的连接、收消息和发消息实现 |
| [__test__](__test__) | 包入口与跨分类行为测试 |

宿主从包入口创建实例并注入配置。入站消息经管理器检查后交给 `MessageBus`，回复通过同一总线返回管理器，再由适配器发送。连接与运行状态由管理器和适配器保存，待处理消息由总线保存，均为内存状态。

新增渠道放到 `adapters/<渠道名>/`，总线通用逻辑放到 `bus/`，渠道管理规则放到 `core/`。测试放在实现所属分类的 `__test__/`，跨分类测试留在本层。返回[包说明](../README.md)。
