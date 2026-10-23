# 模式与工作区工具

提交计划模式及 Git worktree 相关操作。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [index.ts](./index.ts) | 统一导出本分类的类型与函数 |
| [plan-mode.ts](./plan-mode.ts) | `enterPlanModeTool`、`exitPlanModeTool` |
| [worktree.ts](./worktree.ts) | `enterWorktreeTool`、`exitWorktreeTool` |

## 入口与处理步骤

主要入口或定义见 [index.ts](./index.ts)。

先读取操作输入与上下文，通过宿主接口修改模式或请求工作区操作，再返回执行结果。

## 状态放在哪里

单次调用保存输入、取消信号和执行结果；文件、进程及任务状态由注入的宿主接口或目标系统保存。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

新增测试放在本目录的 `__test__/`；跨分类用例放在共同目录的 `__test__/`。
