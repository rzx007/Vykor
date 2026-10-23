# 后台 Shell 工具

访问和控制宿主维护的后台 Shell 任务。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [background-shell-tools.ts](./background-shell-tools.ts) | `createBackgroundShellTool`、`backgroundShellCreateTool` |
| [index.ts](./index.ts) | 统一导出本分类的类型与函数 |

## 入口与处理步骤

主要入口或定义见 [index.ts](./index.ts)。

解析目标任务及操作，调用后台 Shell 宿主接口，再返回输出或控制结果。

## 状态放在哪里

单次调用保存输入、取消信号和执行结果；文件、进程及任务状态由注入的宿主接口或目标系统保存。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
