# 附件输入方式选择

结合模型与运行能力，决定图片等附件采用哪种输入方式。

## 入口与流程

能力函数归一化模型声明，`AttachmentCapabilityRouter` 按有效能力生成路由结果或明确错误，交给会话输入处理继续组装。

## 状态归属

判断依赖当前模型与附件信息；结果属于当前输入，不维护长期缓存。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [attachment-capabilities.ts](./attachment-capabilities.ts) | `supportsNativeImageInput`、`modelInputCapabilities`、`normalizeInputSupport`、`resolveEffectiveImageSupport` 等 |
| [attachment-capability-router.ts](./attachment-capability-router.ts) | `ReadyAttachmentText`、`AttachmentCapabilityRouterOptions`、`AttachmentCapabilityRouter` |
| [attachment-routing-types.ts](./attachment-routing-types.ts) | `AttachmentRoutingErrorCode`、`AttachmentRoutingDecision`、`RouteAttachmentBatchInput`、`NativeAttachmentRouteResult` 等 |

## 测试与维护

新增附件类型的能力判断与路由规则放在这里，并在同层测试覆盖支持和拒绝情况。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
