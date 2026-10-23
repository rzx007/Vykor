# 附件领域

管理附件状态、限制、输入引用和错误，并汇总附件子目录。

## 入口与流程

附件登记与事务由 persistence 处理，原始内容由 storage 保存，图片和文字识别由 processing 处理；`normalizePromptAttachments()` 整理消息中的附件引用并检查重复。

## 状态归属

附件元数据位于数据库，内容位于 Blob 目录；当前操作的引用和处理结果由调用方持有。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [attachment-errors.ts](./attachment-errors.ts) | `AttachmentErrorCode`、`AttachmentError`、`isAttachmentError` |
| [attachment-policy.ts](./attachment-policy.ts) | `DEFAULT_ATTACHMENT_LIMITS` |
| [index.ts](./index.ts) | 汇总本分类的接口 |
| [prompt-attachments.ts](./prompt-attachments.ts) | `NormalizedPromptAttachment`、`ReferencedAttachmentSize`、`normalizePromptAttachments` 等 |

## 子目录

| 目录 | 用途 |
| --- | --- |
| [content/](./content/README.md) | 提供不依赖存储的附件文本分类与提取辅助能力。 |
| [persistence/](./persistence/README.md) | 保存附件资产、表示形式、使用许可及其状态变化。 |
| [processing/](./processing/README.md) | 准备图片输入，并通过本地识别引擎读取图片文字。 |
| [storage/](./storage/README.md) | 管理原始文件、内容校验、文件名和媒体类型识别。 |

## 测试与维护

附件领域规则和公开导出留在本层，记录、内容保存及处理能力分别放入下方子目录。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
