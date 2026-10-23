# @vykor/tools

Tool registry with built-in tools for file operations, shell execution, web requests, and more.

## 已注册工具 (15)

### Shell
- `Bash` - Execute bash commands

### File
- `Read` - Read file contents
- `Write` - Write file contents
- `Edit` - Edit file (replace)
- `Glob` - File glob matching

### Search
- `Grep` - Text search in files

### Web
- `WebFetch` - HTTP fetch
- `WebSearch` - Web search

### Meta
- `TodoWrite` - Append to TODO file
- `Config` - Read/update settings
- `Sleep` - Sleep for N seconds
- `Skill` - Read skill content
- `ToolSearch` - Search tools
- `AskUser` - Ask user question
- `Brief` - Truncate text

## 使用

```ts
import { createDefaultToolRegistry } from "@vykor/tools";

const registry = createDefaultToolRegistry();
const tools = registry.getAll();
```

## 扩展

```ts
registry.register({
  name: "MyTool",
  description: "My custom tool",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
  },
  execute: async (input, context) => {
    context.abortSignal?.throwIfAborted();
    return { content: [{ type: "text", text: "result" }] };
  }
});
```

### 执行契约

工具调用由 `QueryEngine` 统一包一层执行管线：

```text
ToolCall
  → inputSchema 校验
  → Permission
  → pre_tool_use hook
  → Timeout / AbortSignal
  → execute(input, context)
  → post_tool_use hook
  → Output Budget
```

工具作者需要注意：

- `inputSchema` 会在 `execute` 之前统一校验；无效输入不会进入工具函数。
- `context.abortSignal` 总是由 QueryEngine 注入。长耗时工具应监听它，或把它传给支持
  `AbortSignal` 的 API（如 `fetch`），以便统一超时时真正取消底层工作。
- 默认统一超时是 `300000ms`，可通过 `QueryEngineOptions.toolTimeoutMs` 或
  `VYKOR_TOOL_TIMEOUT_MS` 调整。
- 工具仍应保留领域内的错误处理和输出截断；统一 Output Budget 只负责限制结果回灌给模型的文本量。

## 测试

```bash
pnpm --filter @vykor/tools test
```

## 目录与维护

| 目录 | 用途 |
| --- | --- |
| [src/](./src/README.md) | 把模型发起的工具调用交给文件、Shell、网络或注入的宿主接口处理。 |
| [src/agent/](./src/agent/README.md) | 向运行时提交子 Agent 与团队相关操作。 |
| [src/background-shell/](./src/background-shell/README.md) | 访问和控制宿主维护的后台 Shell 任务。 |
| [src/channels/](./src/channels/README.md) | 提供通过消息渠道发送内容的工具入口。 |
| [src/file/](./src/file/README.md) | 组织读写工具、文件基础操作、路径和内容处理。 |
| [src/job/](./src/job/README.md) | 查询或控制宿主管理的后台任务。 |
| [src/mcp/](./src/mcp/README.md) | 把已连接 MCP 能力包装成模型可调用的工具。 |
| [src/meta/](./src/meta/README.md) | 提供询问用户、简报、设置、Skill、等待、待办及工具检索。 |
| [src/mode/](./src/mode/README.md) | 提交计划模式及 Git worktree 相关操作。 |
| [src/notebook/](./src/notebook/README.md) | 读取或修改 Notebook 文档中的单元格。 |
| [src/ports/](./src/ports/README.md) | 定义工具依赖的配置、权限、文件、渠道、Skill、MCP 和工作流接口。 |
| [src/schedule/](./src/schedule/README.md) | 向宿主提交计划任务的读取与修改操作。 |
| [src/search/](./src/search/README.md) | 向模型提供文本搜索和语言服务工具。 |
| [src/shared/](./src/shared/README.md) | 复用工具执行时的取消信号处理。 |
| [src/shell/](./src/shell/README.md) | 选择并调用宿主 Shell，整理输出、错误、超时和执行记录。 |
| [src/terminal/](./src/terminal/README.md) | 通过终端服务创建或操作终端会话。 |
| [src/web/](./src/web/README.md) | 组织网络运行配置、搜索、抓取、网络限制和错误转换。 |
| [test-helpers/](./test-helpers/README.md) | 创建工具测试使用的宿主和执行上下文。 |

入口与流程：从包入口或各分类的工具工厂创建工具，传入宿主接口；执行时检查输入、调用对应能力，再返回标准工具结果。

状态归属：单次调用保存输入、取消信号和执行结果；文件、进程及任务状态由注入的宿主接口或目标系统保存。

新增实现优先放入职责对应的分类；测试放在被测目录的 `__test__/`。迁移时同步公开导出目标、调用方导入、文档和旧引用清单。

```powershell
pnpm --filter @vykor/tools test
pnpm --filter @vykor/tools check-types
```
