# 编写 OpenHarness 原生插件

> 状态：当前开发指南。

本文面向在本仓库内开发插件的作者。可以从 [文本检查助手](../examples/plugins/text-inspector/README.md) 开始：它包含一个 Skill、一个 Plugin Agent 和一个真正运行在独立 Node 进程中的 Tool，没有外部服务或运行依赖。SDK 类型尚未作为独立 npm 产品发布。

## 从样例开始

从仓库根目录执行：

```sh
ohs plugin validate ./examples/plugins/text-inspector
ohs plugin link ./examples/plugins/text-inspector
ohs plugin list --verbose
ohs plugin details example.text-inspector
```

进入使用本地执行环境的 OpenHarness 会话，通过 `/text-inspector:check-text` 提供需要检查的文本，或明确要求模型使用 `TextInspectorCheck`。例如提供第一行 `hello` 后带两个空格、第二行以制表符开头的文本；工具应报告第 1 行 `trailing-whitespace` 和第 2 行 `tab-indentation`。自然语言调用需要正常配置模型；仓库自动验收直接调用注册后的工具，不需要模型服务。

如果只是想在 Desktop 里走一遍真实安装，可以先把样例打成插件包。Desktop 当前支持 `.zip`、`.tar`、`.tar.gz` 和 `.tgz`：

```powershell
New-Item -ItemType Directory -Force .\.plugin-dist
Compress-Archive -LiteralPath .\examples\plugins\text-inspector -DestinationPath .\.plugin-dist\text-inspector.zip -Force
tar -cf .\.plugin-dist\text-inspector.tar -C .\examples\plugins text-inspector
tar -czf .\.plugin-dist\text-inspector.tar.gz -C .\examples\plugins text-inspector
tar -czf .\.plugin-dist\text-inspector.tgz -C .\examples\plugins text-inspector
```

然后打开 Desktop 的插件页，选择其中任意一个插件包导入。包内可以带一层 `text-inspector/` 包装目录，只要里面有唯一的 `.openharness-plugin/plugin.json` 即可。导入成功只表示插件已经写入安装记录；它会从下一次对话开始生效。

修改链接目录里的工具实现后，在没有运行中任务的会话执行：

```text
/reload-plugins
```

该操作关闭当前 cwd 的旧 Runtime，下一次使用时重新加载。它不是代码自动热更新，也不代表所有插件都已经成功激活。重载输出会显示安装校验状态和诊断；若修改了 ID、版本或权限，需要重新 link 并批准实际权限。

正式安装将源目录复制到用户级不可变快照，后续源目录修改不会改变正在运行的版本：

```sh
ohs plugin install-local ./examples/plugins/text-inspector
ohs plugin disable example.text-inspector
ohs plugin enable example.text-inspector
ohs plugin uninstall example.text-inspector
```

同一个 ID 只有一条用户安装记录。`install-local` 会替代该 ID 之前的 link 记录；再次执行 `link` 则切回开发链接。安装、启停、卸载会使所有相关用户 Runtime 失效；有活动任务时管理操作可能返回冲突，需要等待任务结束。普通卸载移除安装记录、阻止后续加载，保留插件数据；旧快照不会立即全部删除。

## Desktop 本地插件包导入

Desktop 插件页当前只支持选择 **一个本地 Native Plugin 包**，格式可以是 `.zip`、`.tar`、`.tar.gz` 或 `.tgz`。系统在后台复制、校验和解压插件包；不申请权限的插件会直接安装，申请权限的插件只会出现一次完整权限确认。重新导入同一插件 ID 就是更新或修复：之前的批准能够覆盖本次权限时不重复确认，新增权限时才重新确认；安装成功前保留旧记录，且不会自动启用原本已禁用的插件。页面只反馈成功、失败或无法确认的安装结果；成功后插件在下一次对话中生效。

该入口不支持自动更新、独立 Repair 命令、版本回滚或旧快照垃圾回收界面，也不支持在 Agent 对话中安装、转换 Claude Code/Codex 插件、Git、npm、归档 URL 或 Marketplace 等其他来源。请使用 CLI 的目录开发/安装流程处理这些场景。旧插件页 localStorage 配置已从页面隐藏，但保留原数据，不迁移也不删除。

本地插件包导入的作者侧检查很短：

1. 插件包里必须只有一个 Native manifest，可以在根目录，也可以在唯一一层包装目录里；
2. manifest 路径必须是 `.openharness-plugin/plugin.json`；
3. 不要把两个插件目录一起压进同一个包；
4. 不要压入符号链接、超大文件或需要安装依赖后才存在的文件；
5. 导入同一个插件 ID 的新包就是手动更新或修复，不需要另一套 repair 流程。

导入失败时优先看插件页详情。如果提示文件不完整、摘要不一致或 manifest 不匹配，从可信源重新打包；如果提示缺少权限，重新导入并确认新增权限；如果提示 Tool Host 启动失败，先在本地确认 `tools/index.mjs` 能被 Node import。

## 包结构与 manifest

唯一原生入口是 `.openharness-plugin/plugin.json`：

```json
{
  "schemaVersion": 1,
  "id": "example.text-inspector",
  "name": "text-inspector",
  "version": "1.0.0",
  "components": {
    "agents": ["./agents/reviewer.md"],
    "skills": ["./skills/check-text/SKILL.md"],
    "tools": [{ "entry": "./tools/index.mjs", "runtime": "node" }]
  },
  "runtime": { "engine": "node", "isolation": "process" }
}
```

ID 使用稳定的点分名称；name 使用小写连字符名称。版本用于安装身份核对。组件路径必须以 `./` 开头并留在插件根目录内；附属脚本、图片和参考文档随插件一起安装。推荐逐个声明 Skill 文件，避免目录中的普通 Markdown 被当成额外技能。

manifest 描述插件包，不保存启用状态、批准记录、用户配置或进程状态。不要修改已安装快照；更新时重新安装一个经过校验的源目录。

## Node Tool 的公开接口

开发期类型入口是 `@openharness/plugins/sdk`。使用 TypeScript 的 `import type` 或 JavaScript 的 JSDoc 类型引用；这个子路径没有运行期 API，不要在 `.mjs` 中普通 import 它。

```js
/** @type {import('@openharness/plugins/sdk').NativeToolRegister} */
export const registerTools = (registration) => [{
  name: "ExampleEcho",
  description: "Return the supplied text",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", maxLength: 1000 } },
    required: ["text"],
    additionalProperties: false
  },
  safeToRetry: true,
  invoke(input, context) {
    context.signal.throwIfAborted();
    if (typeof input.text !== "string") throw new Error("text must be a string");
    registration.log("debug", "Echo invoked");
    return { content: [{ type: "text", text: input.text }] };
  }
}];
```

`registerTools` 可以同步或异步返回工具数组。`invoke` 同样可以返回结果或 Promise。工具入口在激活时由 Tool Host 子进程 import，静态校验和安装阶段不运行入口代码。注册名称是全局名称，没有自动插件前缀；使用可辨认的名称，同名冲突会返回 `tool_name_conflict`。

| 接口 | 当前传入的内容 |
| --- | --- |
| 注册上下文 | plugin、permissions、log(level, message) |
| 调用上下文 | plugin、permissions、cwd、可选 sessionId、deadline、signal |
| plugin | id、name、version、root；root 是实际安装快照或开发链接根目录 |
| deadline | Unix 毫秒时间戳，表示本次调用截止时间 |
| signal | AbortSignal，通知本次调用超时或被调用方取消 |

`cwd` 是调用所属项目，不是插件根目录。运行时加载插件自己的静态资源，应使用 `context.plugin.root` 或模块相对 URL；不要依赖 `process.cwd()`。注册上下文没有 cwd，调用上下文没有独立 log 方法，可以在 registerTools 中捕获日志函数。

公共接口不包含宿主内部的 settings、terminal、jobs 或工具注册表。SDK 只提供类型，不会因为声明了这些字段就注入相应能力。实际参考 `.mjs` 已作为 checkJs 输入，通过仓库的样例类型检查配置解析公共子路径。

### 参数、返回值与取消

inputSchema 在调用前检查常用 JSON Schema 约束，包括对象字段、required、additionalProperties、基本类型、enum、const、字符串长度及数组项。当前不是完整 JSON Schema 实现；不要依赖未实现的关键字来表达必须执行的业务校验。字符串长度按 JavaScript UTF-16 code units 计数。

返回现有 `ToolResult`：`content` 内容块数组，以及可选 isError、failureKind、metadata。文本输出使用 `{ type: "text", text: "..." }`；不要直接返回字符串。异常由宿主转换成结构化错误。`safeToRetry` 只对能够安全重复调用的工具设为 true。

异步工作应监听 `signal`，中止底层请求或等待并释放资源。只在长同步循环里读取 signal 不能及时接收进程间取消消息；同步任务必须有明确的工作量上限。调用超时、调用方主动取消分别返回 `tool_call_timeout`、`tool_call_cancelled`；插件长期不响应时宿主会结束进程。

工具可通过注册日志接口记录调试信息；正文、凭据和完整输入不要写日志。宿主对 stdout、stderr 和插件日志消息设有大小限制，超出时截断或抑制；当前没有对 `ToolResult.content` 应用这些限额，工具应自行限制返回结果大小，不能依赖宿主自动截断。每次工具调用另有不包含完整参数正文的审计记录。

## 权限、配置和数据边界

插件级权限与 Tool 条目的权限需要同时匹配。例如某工具声明工作区读取：

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

此处是 manifest 局部示例。安装需要批准 `filesystem:workspace:read` 和 `tool:filesystem:workspace:read` 两项，CLI 使用重复的 `--approve` 参数。不要使用旧设计示意中的 `workspace.read`，当前 Tool 权限解析器不接受该值。

Tool 的有效权限是条目请求与插件声明的匹配结果；只在插件级声明权限不会自动赋予所有 Tool。安装批准保存于安装记录，Runtime 加载前重新检查实际 manifest，新增权限不能靠修改 link 目录自动获得批准。

当前 Node Tool 的隔离是进程和环境变量隔离，不是完整系统调用沙箱。permissions 不会自动变成文件读取 API，也不能拦截第三方代码直接调用 Node API。Node Tool 目前只在 local 环境激活；WSL 或远程场景不能沿用本地路径。

当前没有统一的插件配置注入、密钥读取、持久数据访问 API。不要假定 daemon 的 API key 会继承到 Tool Host，不要依赖未公开环境变量，不要把配置或跨版本数据写回快照。数据目录的保留约定也不代表已经存在公开的数据 API。

## 其他四类组件

### Skills

Skill 是供模型读取的流程说明，不会因为安装而自动执行脚本。最小内容：

```markdown
---
name: check-text
description: Check supplied text and explain the findings.
---

Use TextInspectorCheck with the text supplied by the user.
Read references/rules.md to explain each reported issue.
```

manifest 声明 `./skills/check-text/SKILL.md`。运行时命令名为 `text-inspector:check-text`；附属资源保留原相对位置。完整调用流程见参考插件。

### Agents

通过 `components.agents` 指向 Markdown 文件或目录，文件使用 name、description 等 Agent frontmatter 和正文指令。例如 `name: reviewer` 在插件 `example.review` 中注册为 `example.review:reviewer`。

插件 Agent 当前不直接激活其文件内嵌的 hooks 或 mcpServers；需要通过插件 manifest 的独立组件入口声明。名称前缀使用插件 ID，与 Skill 使用插件 name 的规则不同。

最小示例：

```markdown
---
name: reviewer
description: Review supplied text with the plugin tool.
tools:
  - TextInspectorCheck
maxTurns: 3
---

Call TextInspectorCheck with the text supplied by the user, then explain the findings.
```

安装 `example.text-inspector` 后，这个 Agent 的完整名字是 `example.text-inspector:reviewer`。它不会自动出现在普通对话里；只有本轮选择了对应插件，模型才会看到并可以用 Agent 工具创建它。它继承本轮插件选择允许的 Skill、Tool 和 MCP，不会因为自己写了 `tools` 或 `mcpServers` 就越过宿主边界。

### Hooks

通过 `components.hooks` 指向 JSON 文件。内容直接使用 Native 事件名，例如：

```json
{
  "pre_tool_use": [{
    "type": "command",
    "command": "node --version",
    "timeout": 1000,
    "blockOnFailure": false
  }]
}
```

当前事件有 session_start、session_end、pre_compact、post_compact、pre_tool_use、post_tool_use、user_prompt_submit、notification、stop、subagent_stop；识别的类型为 command、http、prompt、agent，后两者的执行还取决于宿主配置。

命令使用 Hook Executor 的工作目录执行，通常是项目 cwd，不自动切到插件目录。命令环境可获得 `OPENHARNESS_HOOK_EVENT` 和 `OPENHARNESS_HOOK_PAYLOAD`；当前没有统一注入的插件根目录别名。不要直接假定 `node ./scripts/check.mjs` 指向插件内文件。命令实际使用的程序、目录和权限必须按宿主运行环境准备。

### MCP

通过 `components.mcpServers` 指向 JSON，使用 Native `servers` 外层对象和显式传输类型：

```json
{
  "servers": {
    "example-docs": { "type": "http", "url": "https://service.example.invalid/mcp" }
  }
}
```

以上只说明格式，使用时须替换为真实服务地址。stdio 使用 command 和可选 args/env；http、sse 使用 url。当前不会为插件自动下载依赖、展开插件根变量或完成服务认证。静态加载成功只表示配置可读取，实际连接与工具发现发生在 MCP Runtime。

MCP 名称不会自动加插件前缀，请使用独特名称，避免与其他插件或用户设置同名。此类配置没有 Node Tool 的 plugin.root 调用上下文，不能直接把相对脚本路径当作已绑定的插件文件。

## 诊断与验证

`validate` 检查 manifest 和声明路径，不承诺所有组件都能激活。安装成功只代表 ZIP 或目录已经写入安装记录；运行状态以插件页和 `ohs plugin details` 返回的 Runtime 诊断为准。

`PluginInfo.runtimeStatus` 是面向展示的主状态，目前包含 `disabled`、`pending_reload`、`loaded`、`degraded` 和 `failed`。列表页只需要看这一个字段；`diagnostics` 和 `toolRuntime` 保留在详情里，用于作者排查具体原因。`list --verbose`、`details` 和 `/reload-plugins` 用于查看安装校验、组件诊断和 Tool Host 状态。

遇到权限或身份变化，先查看源 manifest，再重新 link/install-local 并明确批准所需权限；遇到快照损坏，从可信源重新安装。组织管理的插件由管理员修复，普通用户不能替换或卸载。

常见排查顺序：

```text
导入失败       → 检查 ZIP 里是否有唯一的 .openharness-plugin/plugin.json
等待生效       → 开新对话，或在没有运行中任务时执行 /reload-plugins
缺少权限       → 重新导入或 install-local，并批准这次 manifest 请求的权限
组件部分不可用 → 看详情里的 diagnostics，确认是不是当前版本暂不支持
Tool 启动失败  → 检查 entry 路径、Node 语法、运行期普通 import 和本机依赖
```

如果 `validate` 通过但插件页显示失败，说明静态结构没问题，但安装快照、权限或 Runtime 激活阶段出了问题；以插件页详情和 `ohs plugin details <id>` 的 `runtimeStatus` 为准。

仓库验证入口：

```sh
pnpm --filter @openharness/plugins check-types
pnpm --filter @openharness/agent-runtime exec vitest run src/native-tools/text-inspector.test.ts src/native-tools/tool-host.test.ts src/native-tools/native-plugin-authoring.test.ts
pnpm --filter @openharness/server exec vitest run src/http/routes/plugin-lifecycle.test.ts
```

测试使用临时用户安装记录和真实 Tool Host，不写入开发者日常插件安装状态。样例目录参与相关测试和类型检查的 Turbo 缓存输入，修改样例后会重新验证。

Output Styles、Themes、Monitors、Workflows、Channels、Providers、UI、LSP、Wasm 和受管理二进制仍以当前 Loader 诊断为准；不要把 schema 中预留的字段当作已经开放的能力。阶段范围见 [开发设计](./superpowers/specs/2026-09-09-native-plugin-authoring-v1-design.md)与[实施计划](./superpowers/plans/2026-09-09-native-plugin-authoring-v1.md)。
