# Native Plugin 接口

## manifest 与目录

唯一入口是插件根目录下的 `.vykor-plugin/plugin.json`。以下为可用的 Skill-only 插件：

```json
{
  "schemaVersion": 1,
  "id": "example.my-plugin",
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Explain supplied text",
  "components": { "skills": ["./skills/explain/SKILL.md"] }
}
```

ID 使用稳定的点分名称，name 使用小写连字符名称。组件路径必须以 `./` 开头、相对于插件根目录，不能越出根目录或指向符号链接。不要在 manifest 保存启用状态、安装批准、凭据或进程状态。

| 组件 | components 中的声明 | 文件内容 |
| --- | --- | --- |
| Skill | `"skills": ["./skills/explain/SKILL.md"]` | YAML frontmatter 与操作说明 |
| Agent | `"agents": ["./agents/reviewer.md"]` | Agent frontmatter 与角色说明 |
| Hook | `"hooks": ["./hooks/hooks.json"]` | Native 事件名与执行配置 |
| MCP | `"mcpServers": ["./mcp/servers.json"]` | `servers` 对象 |
| Node 工具 | `"tools": [{"entry":"./tools/index.mjs","runtime":"node","permissions":[]}]` | 导出 `registerTools` |
| 交互 UI | `"ui": ["./ui/manifest.json"]` | UI 定义，见 [插件 UI](plugin-ui.md) |

有 Node 工具时，可同时声明 `"runtime":{"engine":"node","isolation":"process"}`。不要把 schema 中的预留组件或其他产品的插件格式当作已开放能力。

## Native Tool

最小工具实现，保存为 `tools/index.mjs`：

```js
export const registerTools = registration => [{
  name: "MyPluginEcho",
  description: "Return the supplied text without reading or writing files",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", maxLength: 1000 } },
    required: ["text"],
    additionalProperties: false
  },
  safeToRetry: true,
  invoke(input, context) {
    context.signal.throwIfAborted();
    if (typeof input.text !== "string") throw new TypeError("text must be a string");
    return { content: [{ type: "text", text: input.text }] };
  }
}];
```

`registerTools` 和 `invoke` 都可以异步返回。工具名称是全局名称，不会自动加插件前缀，因此要选择独特名称。静态校验、导入不会执行入口；激活时才由 Tool Host 子进程 import。

注册上下文提供 `plugin`、`permissions`、`log(level, message)`；调用上下文提供 `plugin`、`permissions`、`cwd`、可选 `sessionId`、`deadline`、`signal`。`plugin` 包含 id、name、version、root；deadline 是 Unix 毫秒时间戳。

`cwd` 是项目目录，`plugin.root` 才是插件自己的根目录。读取附属资源时用 `context.plugin.root` 或模块相对 URL。没有 settings、terminal、jobs、工具注册表、统一密钥或持久数据注入 API；不要猜测内部字段或宿主环境变量。

返回 `ToolResult`：必需的 `content` 数组，加可选 `isError`、`failureKind`、`metadata`。不要直接返回字符串。输入的关键业务条件还应自行检查；宿主只支持常用 JSON Schema 约束，不是完整实现。`maxLength` 按 UTF-16 代码单元计数。

异步工作使用 signal 取消底层请求并释放资源。同步循环要有工作量上限。只有重复执行不会产生重复副作用的工具才设 `safeToRetry: true`。日志不能写用户正文、凭据或完整参数。

### 权限

纯文本工具不需要文件或网络权限。工作区读取工具的局部 manifest 示例：

```json
{
  "permissions": { "filesystem": ["workspace:read"] },
  "components": {
    "tools": [{
      "entry": "./tools/index.mjs",
      "runtime": "node",
      "permissions": ["filesystem:workspace:read"]
    }]
  }
}
```

批准项是 `filesystem:workspace:read` 和 `tool:filesystem:workspace:read`；不是 `workspace.read`。插件级声明与 Tool 条目请求必须匹配，不要为了消除错误请求所有权限。其他权限从当前安装预览中确认，不凭空编造。

Node Tool 目前仅在 local 环境激活。子进程隔离不是完整系统调用沙箱，权限声明不等于 Node 文件 API 被自动拦截。不得把本地路径直接用于 WSL/远程环境。

## 其他组件

Skill 文件示例：

```markdown
---
name: explain
description: Explain text supplied by the user using MyPluginEcho.
---

Call MyPluginEcho with exactly the supplied text. Do not trim or rewrite it first.
```

Skill 命令名使用插件 **name** 前缀，例如 `my-plugin:explain`。附属资源放在 Skill 旁，保留相对位置。不要为用户添加脚本自动执行行为。

Agent 文件示例：

```markdown
---
name: reviewer
description: Explain supplied text with the plugin tool.
tools:
  - MyPluginEcho
maxTurns: 3
---

Call MyPluginEcho and explain its actual result.
```

Agent 名称使用插件 **id** 前缀，例如 `example.my-plugin:reviewer`。它不会绕过当前插件选择或工具权限；嵌在 Agent 文件里的 hooks/mcpServers 不直接激活，要用独立组件声明。

Hook 文件示例：

```json
{"pre_tool_use":[{"type":"command","command":"node --version","timeout":1000,"blockOnFailure":false}]}
```

事件名包括 session_start、session_end、pre_compact、post_compact、pre_tool_use、post_tool_use、user_prompt_submit、notification、stop、subagent_stop。识别 command、http、prompt、agent 类型；后两者还取决于宿主配置。命令通常在项目 cwd 执行，不会自动切到插件目录；不要假定相对脚本路径或插件根目录变量可用。

MCP 文件示例：

```json
{"servers":{"my-docs":{"type":"http","url":"https://service.example.invalid/mcp"}}}
```

使用前必须替换成用户选择的真实服务。stdio 用 command 和可选 args/env，http/sse 用 url。宿主不会自动下载依赖、认证服务、展开插件根变量或给名称加前缀。静态加载成功不代表连接和工具发现成功。
