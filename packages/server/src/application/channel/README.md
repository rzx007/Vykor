# 渠道应用与消息桥接

管理渠道配置、接入引导和外部消息到持久会话的转换。

## 入口与流程

应用服务处理渠道操作；运行组装连接渠道宿主；消息桥接为收到的消息生成稳定输入标识，提交会话并把结果送回原线程。

## 状态归属

渠道配置与会话记录经存储接口保存，活跃连接由 daemon 中的渠道运行服务持有。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [channel-application-service.ts](./channel-application-service.ts) | `ChannelSessionQueries`、`ChannelOperations`、`ChannelApplicationServiceContext`、`AttachmentImportPort` 等 |
| [channel-connector-labels.ts](./channel-connector-labels.ts) | `channelConnectorLabel` |
| [channel-onboarding-service.ts](./channel-onboarding-service.ts) | `RegistrationLike`、`ChannelOnboardingServiceOptions`、`ChannelOnboardingErrorCode`、`ChannelOnboardingError` 等 |
| [channel-runtime-assembly.ts](./channel-runtime-assembly.ts) | `createDaemonChannelRuntime` |
| [durable-channel-bridge.ts](./durable-channel-bridge.ts) | `DurableChannelPort`、`DurableChannelBridge` |
| [durable-channel-input-id.ts](./durable-channel-input-id.ts) | `durableChannelInputId` |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [query-models.ts](./query-models.ts) | `ChannelRuntimeState`、`ChannelDomain`、`ChannelConnectorRuntimeStatus`、`ChannelDenialNotice` 等 |

## 测试与维护

接入引导、消息归属与会话桥接放在这里；连接建立和关闭放在 daemon。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
