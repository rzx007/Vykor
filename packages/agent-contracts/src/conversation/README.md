# 消息与只读集合

定义模型、工具和运行方共用的消息形状，并提供只读集合构造函数。

| 文件 | 用途 |
| --- | --- |
| [messages.ts](messages.ts) | 用户、助手、工具结果消息，以及文字、图片、工具调用内容块 |
| [collections.ts](collections.ts) | `readonlySet`、`readonlyMap`，复制集合并仅暴露读取能力 |

公开入口是 `@vykor/agent-contracts`，由 [../index.ts](../index.ts) 汇总。消费方按消息类型构造内容，再交给模型客户端、展示层或存储层。消息定义本身不追加历史、不读取图片文件。

消息历史由消费方持有。集合函数在返回对象内部持有数据；`readonlyMap` 的模块级 `WeakSet` 仅识别已经创建的只读视图，不保存会话状态。新增消息或集合辅助函数放本目录，测试放 [__test__](__test__/)。
