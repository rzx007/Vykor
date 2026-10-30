# @vykor/domain-contracts

保存各业务领域共用的数据定义和校验函数，让服务端、客户端和存储实现使用一致的字段。这里不创建数据库、不启动任务，也不直接管理业务状态。

## 目录导航

[src](src/README.md) 说明共用校验错误和源码组织。业务按下列目录拆分：

| 目录 | 用途 |
| --- | --- |
| [sessions](src/sessions/README.md) | 会话、运行与消息记录 |
| [inputs](src/inputs/README.md) | 用户输入项、附件引用与输入校验 |
| [goals](src/goals/README.md) | 持续目标、预算、等待和操作校验 |
| [files](src/files/README.md) | 会话工作区只读文件数据、错误和请求校验 |
| [attachments](src/attachments/README.md) | 附件资源、转换结果和格式校验 |
| [schedules](src/schedules/README.md) | 计划任务与执行记录 |
| [channels](src/channels/README.md) | 外部聊天绑定与消息投递记录 |
| [notes](src/notes/README.md) | 笔记记录与写入校验 |
| [memory](src/memory/README.md) | 记忆条目和版本约束 |
| [approvals](src/approvals/README.md) | 权限审批与自动评审记录 |
| [plugin-apps](src/plugin-apps/README.md) | 插件应用数据、请求校验与只读历史数据 |
| [workspace-changes](src/workspace-changes/README.md) | 工作目录变更摘要与只读解析 |
| [usage](src/usage/README.md) | 模型价格与用量预算设置 |
| [maintenance](src/maintenance/README.md) | 保留策略与备份清单 |

本包没有根导入入口。消费方通过 `@vykor/domain-contracts/sessions` 等领域子入口导入，对应各目录的 `index.ts`。额外的细分入口见 [package.json](package.json)，包括会话记录、模型元数据、运行配置、自动评审和旧插件 UI 历史读取。

调用方将外部数据交给对应解析或校验函数，取得受约束的数据后自行执行操作和保存记录。类型仅描述状态，校验函数只处理传入值，不替消费方改变状态。

新增领域放入 `src/<领域>/`，增加该目录的说明和公开导出。单领域测试放同层 `__test__/`，跨领域测试建议放 `src/__test__/`。
