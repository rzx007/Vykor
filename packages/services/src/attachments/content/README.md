# 附件文本处理

提供不依赖存储的附件文本分类与提取辅助能力。

## 入口与流程

调用方传入附件类型和文本，通过 `attachment-text.ts` 生成适合后续读取或上下文使用的内容。

## 状态归属

函数使用传入的数据，不保存附件记录或文件。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [attachment-text.ts](./attachment-text.ts) | `AttachmentCandidateKind`、`AttachmentTextEncoding`、`AttachmentCandidateInput` 等 |

## 测试与维护

纯文本处理放在这里，内容读写放在 storage，图片或文字识别放在 processing。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
