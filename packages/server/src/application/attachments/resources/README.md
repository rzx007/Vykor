# 会话附件资源

把附件记录转换为会话运行和上下文压缩能够使用的资源。

## 入口与流程

`restoreSessionAttachmentHistory()` 在 daemon loader 新建会话执行实例时，核对历史消息与数据库中的会话、原输入附件引用，再通过 `AttachmentCapabilityRouter` 按当前模型和工具能力恢复内容。恢复结果由 `buildAgentTranscript()` 合并到对应的用户消息；编辑重发、空闲回收、服务重启共用这个入口。

每个附件都保留稳定的 `attachment://` 地址，供 Read 重读及 ImageGeneration 使用。单个附件丢失、权限不符或当前能力不支持时，保留明确的资源状态并继续恢复其他附件；不复用数据库中保存的本地路径。

`SessionAttachmentResources` 管理运行期间的临时只读文本文件；`buildCompactAttachmentSection()` 生成压缩上下文中的附件目录，图片和 Office 文件也保留按需读取入口。

`preserveCompactedAttachments()` 在手动压缩保存前复用授权判定，保留生成图引用和最小调用凭据；仍在近期消息中的附件留在原生成调用旁，已摘要的引用归入现有压缩完成记录。模型只接收有界 URI 目录，原参数、结果和图片字节不会被复制进归档凭据。重复压缩按资产去重；载体消息或会话删除后，既有授权查询会撤销读取权限。

## 状态归属

附件事实来自存储；本目录生成资源引用与文本目录，不另建附件存储。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [compact-attachment-catalog.ts](./compact-attachment-catalog.ts) | `CompactAttachmentAssetQueries`、`CompactAttachmentSectionStore`、`CompactAttachmentSectionOptions`、`buildCompactAttachmentSection` |
| [compact-generated-attachments.ts](./compact-generated-attachments.ts) | `preserveCompactedAttachments`，在压缩时保留可信生成图与可发现的资源地址 |
| [session-attachment-resources.ts](./session-attachment-resources.ts) | `SessionAttachmentResourcesOptions`、`SessionAttachmentResources` |
| [session-attachment-history.ts](./session-attachment-history.ts) | `restoreSessionAttachmentHistory`，按会话权限和当前能力恢复历史附件 |

## 测试与维护

会话资源整理和压缩提示放在这里，附件接收留在上层。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
