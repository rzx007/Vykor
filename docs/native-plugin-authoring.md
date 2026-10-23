# 编写 Vykor 原生插件

> 状态：当前开发指南。

本文面向在本仓库内开发插件的作者。带页面的新插件优先从 [天气与出行模板](../skills/create-plugin/templates/weather-travel/README.md) 开始；它可生成 Native Tool 或 MCP 服务两种后台，使用同一官方 MCP Apps 页面。作者准备构建依赖，用户安装已构建的插件包。

完整的协议、调用流程图和结果返回规则见 [MCP Apps 开发说明](./mcp-apps.md)（[交互版](./mcp-apps.html)）。Native Tool 是 Vykor 的工具接口，不是旧原生界面；两种后台的页面都统一显示在右侧面板。

## 创建完整工程

在仓库根目录执行以下命令。新目录不能已经存在；需要 Node.js 24：

```sh
node skills/create-plugin/scripts/create-plugin.mjs --dir ./my-weather --id example.my-weather --name my-weather --backend native --display-name "我的天气助手"
cd my-weather
npm ci
npm run build
npm test
npm run validate
npm run pack
```

需要 MCP 后台时，在新目录用 `--backend mcp` 初始化。生成器只保留所选后台，两版不要求互相启动；它们共用业务代码、页面及相同的权限和保存规则。`plugin.config.json` 是身份配置入口，构建脚本统一生成工具名、页面 URI 和清单。

`dist` 内包含离线页面与所选后台入口，打包输出以生成工程说明为准。安装时不下载依赖、不现场构建；业务数据使用宿主提供的插件数据目录，不写代码快照。

若只想理解不写数据的 Native Tool 接线，可使用 [文本检查助手](../examples/plugins/text-inspector/README.md)。它包含 Skill、Plugin Agent、Node 工具与单文件页面，不依赖天气服务。

## 从样例开始

从仓库根目录执行：

```sh
vk plugin validate ./examples/plugins/text-inspector
vk plugin link ./examples/plugins/text-inspector --approve ui:render --approve ui:invoke-own-tools
vk plugin list --verbose
vk plugin details example.text-inspector
```

进入使用本地执行环境的 Vykor 会话，通过 `/text-inspector:check-text` 提供需要检查的文本，或明确要求模型使用 `TextInspectorCheck`。例如提供第一行 `hello` 后带两个空格、第二行以制表符开头的文本；工具应报告第 1 行 `trailing-whitespace` 和第 2 行 `tab-indentation`。自然语言调用需要正常配置模型；仓库自动验收直接调用注册后的工具，不需要模型服务。

如果只是想在 Desktop 里走一遍真实安装，可以先把 `examples/plugins` 下的所有样例打成 ZIP。Desktop 当前支持 `.zip`、`.tar`、`.tar.gz` 和 `.tgz`；仓库提供的命令生成 ZIP：

```sh
pnpm --filter @vykor/plugin-sources package:examples
```

生成的 ZIP 位于仓库根目录的 `.plugin-dist`，该目录已加入 Git 忽略规则。若要测试其他支持的归档格式，请另行打包。然后打开 Desktop 的插件页，选择 ZIP 导入。包内可以带一层插件目录包装，只要里面有唯一的 `.vykor-plugin/plugin.json` 即可。导入成功只表示插件已经写入安装记录；它会从下一次对话开始生效。

修改链接目录里的工具实现后，在没有运行中任务的会话执行：

```text
/reload-plugins
```

该操作关闭当前 cwd 的旧 Runtime，下一次使用时重新加载。它不是代码自动热更新，也不代表所有插件都已经成功激活。重载输出会显示安装校验状态和诊断；若修改了 ID、版本或权限，需要重新 link 并批准实际权限。

正式安装将源目录复制到用户级不可变快照，后续源目录修改不会改变正在运行的版本：

```sh
vk plugin install-local ./examples/plugins/text-inspector --approve ui:render --approve ui:invoke-own-tools
vk plugin disable example.text-inspector
vk plugin enable example.text-inspector
vk plugin uninstall example.text-inspector
```

同一个 ID 只有一条用户安装记录。`install-local` 会替代该 ID 之前的 link 记录；再次执行 `link` 则切回开发链接。安装、启停、卸载会使所有相关用户 Runtime 失效；有活动任务时管理操作可能返回冲突，需要等待任务结束。普通卸载移除安装记录、阻止后续加载，保留插件数据；旧快照不会立即全部删除。

## Desktop 插件页安装

Desktop 插件页右上角“添加”菜单目前支持两个入口：

- 导入本地 Native Plugin 包：格式可以是 `.zip`、`.tar`、`.tar.gz` 或 `.tgz`；
- 从 Git 安装：输入 Git URL 和可选 branch、tag 或 commit，后台使用系统 `git` 固定到实际 commit，再进入同一条安装链路。

系统在后台复制、校验和准备插件内容；不申请权限的插件会直接安装，申请权限的插件只会出现一次完整权限确认。重新导入同一插件 ID 就是更新或修复：之前的批准能够覆盖本次权限时不重复确认，新增权限时才重新确认；安装成功前保留旧记录，且不会自动启用原本已禁用的插件。页面只反馈成功、失败或无法确认的安装结果；成功后插件在下一次对话中生效。

对话中也可以让 Agent 使用 `PluginInstall` 安装本地插件包或 Git URL/ref。工具先展示插件身份、固定来源和完整权限；只有用户回复“确认安装”才会调用同一安装服务，新插件从下一次对话生效。插件开发指导改为单独分发的 [create-plugin Skill](../skills/create-plugin/README.md)，不再内置；用户自行安装该 Skill 后才能通过 `/create-plugin` 或 `Skill` 调用。市场浏览、来源绑定和手动更新见 [插件市场](./plugin-marketplace.md)。自动更新、独立 Repair 命令、版本回滚、Claude Code/Codex 转换、npm 和归档 URL 仍未支持。旧插件页 localStorage 配置已从页面隐藏，但保留原数据，不迁移也不删除。

本地插件包导入的作者侧检查很短：

1. 插件包里必须只有一个 Native manifest，可以在根目录，也可以在唯一一层包装目录里；
2. manifest 路径必须是 `.vykor-plugin/plugin.json`；
3. 不要把两个插件目录一起压进同一个包；
4. 不要压入符号链接、超大文件或需要安装依赖后才存在的文件；
5. 导入同一个插件 ID 的新包就是手动更新或修复，不需要另一套 repair 流程。

导入失败时优先看插件页详情。如果提示文件不完整、摘要不一致或 manifest 不匹配，从可信源重新打包；如果提示缺少权限，重新导入并确认新增权限；如果提示 Tool Host 启动失败，先在本地确认 `tools/index.mjs` 能被 Node import。

## 包结构与 manifest

唯一原生入口是 `.vykor-plugin/plugin.json`：

```json
{
  "schemaVersion": 1,
  "id": "example.text-inspector",
  "name": "text-inspector",
  "version": "1.1.0",
  "components": {
    "agents": ["./agents/reviewer.md"],
    "skills": ["./skills/check-text/SKILL.md"],
    "tools": [{ "entry": "./tools/index.mjs", "runtime": "node" }],
    "apps": ["./ui/apps.json"]
  },
  "runtime": { "engine": "node", "isolation": "process" }
}
```

ID 使用稳定的点分名称；name 使用小写连字符名称。版本用于安装身份核对。组件路径必须以 `./` 开头并留在插件根目录内；附属脚本、图片和参考文档随插件一起安装。推荐逐个声明 Skill 文件，避免目录中的普通 Markdown 被当成额外技能。

manifest 描述插件包，不保存启用状态、批准记录、用户配置或进程状态。不要修改已安装快照；更新时重新安装一个经过校验的源目录。

## 插件应用（MCP Apps）

根清单保持 schemaVersion 1，页面入口是 `components.apps: ["./ui/apps.json"]`。Apps 清单也使用 schemaVersion 1，`surfaces` 提供会话内的具名打开入口。

| 作者步骤 | Native Tool＋MCP Apps | MCP 服务＋MCP Apps |
| --- | --- | --- |
| 注册后台 | 根清单 components.tools；入口导出 registerTools | 根清单 components.mcpServers；配置实际 MCP 服务 |
| 关联 Apps | kind: native-tools；tools 引用真实注册名，ui.resourceUri 关联页面 | kind: mcp-server；server 引用同插件服务名 |
| 提供页面 | resources 将 ui:// URI 映射到包内离线 HTML | MCP 服务响应 resources/read，返回 text/html;profile=mcp-app |
| 关联模型工具 | Apps tools 项声明 ui.resourceUri 和 visibility | MCP 工具元数据声明 _meta.ui.resourceUri 和 visibility |
| 返回页面数据 | metadata.appData；宿主转换为 structuredContent | MCP 工具结果直接带 structuredContent |
| 页面调用的执行路径 | 宿主校验 → Native 适配 → Tool Host／Guard → invoke | 宿主校验 → MCP Client → 服务工具处理函数 |

Native 参数 schema 来自工具真实注册结果，不在 Apps 清单另造别名或参数定义；接入页面不需要额外 MCP 进程。MCP 模板通过 stdio 启动服务，服务向宿主提供 HTML，HTML 在宿主页面沙箱中运行。

两者的页面都使用官方 MCP Apps SDK，无需按后台类型改写通信协议。工具保留普通 content 文字，页面消费结构化数据。普通业务工具不生成可信 appId、requestId、宿主控制版本或执行状态；业务 revision 不能替代宿主授权版本。app-only 可见性只限制调用方，不授予权限。

安装批准后，宿主才装配组件、读取页面并按原规则执行工具。Native 从 context 取得原会话、数据目录和 cwd；天气 MCP 模板通过宿主注入的环境绑定取得对应信息。不要让页面参数指定会话、数据根目录或导出根目录。

## 页面入口与结果

```js
import { App, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
const app = new App({ name: "My App", version: "1.0.0" }, { availableDisplayModes: ["inline", "fullscreen"] });
function show(result) {
  if (result.isError) throw new Error("工具失败，请查看回执");
  // 校验 structuredContent 后显示；这里不能再次调用工具或保存。
}
app.ontoolresult = show; // Agent 结果；必须在 connect 前注册。
app.onhostcontextchanged = context => {
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
};
await app.connect();
// 用户明确点击按钮后：主动返回值不会自动触发 ontoolresult。
const result = await app.callServerTool({ name: "TextInspectorCheck", arguments: { text: "hello " } });
show(result);
```

上面用 Text Inspector 演示接线，真实按钮必须由作者绑定事件，并处理异常与等待状态。工具名使用当前插件真实名称；天气工程从 `src/identity.mjs` 取得，不能照搬示例名称。

Agent 调用已关联页面的工具后，宿主把结果返回 Agent，同时投递给对应会话页面的 `ontoolresult`。页面按钮的调用结果则返回 `callServerTool` 的 Promise，不再触发这份通知。两个入口可以共用渲染函数，渲染时不再次执行工具或保存。

先登记通知再 connect，避免丢失握手时的首个结果。从具名入口直接打开时，不能假设已有 Agent 结果：Text Inspector 显示空表单；天气模板主动读取真实备忘与收藏，未查询前不伪造天气。实时结果优先在工作摘要提示，点击具名入口后定位右侧，不反复抢占焦点。

完整天气接线见 [页面入口](../skills/create-plugin/templates/weather-travel/ui/panel.mjs)与[页面交互](../skills/create-plugin/templates/weather-travel/ui/view.mjs)；Text Inspector 的错误、选区和 48,000 字节交互边界见 [页面源码](../examples/plugins/text-inspector/ui/panel.mjs)。主题通过官方 hostContext 更新，不清空输入；使用宿主语义颜色，支持键盘及减少动态效果。

## 可见上下文与普通消息

`app.updateModelContext({ content: [{type:"text",text}], structuredContent: selection })` 把明确选中的内容加入原会话可见条目；不覆盖输入框，也不自动发送。普通发送时仍重新检查来源、授权和版本。用户可移除条目。

`app.sendMessage({ role:"user", content:[{type:"text",text}] })` 经宿主确认后发送普通用户消息，成功保持应用打开。只支持文本角色 user，不发送主输入框已有草稿。先检查 `app.getHostCapabilities()` 的 message/updateModelContext 能力。消息总共最多 4096 个 Unicode 字符；上下文结构化 JSON 最多 32 KiB。只携带必要选区，超限提示用户减少选择，不静默裁剪。

普通工具参数默认最多 64 KiB；应用后台可用 toolPolicies 为具体工具声明 maxArgumentsBytes，应用请求传输硬上限为 64 MiB。声明更大额度不会获得免确认授权。Native appData 最多 256 KiB、MCP 结果最多 1 MiB、HTML 最多 16 MiB、单次资源解码总量最多 8 MiB。大页面可分块读取本插件资源；样例原文 JSON UTF-8 超过 48,000 字节时仍返回文字检查结果，省略交互数据。

### 自身数据自动保存

Excalidraw 的完整例子见 [插件说明](../plugins/excalidraw/README.md)。根清单声明 permissions.pluginData 为 ["write"]，安装时明确批准 pluginData:write；后台在 toolPolicies 中将具体的应用专用保存工具声明为 authorization: "plugin-data-write"。两者缺一不可，model/app 双可见工具不会得到该授权。

宿主仍验证原插件快照、工具绑定、会话、参数和 Run；执行前先检查 deny、角色和运行环境，并继续执行 hook。授权只消除自身保存的重复确认，不能授权模型任务或工作区导出。插件进程仍是受信任的 Node 代码，这项声明本身不构成操作系统文件沙箱；作者必须固定数据目录，保存工具不接受任意文件路径。

自动保存只合并尚未提交的编辑，保持单次在途调用。收到业务保存确认后才显示已保存；冲突和未知结果暂停且保留草稿。只有标准 MCP 错误 data 明确包含 notAccepted: true 和 plugin_app_busy 或 plugin_app_hidden 时，才可等待后重新准备。其他错误不重放；已接纳的调用只查原回执。隐藏页面可以读已授权资源，不能开始新工具调用。

## 构建、安装和更新

作者复制完整目录后执行 `npm ci`（首次新建锁文件用 `npm install`）和 `npm run build`。package.json/package-lock.json 锁定官方 `@modelcontextprotocol/ext-apps` 1.1.2，以 esbuild 正常打包模块。依赖准备需要 npm 或本地缓存；安装产物 `ui/panel.html` 是完整离线单文件，安装时不构建，也不下载依赖。不得分发 node_modules、使用 CDN、外部脚本/字体或私有页面 SDK。

修改源码后重建 HTML，增加插件版本，按原 install-local/重新导入流程升级。不修改用户安装快照和 dataDir；新权限仍按原规则批准。安装需要 ui:render/ui:invoke-own-tools，仍需实际工具权限、角色 allowedTools、deny 与环境检查。

## 常驻页面边界

切换面板或会话仅隐藏同一 iframe，保留输入和光标。隐藏脚本不能发起新工具、消息或上下文请求；已发送工作继续结算。取消、丢响应和 unknown 不自动重放。unknown 持久阻止后续工具和消息，重开不能解除。

官方 1.1.2 的实验能力 schema 会剥离自定义 namespace，当前不装配 widgetState。窗口关闭或重启不保证表单恢复；跨重启业务数据由插件自行使用原 dataDir 保存。页面没有 Node、preload、父 DOM、文件、网络、子 frame、任意 IPC 或剪贴板权限。沙箱禁止默认表单提交；按钮使用 type="button" 直接调用受控操作，并单独处理 Enter、输入有效性和等待期间的重复点击。不要手写通信协议或用 innerHTML 渲染用户数据。

## Node Tool 的公开接口

开发期类型入口是 `@vykor/plugins/sdk`。使用 TypeScript 的 `import type` 或 JavaScript 的 JSDoc 类型引用；这个子路径没有运行期 API，不要在 `.mjs` 中普通 import 它。

```js
/** @type {import('@vykor/plugins/sdk').NativeToolRegister} */
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
| 调用上下文 | plugin、permissions、cwd、可选 sessionId/runId、deadline、signal；按 toolResultInput 提供实际 toolResult |
| plugin | id、name、version、root、dataDir；root 是代码快照，dataDir 是稳定的插件持久数据目录 |
| deadline | Unix 毫秒时间戳，表示本次调用截止时间 |
| signal | AbortSignal，通知本次调用超时或被调用方取消 |

`cwd` 是调用所属项目，不是插件根目录。运行时加载插件自己的静态资源，应使用 `context.plugin.root` 或模块相对 URL；不要依赖 `process.cwd()`。注册上下文没有 cwd，调用上下文没有独立 log 方法，可以在 registerTools 中捕获日志函数。

公共接口不包含宿主内部的 settings、terminal、jobs 或工具注册表。SDK 只提供类型，不会因为声明了这些字段就注入相应能力。实际参考 `.mjs` 已作为 checkJs 输入，通过仓库的样例类型检查配置解析公共子路径。

### 参数、返回值与取消

inputSchema 在调用前检查常用 JSON Schema 约束，包括对象字段、required、additionalProperties、基本类型、enum、const、字符串长度及数组项。当前不是完整 JSON Schema 实现；不要依赖未实现的关键字来表达必须执行的业务校验。字符串长度按 JavaScript UTF-16 code units 计数。

返回现有 `ToolResult`：`content` 内容块数组，以及可选 isError、failureKind、metadata。文本输出使用 `{ type: "text", text: "..." }`；不要直接返回字符串。异常由宿主转换成结构化错误。`safeToRetry` 只对能够安全重复调用的工具设为 true。

异步工作应监听 `signal`，中止底层请求或等待并释放资源。只在长同步循环里读取 signal 不能及时接收进程间取消消息；同步任务必须有明确的工作量上限。调用超时、调用方主动取消分别返回 `tool_call_timeout`、`tool_call_cancelled`；插件长期不响应时宿主会结束进程。

工具可通过注册日志接口记录调试信息；正文、凭据和完整输入不要写日志。宿主对 stdout、stderr 和插件日志消息设有大小限制，超出时截断或抑制；当前没有对 `ToolResult.content` 应用这些限额，工具应自行限制返回结果大小，不能依赖宿主自动截断。每次工具调用另有不包含完整参数正文的审计记录。

## 插件持久数据与本轮工具结果

宿主注入 `context.plugin.dataDir`，位置为 `~/.vykor/plugins/data/<plugin-id>`，与安装版本、代码快照和当前工作目录分开。插件按需创建目录并自行使用 Node 文件 API，保存格式、迁移及缓存清理由插件负责。普通更新与卸载不删除这些数据；此入口规范数据位置，不提供系统级文件沙箱，也不会隐式授予读写权限。

原生工具可以声明 `toolResultInput: "tool_result_id"`，并在 inputSchema 定义该字符串字段。调用时宿主按编号取出本轮已经执行、且仍在当前可见工具范围内的实际结果，放入 `context.toolResult`；模型不能用参数正文替代它。上下文还提供可选 `runId`，用于插件记录本轮业务状态。

工具结果编号在模型反馈中显示为 `Tool-Result-Id: <tool-call-id>`。此接口仅保留选中插件的本轮最近 16 项结果，单项最多 256000 字节、总量最多 1000000 字节；不截断后冒充完整结果，不跨 Run 或运行时重启读取。结果不存在、过大或已被淘汰时明确返回不可用，插件可重新取得结果或读取自己的持久数据。先执行取资料工具，再在后续调用导入；同一批并行工具未完成时不能读取其结果。

平台没有自动为插件落盘、签名或建立第二份长期结果档案。需要持久保存时由插件显式导入或直接在自己的检索路径保存；插件记录不作为独立审计证据。原生工具的联网要求由入口的有效 network 权限推导，禁止联网时统一阻止这些入口的工具；纯计算工具应使用不请求网络权限的入口。

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

当前提供 dataDir 文件目录入口，尚无统一配置注入、密钥读取或通用数据库 API。不要假定 daemon 的 API key 会继承到 Tool Host，不要依赖未公开环境变量；配置和跨版本数据应写入 dataDir，不要写回代码快照。

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

命令使用 Hook Executor 的工作目录执行，通常是项目 cwd，不自动切到插件目录。命令环境可获得 `VYKOR_HOOK_EVENT` 和 `VYKOR_HOOK_PAYLOAD`；当前没有统一注入的插件根目录别名。不要直接假定 `node ./scripts/check.mjs` 指向插件内文件。命令实际使用的程序、目录和权限必须按宿主运行环境准备。

### MCP

通过 `components.mcpServers` 指向 JSON，使用 Native `servers` 外层对象和显式传输类型：

```json
{
  "servers": {
    "example-docs": { "type": "http", "url": "https://service.example.invalid/mcp" }
  }
}
```

以上只说明格式，使用时须替换为真实服务地址。stdio 使用 command 和可选 args/env；http、sse 使用 url。当前不会为插件自动下载依赖或完成服务认证。静态加载成功只表示配置可读取，实际连接与工具发现发生在 MCP Runtime。

MCP 名称不会自动加插件前缀，请使用独特名称，避免与其他插件或用户设置同名。此类配置没有 Node Tool 的 plugin.root 调用上下文，不能直接把相对脚本路径当作已绑定的插件文件。

本地打包的 stdio 服务可显式设置 `cwd: "${VYKOR_PLUGIN_ROOT}"`，绑定实际安装根后使用相对 `args`。仅该完整标记值展开；未声明 cwd 的已有配置行为不变。env 值为完整 `${VYKOR_PLUGIN_DATA_DIR}` 时绑定已有插件数据目录；env 值为完整 `${VYKOR_SESSION_ID}` 时，运行时绑定原会话 ID 的 SHA-256 目录键。页面不能指定这些值，不进行 shell 展开或任意字符串插值。`notes-app` 使用插件 dataDir 下的 `sessions/<目录键>/welcome.json`，同一会话页面和模型共享，其他会话独立，安装快照不写入。

## 诊断与验证

`validate` 检查 manifest 和声明路径；有 UI 时还校验定义内容、HTML 文件边界与大小，不执行前端代码。它不承诺所有组件都能激活。安装成功只代表 ZIP 或目录已经写入安装记录；运行状态以插件页和 `vk plugin details` 返回的 Runtime 诊断为准。

`PluginInfo.runtimeStatus` 是面向展示的主状态，目前包含 `disabled`、`pending_reload`、`loaded`、`degraded` 和 `failed`。列表页只需要看这一个字段；`diagnostics` 和 `toolRuntime` 保留在详情里，用于作者排查具体原因。`list --verbose`、`details` 和 `/reload-plugins` 用于查看安装校验、组件诊断和 Tool Host 状态。

遇到权限或身份变化，先查看源 manifest，再重新 link/install-local 并明确批准所需权限；遇到快照损坏，从可信源重新安装。组织管理的插件由管理员修复，普通用户不能替换或卸载。

常见排查顺序：

```text
导入失败       → 检查 ZIP 里是否有唯一的 .vykor-plugin/plugin.json
等待生效       → 开新对话，或在没有运行中任务时执行 /reload-plugins
缺少权限       → 重新导入或 install-local，并批准这次 manifest 请求的权限
组件部分不可用 → 看详情里的 diagnostics，确认是不是当前版本暂不支持
Tool 启动失败  → 检查 entry 路径、Node 语法、运行期普通 import 和本机依赖
```

如果 `validate` 通过但插件页显示失败，说明静态结构没问题，但安装快照、权限或 Runtime 激活阶段出了问题；以插件页详情和 `vk plugin details <id>` 的 `runtimeStatus` 为准。

仓库验证入口：

```sh
pnpm --filter @vykor/plugins check-types
pnpm --filter @vykor/agent-runtime exec vitest run src/native-tools/text-inspector.test.ts src/native-tools/tool-host.test.ts src/native-tools/native-plugin-authoring.test.ts
pnpm --filter @vykor/server exec vitest run src/application/default-services/plugin-lifecycle.routes.test.ts
```

测试使用临时用户安装记录和真实 Tool Host，不写入开发者日常插件安装状态。样例目录参与相关测试和类型检查的 Turbo 缓存输入，修改样例后会重新验证。

Output Styles、Themes、Monitors、Workflows、Channels、Providers、LSP、Wasm 和受管理二进制仍以当前 Loader 诊断为准；不要把 schema 中预留的字段当作已经开放的能力。页面入口统一为 `components.apps`，使用官方 MCP Apps SDK；旧 `components.ui` 仅供已安装包诊断与历史读取，新导入明确拒绝。Native Tool 的 SDK、Host、权限和数据目录保持独立。页面范围见 [MCP Apps 设计](./superpowers/specs/2026-10-20-mcp-apps-resident-panels-design.md)；其他 Native 能力见 [开发设计](./superpowers/specs/2026-09-09-native-plugin-authoring-v1-design.md)与[实施计划](./superpowers/plans/2026-09-09-native-plugin-authoring-v1.md)。

页面通过官方 `App` 构造函数的 `availableDisplayModes` 声明支持的显示模式。宿主读取 SDK 1.1.2 的 `AppBridge.getAppCapabilities()` 握手结果；省略声明按 inline-only 处理，只有确认支持 fullscreen 的页面进入侧栏。工具结果的 inline-only 页面保留内联显示位置；菜单没有内联位置，因此会拒绝内联页面。对于本次新打开、没有其他查看器且控制版本未变的空闲应用，宿主会关闭其持久占位并释放查看器；已有、共享或出现操作变化时不自动关闭，在应用目录保留明确的关闭入口。位置切换同步 hostContext，保留同一 iframe 和草稿。
