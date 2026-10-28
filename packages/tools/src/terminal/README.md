# 终端工具

通过终端服务创建或操作终端会话。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [index.ts](./index.ts) | 统一导出本分类的类型与函数 |
| [service-command.ts](./service-command.ts) | `isPersistentServiceCommand` |
| [terminal-tools.ts](./terminal-tools.ts) | `createTerminalTools` |

## 入口与处理步骤

主要入口或定义见 [index.ts](./index.ts)。

解析终端命令及会话标识，经宿主终端服务提交操作，再把终端状态和结果返回给模型。

TerminalOpen 使用执行环境的 `workspace.hostRoot` 调用会话宿主；WSL 等环境内的 `executionRoot` 用于实际工具执行，不代替宿主会话目录。没有注入环境时沿用调用目录。

## 状态放在哪里

单次调用保存输入、取消信号和执行结果；文件、进程及任务状态由注入的宿主接口或目标系统保存。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
