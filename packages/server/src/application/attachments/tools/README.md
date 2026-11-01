# 附件读取工具

提供附件地址解析、授权、图片及文本读取与文字识别接入。

## 入口与流程

`createAttachmentReadTool()` 接收工具请求，解析 `attachment://` 地址，并按当前会话的持久附件引用验证访问范围。图片通过 `createAttachmentImageReader()` 重新读取原始字节，校验大小、SHA-256 和引用状态；支持图片的模型收到原生图片，否则只返回本地 OCR 识别的文字或明确的能力错误。文本及 Office 文件继续由文本读取器分段返回。

`AttachmentImageReader` 同时供图片加工工具使用；它返回宿主内部的原始字节和内容路径，调用方可将字节转换为图像接口所需的数据地址。原始存储路径不会进入模型文本或摘要。读取不依赖上传时的内存状态、运行许可或工作目录文件。

## 状态归属

授权以 `session_input_attachment` 中的会话引用，或本会话中已完成、已提交并由图片生成工具写入的附件消息部分为依据。生成图还须对应同一消息中已成功完成并提交的 `ImageGeneration` 调用，不能只信工具返回的来源标记。每次读取重新检查；输入或生成图消息被删除后不能继续读取。仅有附件资产或普通消息元数据不能取得权限。内容与识别结果由传入的存储和服务提供，原图保持不变。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [attachment-access.ts](./attachment-access.ts) | 会话授权，以及 `AttachmentTextReader`、`AttachmentImageReader` 和本地 OCR 的读取入口 |
| [attachment-read-tool.ts](./attachment-read-tool.ts) | `createAttachmentReadTool` |
| [attachment-uri.ts](./attachment-uri.ts) | `attachmentResourceUri()` 统一生成资源地址；`isAttachmentUri()`、`parseAttachmentUri()` 识别和解析地址 |

## 测试与维护

读取工具、地址协议和附件访问适配放在这里；模型原生输入能力放在 routing。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
