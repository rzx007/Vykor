# 业务共用契约源码

每个领域目录的 `index.ts` 对应一个公开子入口，本目录没有总 `index.ts`。入口映射以 [../package.json](../package.json) 为准。

| 目录 | 公开入口 | 用途 |
| --- | --- | --- |
| [sessions](sessions/README.md) | `@vykor/domain-contracts/sessions` | 会话、运行与消息记录 |
| [inputs](inputs/README.md) | `@vykor/domain-contracts/inputs` | 用户输入项、附件引用与输入校验 |
| [goals](goals/README.md) | `@vykor/domain-contracts/goals` | 持续目标、预算、等待和操作校验 |
| [attachments](attachments/README.md) | `@vykor/domain-contracts/attachments` | 附件资源、转换结果和格式校验 |
| [schedules](schedules/README.md) | `@vykor/domain-contracts/schedules` | 计划任务与执行记录 |
| [channels](channels/README.md) | `@vykor/domain-contracts/channels` | 外部聊天绑定与消息投递记录 |
| [notes](notes/README.md) | `@vykor/domain-contracts/notes` | 笔记记录与写入校验 |
| [memory](memory/README.md) | `@vykor/domain-contracts/memory` | 记忆条目和版本约束 |
| [approvals](approvals/README.md) | `@vykor/domain-contracts/approvals` | 权限审批与自动评审记录 |
| [plugin-apps](plugin-apps/README.md) | `@vykor/domain-contracts/plugin-apps` | 插件应用数据、请求校验与只读历史数据 |
| [workspace-changes](workspace-changes/README.md) | `@vykor/domain-contracts/workspace-changes` | 工作目录变更摘要与只读解析 |
| [usage](usage/README.md) | `@vykor/domain-contracts/usage` | 模型价格与用量预算设置 |
| [maintenance](maintenance/README.md) | `@vykor/domain-contracts/maintenance` | 保留策略与备份清单 |

[validation-error.ts](validation-error.ts) 定义 `DomainValidationError`，保存请求校验失败的字段和原因；它由输入校验入口再次导出。领域校验函数接收未知值，验证形状、范围或版本，再返回数据或校验错误。

这些定义不持有会话、任务或附件状态。记录的保存、状态迁移和实际副作用由消费方负责；只读解析函数不会修改已有记录。

新增源码放对应领域目录，入口在该目录汇总并按需补充包导出。单领域测试放该目录的 `__test__/`，共用错误或跨领域测试建议放本层 `__test__/`。
