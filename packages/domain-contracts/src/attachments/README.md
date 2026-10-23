# 附件资源契约

统一附件资源、用户引用、转换结果、聊天来源和大小限制的数据形状。

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | `@vykor/domain-contracts/attachments` 公开入口 |
| [records.ts](records.ts) | 资源、输入引用、转换结果、来源及上传限制类型 |
| [validation.ts](validation.ts) | 校验限制之间的关系、资源记录必需字段及聊天来源 |
| [media-types.ts](media-types.ts) | Office 媒体类型和按文件扩展名判断格式的 `officeFormat` |

调用方用 `parseAttachmentLimits` 校验限制，用 `parseAttachmentAssetRecord` 校验资源记录；已就绪或已删除的资源必须带媒体类型、大小和摘要。`officeFormat` 只根据文件名识别扩展名，不读取文件内容。

文件正文、上传进度、转换作业和资源记录由消费方保存，本目录不上传或转换附件。新增附件定义和校验放本目录，测试建议放同层 `__test__/`。
