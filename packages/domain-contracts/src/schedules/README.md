# 计划任务记录

定义计划任务如何描述，以及每次执行结果需要保存哪些字段。

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | `@vykor/domain-contracts/schedules` 公开入口 |
| [records.ts](records.ts) | 计划任务、执行记录、权限范围、重叠与错过执行策略、停止条件 |

消费方读取 `ScheduledTaskRecord` 中的时间规则、时区、目标聊天或项目等字段，安排执行后用 `ScheduledRunRecord` 描述结果。这里仅定义数据，没有解析时间规则或启动任务的运行流程。

下次执行时间、任务状态、执行次数和未读标记都由消费方管理。新增计划任务字段放 `records.ts`，相关测试建议放同层 `__test__/`。
