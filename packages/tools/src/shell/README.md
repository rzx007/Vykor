# Shell 执行

选择并调用宿主 Shell，整理输出、错误、超时和执行记录。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [executor.ts](./executor.ts) | `DEFAULT_SHELL_TIMEOUT_MS`、`DefaultShellExecutorDependencies`、`DefaultShellExecutor` |
| [index.ts](./index.ts) | 统一导出本分类的类型与函数 |
| [output.ts](./output.ts) | `DEFAULT_MAX_OUTPUT_CHARS`、`createBoundedOutputCollector`、`decodeShellChunk` |
| [shell.ts](./shell.ts) | `createShellTool`、`shellTool`、`createShellDescription` |
| [trace-eval.ts](./trace-eval.ts) | `ShellTraceEvent`、`evaluateShellTrace` |
| [types.ts](./types.ts) | `ShellExecRequest`、`ShellExecContext`、`ShellRunnerMode` |

## 入口与处理步骤

主要入口或定义见 [index.ts](./index.ts)。

工具解析命令及执行配置，执行器准备宿主调用，持续处理输出与取消，最后汇总退出状态和日志。

## 状态放在哪里

活动进程由执行器和宿主接口管理，单次输出及执行记录在调用期间累计。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
