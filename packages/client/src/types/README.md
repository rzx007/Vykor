# 生命周期客户端类型

[index.ts](./index.ts) 是公开类型入口，供资源、同步模块和外部调用者共同使用。

| 文件 | 定义内容 |
| --- | --- |
| [index.ts](./index.ts) | `VykorClientOptions`、会话创建/输入/队列/恢复/Goal 请求与响应 |
| [attachment-types.ts](./attachment-types.ts) | `UploadAttachmentInput`、`DownloadAttachmentOptions` |
| [file-types.ts](./file-types.ts) | 会话工作区文件请求、结果与取消选项 |
| [runtime-types.ts](./runtime-types.ts) | 模型、Agent persona、技能、会话 MCP 的只读描述 |
| [sync-types.ts](./sync-types.ts) | `SessionBucket`、`VykorClientState`、同步选项与更新 |

daemon 保存持久记录，类型只约定请求及返回形状；本地会话视图由 state 模块构造。metadata、工具输入与输出保留通用扩展数据。

笔记、渠道、调度、插件、Office 和管理配置等业务类型位于 [私有应用客户端](../../../application-client/README.md)。公开 `AdmitClientPromptInput` 不含 `pluginAppContexts`，该字段由私有客户端扩展。新增类型按所属资源放置，跨分类公开契约用本包根层 `__test__/` 验证。
