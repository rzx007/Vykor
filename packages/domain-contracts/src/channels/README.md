# 外部聊天与投递记录

定义外部平台聊天如何关联内部会话，以及一次回复投递的结果。

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | `@vykor/domain-contracts/channels` 公开入口 |
| [records.ts](records.ts) | 外部聊天绑定、消息投递状态和重试次数等记录字段 |

消费方用 `ExternalConversationRecord` 保存平台账号、聊天或话题与会话的对应关系，用 `ChannelDeliveryRecord` 描述关联输入、运行和外部消息的投递结果。这里仅定义数据，不接收或发送消息，也不自动重试。

聊天绑定、投递正文、外部消息标识及状态由消费方保存。新增渠道共用字段放本目录，相关测试建议放同层 `__test__/`。
