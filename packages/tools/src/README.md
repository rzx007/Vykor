# 内置工具源码导航

把模型发起的工具调用交给文件、Shell、网络或注入的宿主接口处理。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [index.ts](./index.ts) | 统一导出本分类的类型与函数 |

## 分类目录

| 目录 | 用途 |
| --- | --- |
| [agent/](./agent/README.md) | 向运行时提交子 Agent 与团队相关操作。 |
| [background-shell/](./background-shell/README.md) | 访问和控制宿主维护的后台 Shell 任务。 |
| [channels/](./channels/README.md) | 提供通过消息渠道发送内容的工具入口。 |
| [file/](./file/README.md) | 组织读写工具、文件基础操作、路径和内容处理。 |
| [job/](./job/README.md) | 查询或控制宿主管理的后台任务。 |
| [mcp/](./mcp/README.md) | 把已连接 MCP 能力包装成模型可调用的工具。 |
| [meta/](./meta/README.md) | 提供询问用户、简报、设置、Skill、等待、待办及工具检索。 |
| [mode/](./mode/README.md) | 提交计划模式及 Git worktree 相关操作。 |
| [notebook/](./notebook/README.md) | 读取或修改 Notebook 文档中的单元格。 |
| [ports/](./ports/README.md) | 定义工具依赖的配置、权限、文件、渠道、Skill、MCP 和工作流接口。 |
| [schedule/](./schedule/README.md) | 向宿主提交计划任务的读取与修改操作。 |
| [search/](./search/README.md) | 向模型提供文本搜索和语言服务工具。 |
| [shared/](./shared/README.md) | 复用工具执行时的取消信号处理。 |
| [shell/](./shell/README.md) | 选择并调用宿主 Shell，整理输出、错误、超时和执行记录。 |
| [terminal/](./terminal/README.md) | 通过终端服务创建或操作终端会话。 |
| [web/](./web/README.md) | 组织网络运行配置、搜索、抓取、网络限制和错误转换。 |

## 入口与处理步骤

主要入口或定义见 [index.ts](./index.ts)。

从包入口或各分类的工具工厂创建工具，传入宿主接口；执行时检查输入、调用对应能力，再返回标准工具结果。

## 状态放在哪里

单次调用保存输入、取消信号和执行结果；文件、进程及任务状态由注入的宿主接口或目标系统保存。

## 新代码与测试

根目录保留包入口和分类导航；具体实现放入对应分类。

新增跨分类测试放在本目录的 `__test__/`；只覆盖下级分类的测试放在对应分类的 `__test__/`。
