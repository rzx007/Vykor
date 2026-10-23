# 定时计划与执行历史

保存定时计划、执行历史，并计算下一次触发时间。

## 入口与流程

ScheduleRepository 管理计划和运行记录；recurrence 校验一次性时间、RRULE 和时区，并按当前时间计算下次执行。

## 状态归属

计划与执行历史保存在 SQLite，唤醒计时器和任务执行由守护进程管理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [commands.ts](./commands.ts) | `CreateScheduledTaskInput`、`UpdateScheduledTaskInput`、`CreateScheduledRunInput` 等 |
| [index.ts](./index.ts) | 汇总本分类的接口 |
| [recurrence.ts](./recurrence.ts) | `ScheduledRecurrence`、`NextOccurrenceOptions`、`validateScheduledRecurrence` 等 |
| [schedule-records.ts](./schedule-records.ts) | `encodeScheduleValue`、`withoutUndefined`、`scheduledTaskFromRow` 等 |
| [schedule-repository.ts](./schedule-repository.ts) | `ScheduleRepository` |

## 测试与维护

计划存储、重复规则和记录转换放在这里，何时唤醒及如何进入会话由应用层处理。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
