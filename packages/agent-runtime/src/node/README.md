# Node 本机接入

为执行核心接入本机配置、模型客户端、文件系统、终端、工具和插件。默认入口是 `agent/default-agent.ts` 中的 `createDefaultNodeAgent()`。

| 分类 | 职责 |
| --- | --- |
| [agent/](./agent/README.md) | agent 配置、组装、对外操作与默认工厂 |
| [runtime/](./runtime/README.md) | 运行资源、构造器、接入协调与资源释放 |
| [capabilities/](./capabilities/README.md) | 确定哪些能力可用，登记每次运行固定的能力范围 |
| [children/](./children/README.md) | 子 agent 的配置继承、工作目录和本机管理 |
| [configuration/](./configuration/README.md) | 请求配置、模型选择和客户端选择 |
| [definitions/](./definitions/README.md) | 读取本地 agent 定义 |
| [environment/](./environment/README.md) | 终端与执行环境状态 |
| [tools/](./tools/README.md) | 工具工厂接入、可见范围和运行前准备 |
| [plugins/](./plugins/README.md) | 插件发现、启用、选择和能力快照 |
| [plugin-apps/](./plugin-apps/README.md) | 捕获应用后端，校验并执行应用工具调用 |
| [mcp/](./mcp/README.md) | MCP 认证与配置回写 |
| [memory/](./memory/README.md) | 记忆操作和压缩补充上下文 |
| [jobs/](./jobs/README.md) | 将本地执行和子任务接入统一 Job 接口 |
| [review/](./review/README.md) | 配置驱动的权限审查 |
| [workflow/](./workflow/README.md) | 工作流宿主、运行仓库与 worker 执行 |

组装层先确定能力与资源归属，再创建运行资源，最后提供 agent 实例。提交时固定本次允许的工具与插件，执行结束后按归属释放资源。通用运行状态放在 `../kernel/`，本机连接和配置留在本层。

测试放在各分类自己的 `__test__/`。新增代码优先使用上表已有分类，仅在承担新的明确职责时增加目录。
