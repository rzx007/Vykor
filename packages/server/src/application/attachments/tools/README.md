# 附件读取工具

提供附件地址解析、授权、文本读取与文字识别接入。

## 入口与流程

`createAttachmentReadTool()` 接收工具请求，解析附件地址，验证当前会话访问范围，再通过文本读取器或文字识别服务返回内容。

## 状态归属

授权以会话和附件记录为依据；内容与识别结果由传入的存储和服务提供。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [attachment-access.ts](./attachment-access.ts) | `AttachmentSessionResolverQueries`、`AttachmentSessionReferenceQueries`、`AttachmentAuthorizationSessionResolver`、`AttachmentTextSlice` 等 |
| [attachment-read-tool.ts](./attachment-read-tool.ts) | `createAttachmentReadTool` |
| [attachment-uri.ts](./attachment-uri.ts) | `ParsedAttachmentUri`、`isAttachmentUri`、`parseAttachmentUri` |

## 测试与维护

读取工具、地址协议和附件访问适配放在这里；模型原生输入能力放在 routing。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
