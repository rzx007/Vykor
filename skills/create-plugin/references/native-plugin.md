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
| 交互 UI | `"apps": ["./ui/apps.json"]` | UI 定义，见 [插件 UI](plugin-apps.md) |

有 Node 工具时，可同时声明 `"runtime":{"engine":"node","isolation":"process"}`。不要把 schema 中的预留组件或其他产品的插件格式当作已开放能力。

Native 根 manifest 保持 schemaVersion 1；apps.json 使用 schemaVersion 1，Native Tool 通过 metadata.appData 提供页面数据。页面使用官方 MCP Apps API，具体接口见 [插件 UI](plugin-apps.md)。

默认完整工程由 `../scripts/create-plugin.mjs` 生成，源码在 `../templates/weather-travel/`。根 `plugin.config.json` 包含 `id`、`name`、`displayName`、`version`、`toolPrefix`、`backend`；`src/identity.mjs` 据此导出实际工具名称、`ui://<name>/panel` 和 `<name>://trip`。工具名称都由 `toolPrefix` 加业务 key 组成，清单、页面、后台与 Skill 使用同一身份来源。初始化新产品时运行生成器，避免只改展示名却继续注册旧工具。

## 市场图标与使用示例

在根 manifest 补充以下可选字段，市场与已安装详情共用这些信息；不是在 apps.json 或市场清单另维护一份：

```json
{
  "displayName": "文本助手",
  "description": "检查你提供的文本，标出格式问题。",
  "icon": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3QgeD0iMyIgeT0iMyIgd2lkdGg9IjE4IiBoZWlnaHQ9IjE4IiByeD0iNCIgZmlsbD0iIzRmNDZlNSIvPjwvc3ZnPg==",
  "introduction": "## 检查文本\n\n在右侧面板编辑文本并检查格式问题，也可以把选区引用到聊天继续讨论。",
  "prompts": [
    { "title": "检查文本", "prompt": "请使用文本助手检查我提供的文本，先说明问题，不修改文件。" }
  ]
}
```

- `icon` 使用图片 base64 data URI 或 HTTP(S) 地址；市场发布只使用 HTTPS。支持 PNG、JPEG、GIF、WebP、AVIF、SVG，整个字符串最多 1 MiB。包内图片在作者构建时编码成 data URI，不在清单写 `./icon.svg` 等相对路径，不使用 HTML、脚本或文件网址。
- `description` 写清用途；列表只显示一行，超出部分省略。`introduction` 是最多 65536 字符的 Markdown 详细介绍，说明实际功能与限制，不照抄简介。缺少内容时不填占位文字。
- `prompts` 最多 16 项，每项仅有 `title`、`prompt`；标题最多 100 字符、正文最多 16384 字符，去除首尾空白后都不能为空。示例描述用户可以发起的具体任务，不填工具参数或宿主内部字段，不假定拥有文件权限。
- `author`（name、email、url）、`license`、`keywords`、`homepage`、`repository` 也属于作者展示信息；市场网站地址使用 HTTPS。展示不会执行示例、调用工具或保存内容，安装权限来自实际包。市场示例只有在对应来源的安装回执确认成功且真实安装状态、权限可用后才能由用户点击使用。

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

注册上下文提供 `plugin`、`permissions`、`log(level, message)`；调用上下文提供 `plugin`、`permissions`、`cwd`、可选 `sessionId`、`runId`、`toolResult`，以及 `deadline`、`signal`。`plugin` 包含 `id`、`name`、`version`、`root`、`dataDir`；`deadline` 是 Unix 毫秒时间戳。

`cwd` 是工作区，`plugin.root` 是当前插件快照，`plugin.dataDir` 是宿主分配的稳定插件数据目录，不随安装版本和 cwd 改变。附属资源从 `plugin.root` 或模块相对 URL 读取，收藏、缓存、数据库等写入 `plugin.dataDir`；会话私有数据再按真实 `sessionId` 隔离。需要会话的数据操作缺少 sessionId 时应报错，不能退回共享默认会话。数据目录、会话 ID 和后台地址不得由工具参数指定。

`toolResultInput` 可声明哪个输入属性是之前的工具调用 ID；宿主只解析当前 Run 中真实、受限的结果，并通过只读 `context.toolResult` 提供 `toolUseId`、`toolName`、`content` 和可选 `isError`。它不是任意历史查询。没有 settings、terminal、jobs、工具注册表或统一密钥注入 API；不要猜测其他内部字段或宿主环境变量。

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

天气模板将网络查询、插件数据操作和工作区导出分成独立 Native 入口，构建到 `dist/native/network.mjs`、`data.mjs`、`export.mjs`。网络只访问固定的 `api.open-meteo.com`、`geocoding-api.open-meteo.com` HTTPS 地址，不接受任意 URL。有限自动保存只给 app-only 的 `SavePlanDraft`、`SetFavorite`；根清单声明 `permissions.pluginData: ["write"]`，页面后端为这两个精确工具配置 `authorization: "plugin-data-write"`，安装批准项为 `pluginData:write`。详细边界见 [插件 UI](plugin-apps.md)。模型的 `ApplyPlanOperations` 和工作区 `ExportPlan` 保留普通确认。

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

使用前必须替换成用户选择的真实服务。stdio 使用 `command` 和可选 `args`、`env`、`cwd`，http/sse 使用 `url`。宿主不会自动下载依赖、认证服务或给名称加前缀。静态加载成功不代表连接和工具发现成功。

安装插件的 stdio 配置支持以下**完整值**绑定；它不是任意字符串插值，`prefix-${VYKOR_PLUGIN_ROOT}` 等拼接不会展开：

```json
{
  "servers": {
    "my-weather": {
      "type": "stdio",
      "command": "node",
      "cwd": "${VYKOR_PLUGIN_ROOT}",
      "args": ["dist/server.mjs"],
      "env": {
        "VYKOR_WEATHER_DATA_DIR": "${VYKOR_PLUGIN_DATA_DIR}",
        "VYKOR_WEATHER_SESSION": "${VYKOR_SESSION_ID}",
        "VYKOR_WEATHER_WORKSPACE": "${VYKOR_WORKSPACE_ROOT}"
      }
    }
  }
}
```

`cwd` 的插件根和 dataDir 由插件加载阶段绑定，会话值与工作区由实际运行会话绑定；会话值是不透明标识，不能据此推断用户身份。天气 MCP 服务必须检查这三个环境变量存在且已解析，缺少时停止启动；不能退回 `process.cwd()`、临时目录或固定会话。不要从工具参数补入这些值，也不要把密钥放进配置。MCP 版本依赖打包到 `dist/server.mjs`，接收者安装 ZIP 后无需安装 node_modules。
