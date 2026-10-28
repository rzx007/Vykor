# Agent 工具

向运行时提交子 Agent 与团队相关操作。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [agent-tools.ts](./agent-tools.ts) | `createAgentTool`、`CreateAgentToolOptions` |
| [index.ts](./index.ts) | 统一导出本分类的类型与函数 |
| [team.ts](./team.ts) | `createTeamTools` |

## 分类目录

| 目录 | 用途 |
| --- | --- |
| [workflow/](./workflow/README.md) | 把工具调用转换为工作流运行请求。 |

## 入口与处理步骤

主要入口或定义见 [index.ts](./index.ts)。

工具解析模型输入，经宿主接口提交 Agent 或团队操作，再把状态与结果返回给模型。

## 状态放在哪里

单次调用保存输入、取消信号和执行结果；文件、进程及任务状态由注入的宿主接口或目标系统保存。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。

Agent.maxTurns 说明工作循环额度，调用方只能收紧预算，最后一轮预留给无工具总结。5 轮最多包含 4 轮普通工作；参数不表示秒数或底层网络尝试次数。实际额度仍由 Runtime 和 Core 接纳并执行。
