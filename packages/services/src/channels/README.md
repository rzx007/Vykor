# 渠道会话与投递记录

保存外部渠道会话映射、消息投递结果及平台附加信息。

## 入口与流程

`ChannelRepository` 查找或更新外部会话和投递记录，记录转换函数负责字段和平台信息的编码与解码。

## 状态归属

渠道事实保存在 SQLite，网络连接和消息发送由调用方的渠道运行服务负责。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [channel-records.ts](./channel-records.ts) | `externalConversationFromRow`、`channelDeliveryFromRow`、`encodePlatformMeta` 等 |
| [channel-repository.ts](./channel-repository.ts) | `ExternalConversationKey`、`UpsertExternalConversationInput`、`CreateChannelDeliveryInput` 等 |
| [index.ts](./index.ts) | 汇总本分类的接口 |

## 测试与维护

渠道持久记录与查询规则放在这里，连接生命周期与应用消息桥接由其他包提供。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
