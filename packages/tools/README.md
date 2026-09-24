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
