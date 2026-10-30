# SDK 操作指南

此分类按调用任务解释公开资源，入口来自首页、快速开始和概念页。

| 页面 | 用途 |
| --- | --- |
| [sessions.mdx](./sessions.mdx) | 会话、稳定请求 ID、准入、队列、中断与恢复 |
| [permissions.mdx](./permissions.mdx) | 待审批观察、明确回复和批准撤销 |
| [sync-recovery.mdx](./sync-recovery.mdx) | 快照、全局回放、实时事件和断线恢复 |
| [files.mdx](./files.mdx) | 只读文件、预算、权限、平台和错误 |
| [attachments-jobs.mdx](./attachments-jobs.mdx) | 附件引用、下载流和完整 Job target |
| [structured-delivery.mdx](./structured-delivery.mdx) | 输出 Schema、交付回执和格式限制 |
| [errors-compatibility.mdx](./errors-compatibility.mdx) | HTTP、运行终态、重试规则和协议能力 |
| [local-service.mdx](./local-service.mdx) | 可选 Node 本机 daemon 管理 |

daemon 保存会话、执行、权限和事件，指南说明 SDK 怎样操作与读取它们。新增指南放在对应资源附近；优先链接已有状态或错误说明，不复制另一套规则。公开方法、参数和返回值对照 `packages/client/src/resources/`、`state/`、`types/` 及两个公开导出核对；文件平台与预算还需核对服务端契约。不要把私有应用客户端方法写进本站。
