# 附件内容存储

管理原始文件、内容校验、文件名和媒体类型识别。

## 入口与流程

Blob 存储接收内容并按校验值归档；完整性服务检查记录与实际文件；操作门控制导入、维护等操作之间的互斥。

## 状态归属

文件保存在 Blob 及暂存目录，附件记录通过传入的存储接口访问；操作许可保存在进程内。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [attachment-blob-store.ts](./attachment-blob-store.ts) | `AttachmentBlobStoreOptions`、`ImportAttachmentBlobInput`、`ImportedAttachmentBlob` 等 |
| [attachment-filename.ts](./attachment-filename.ts) | `decodeAttachmentFilename` |
| [attachment-integrity-service.ts](./attachment-integrity-service.ts) | `AttachmentIntegrityIssueCode`、`AttachmentIntegrityIssue`、`AttachmentIntegrityReport` 等 |
| [attachment-media-type.ts](./attachment-media-type.ts) | `sniffAttachmentMediaType`、`sniffOfficePackage` |
| [attachment-storage-operation-gate.ts](./attachment-storage-operation-gate.ts) | `AttachmentStorageOperationGate` |

## 测试与维护

附件文件写入、完整性、类型探测和存储互斥放在这里，数据库事务放在 persistence。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
