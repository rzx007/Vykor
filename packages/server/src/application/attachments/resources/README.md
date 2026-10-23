# 会话附件资源

把附件记录转换为会话运行和上下文压缩能够使用的资源。

## 入口与流程

`SessionAttachmentResources` 查询本会话可用附件；`buildCompactAttachmentSection()` 生成压缩上下文中的附件目录。

## 状态归属

附件事实来自存储；本目录生成资源引用与文本目录，不另建附件存储。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [compact-attachment-catalog.ts](./compact-attachment-catalog.ts) | `CompactAttachmentAssetQueries`、`CompactAttachmentSectionStore`、`CompactAttachmentSectionOptions`、`buildCompactAttachmentSection` |
| [session-attachment-resources.ts](./session-attachment-resources.ts) | `SessionAttachmentResourcesOptions`、`SessionAttachmentResources` |

## 测试与维护

会话资源整理和压缩提示放在这里，附件接收留在上层。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
