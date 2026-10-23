# 飞书与 Lark

负责机器人长连接、平台消息转换、回复及附件，以及接入前的扫码注册和凭据验证。公开入口是 `@vykor/channels` 的 [`../../index.ts`](../../index.ts)。

| 文件 | 用途 |
| --- | --- |
| [feishu.ts](feishu.ts) | `FeishuAdapter`、`FeishuConfig`，消息收发和附件下载 |
| [feishu-registration.ts](feishu-registration.ts) | `FeishuRegistration`，扫码接入状态与所需权限范围 |
| [feishu-verify.ts](feishu-verify.ts) | `verifyFeishuCredentials`，验证应用凭据并返回机器人信息 |
| [__test__](__test__) | 消息转换、连接、注册和凭据验证测试 |

`connect()` 创建 SDK 客户端与长连接，收到平台事件后整理发送者、聊天、线程和附件信息，再调用管理器注册的回调。`send()` 按消息类型调用平台接口。`FeishuRegistration.start()` 发起扫码接入，`status()` 返回进度，成功凭据交给注入的 `onCredentials` 保存。

SDK 客户端和消息回调由适配器实例保存；扫码尝试、取消信号与状态快照由注册实例保存。应用凭据的长期存储由宿主承担，本目录不保存配置文件。

飞书协议和接入流程放在本目录，通用路由留在 `core/`。测试放到同层 `__test__/`。返回[适配器导航](../README.md)。
