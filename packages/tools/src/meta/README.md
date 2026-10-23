# 辅助交互工具

提供询问用户、简报、设置、Skill、等待、待办及工具检索。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [ask-user.ts](./ask-user.ts) | `askUserTool` |
| [brief.ts](./brief.ts) | `briefTool` |
| [config.ts](./config.ts) | `createConfigTool` |
| [index.ts](./index.ts) | 统一导出本分类的类型与函数 |
| [skill.ts](./skill.ts) | `hostPathDirectory`、`createSkillTools`、`createCapturedSkillCatalog` |
| [sleep.ts](./sleep.ts) | `sleepTool` |
| [todo-write.ts](./todo-write.ts) | `todoWriteTool` |
| [tool-search-index.ts](./tool-search-index.ts) | `ToolSearchIndex` |
| [tool-search.ts](./tool-search.ts) | `toolSearchTool` |

## 入口与处理步骤

主要入口或定义见 [index.ts](./index.ts)。

解析模型提交的辅助操作，调用对应宿主接口或检索逻辑，再返回结果或用户输入。

## 状态放在哪里

单次调用保存输入、取消信号和执行结果；文件、进程及任务状态由注入的宿主接口或目标系统保存。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
