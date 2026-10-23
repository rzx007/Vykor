# 运行与维护数据

定义能力握手、运行配置、任务、终端、调度和维护信息。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [capabilities.ts](./capabilities.ts) | `CURRENT_PROTOCOL_VERSION`、`PROTOCOL_VERSION_HEADER`、`ProtocolVersion` |
| [execution-observability.ts](./execution-observability.ts) | `EXECUTION_KINDS`、`EXECUTION_OUTCOMES`、`EXECUTION_FAILURE_KINDS` |
| [job.ts](./job.ts) | 统一导出本分类的类型与函数 |
| [maintenance.ts](./maintenance.ts) | `UsageFilter`、`UsageRequest`、`UsageReport` |
| [runtime-config.ts](./runtime-config.ts) | `readRuntimeMetadata`、`readSessionRuntimeRevision` |
| [scheduled.ts](./scheduled.ts) | `CreateScheduledTaskInput`、`UpdateScheduledTaskInput` |
| [terminal.ts](./terminal.ts) | 统一导出本分类的类型与函数 |

## 入口与处理步骤

主要入口或定义见 [capabilities.ts](./capabilities.ts)。

客户端先读取服务端能力，再发送相关运行请求；任务、终端和维护服务使用这些结构返回结果。

## 状态放在哪里

这里只定义和校验传输数据；业务数据由 Services 保存，客户端展示状态由 Client 保存。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
