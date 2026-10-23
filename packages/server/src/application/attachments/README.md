# 附件应用服务

接收附件，协调存储、完整性检查和会话中的附件使用。

## 入口与流程

`AttachmentService` 处理登记与读取，`createDaemonAttachmentServices()` 组装依赖；随后交给 routing 决定输入方式，resources 提供会话资源，tools 提供受控读取。

## 状态归属

附件记录与内容由 services 的存储能力管理；本目录持有服务依赖和处理期间的数据。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [attachment-service.ts](./attachment-service.ts) | `AttachmentServiceOptions`、`ImportAttachmentInput`、`OpenAttachmentContentResult`、`ResolvedAttachmentContentPath` 等 |
| [daemon-attachment-services.ts](./daemon-attachment-services.ts) | `createDaemonAttachmentServices` |

## 子目录

| 目录 | 用途 |
| --- | --- |
| [resources/](./resources/README.md) | 把附件记录转换为会话运行和上下文压缩能够使用的资源。 |
| [routing/](./routing/README.md) | 结合模型与运行能力，决定图片等附件采用哪种输入方式。 |
| [tools/](./tools/README.md) | 提供附件地址解析、授权、文本读取与文字识别接入。 |

## 测试与维护

附件接收与总体组装放在这里；能力判断、模型资源和读取工具分别放入对应子目录。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
