# 编写 Vykor 原生插件

> 状态：当前开发指南。

本文面向在本仓库内开发插件的作者。可以从 [文本检查助手](../examples/plugins/text-inspector/README.md) 开始：它包含 Skill、Plugin Agent、独立 Node 工具和使用公开浏览器 SDK 的单文件 UI，没有外部服务或安装后的运行依赖。SDK 尚未作为独立 npm 产品发布。

## 从样例开始

从仓库根目录执行：

```sh
vk plugin validate ./examples/plugins/text-inspector
vk plugin link ./examples/plugins/text-inspector --approve ui:render --approve ui:invoke-own-tools
vk plugin list --verbose
vk plugin details example.text-inspector
```

进入使用本地执行环境的 Vykor 会话，通过 `/text-inspector:check-text` 提供需要检查的文本，或明确要求模型使用 `TextInspectorCheck`。例如提供第一行 `hello` 后带两个空格、第二行以制表符开头的文本；工具应报告第 1 行 `trailing-whitespace` 和第 2 行 `tab-indentation`。自然语言调用需要正常配置模型；仓库自动验收直接调用注册后的工具，不需要模型服务。

如果只是想在 Desktop 里走一遍真实安装，可以先把样例打成插件包。Desktop 当前支持 `.zip`、`.tar`、`.tar.gz` 和 `.tgz`：

```powershell
New-Item -ItemType Directory -Force .\.plugin-dist
Compress-Archive -LiteralPath .\examples\plugins\text-inspector -DestinationPath .\.plugin-dist\text-inspector.zip -Force
tar -cf .\.plugin-dist\text-inspector.tar -C .\examples\plugins text-inspector
tar -czf .\.plugin-dist\text-inspector.tar.gz -C .\examples\plugins text-inspector
tar -czf .\.plugin-dist\text-inspector.tgz -C .\examples\plugins text-inspector
```

然后打开 Desktop 的插件页，选择其中任意一个插件包导入。包内可以带一层 `text-inspector/` 包装目录，只要里面有唯一的 `.vykor-plugin/plugin.json` 即可。导入成功只表示插件已经写入安装记录；它会从下一次对话开始生效。

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

对话中也可以让 Agent 使用 `PluginInstall` 安装本地插件包或 Git URL/ref。工具先展示插件身份、固定来源和完整权限；只有用户回复“确认安装”才会调用同一安装服务，新插件从下一次对话生效。插件开发指导改为单独分发的 [create-plugin Skill](../skills/create-plugin/README.md)，不再内置；用户自行安装该 Skill 后才能通过 `/create-plugin` 或 `Skill` 调用。自动更新、独立 Repair 命令、版本回滚、Claude Code/Codex 转换、npm、归档 URL 和 Marketplace 仍未支持。旧插件页 localStorage 配置已从页面隐藏，但保留原数据，不迁移也不删除。

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
    "ui": ["./ui/manifest.json"]
  },
  "runtime": { "engine": "node", "isolation": "process" }
}
```

ID 使用稳定的点分名称；name 使用小写连字符名称。版本用于安装身份核对。组件路径必须以 `./` 开头并留在插件根目录内；附属脚本、图片和参考文档随插件一起安装。推荐逐个声明 Skill 文件，避免目录中的普通 Markdown 被当成额外技能。

manifest 描述插件包，不保存启用状态、批准记录、用户配置或进程状态。不要修改已安装快照；更新时重新安装一个经过校验的源目录。

## UI 定义与后台工具操作

UI 定义的静态校验、安装授权和元数据加载，以及工具结果中的可信实例、持久工具操作和 HTTP / Client 接口已经接入。
仓库现有浏览器入口为 `@vykor/plugins/ui-sdk`。A3 的隔离 HTML、卡片、侧栏、宿主确认和管理撤销已接入，实际 Electron → Client → Native Tool → SQLite → SSE 流程通过。当前 Desktop 同时检查 backend 的 `pluginUi=2`、`pluginUiLifecycle=1` 和本地隔离能力；旧后台保留原文字。`plugins.uiEnabled=false` 只关闭界面，普通插件工具仍可用。A4 的正式参考插件见 [文本检查助手](../examples/plugins/text-inspector/README.md)，自动化桌面证据和未验证范围见 [A4 验证记录](superpowers/reviews/2026-10-04-native-plugin-ui-a4-verification.md)。自动化验证不等同用户人工验收或正式发布。
下面的后台能力可以由受信宿主或测试通过 Client 使用；声明 UI 不会自动打开窗口，也不会阻塞普通文字结果。

Native manifest 保持 schemaVersion 1，通过现有 components.ui 声明定义文件：

```json
{
  "schemaVersion": 1,
  "id": "example.ui-viewer",
  "name": "ui-viewer",
  "version": "1.0.0",
  "components": { "ui": ["./ui/manifest.json"] }
}
```

定义文件和工具返回的 UI 建议单独使用 schemaVersion 2。纯展示组件必须显式写 actions 空数组：

```json
{
  "schemaVersion": 2,
  "components": [{
    "id": "findings",
    "title": "检查结果",
    "entry": "./ui/findings.html",
    "surface": "session-sidebar",
    "actions": []
  }]
}
```

entry 和定义文件路径都相对于插件根目录，而不是相对于 ui/manifest.json。组件 ID 在插件内唯一，匹配 `^[a-z][a-z0-9-]{0,63}$`。组件与动作的字段严格校验，标签为非空纯文本且最多 80 个 Unicode 字符。一个定义文件至少包含一个组件；动作可以为空，声明动作时必须显式提供 id、label、精确 tool 注册名与 completion（keep-open / resolve），不在 UI 定义中复制 inputSchema。

单插件最多 8 个定义文件、16 个组件，每组件最多 16 个动作；单个定义 JSON 最多 UTF-8 256 KiB，单个 HTML 最多 UTF-8 2 MiB。所有 UI 入口必须是普通 UTF-8 文件，禁止根目录外路径、文件 symlink 和目录 junction。HTML 应提前构建成单文件；校验和安装只读文件，不运行 HTML 或 Node Tool。

只要声明 UI，安装授权自动包含 `ui:render` 和 `ui:invoke-own-tools`。它们分别允许显示隔离界面、请求组件声明的插件自身工具，不能代替工具参数和执行权限检查。旧安装记录不会自动得到新批准，缺少授权时需要重新导入并确认。后台只绑定同插件的实际 Native Tool；builtin、其他插件和 MCP 工具不能作为 UI 动作。目标工具参数格式取自实际注册的 inputSchema，UI manifest 不另存一份。

安装预览和管理详情中的 uiInventory 分别记录定义文件数、组件数和静态有效组件数。无法校验组件时 componentCount 为 null，表示暂不可确认，不表示没有 UI。它们不证明某个窗口已经显示界面：实际界面从工具结果中按需打开，仍需通过会话和隔离能力检查。

### 工具结果如何产生实例

成功的同插件 Native Tool 可以返回下列建议数据；宿主验证当前插件、组件和工具归属后，在原工具 Part 上保存一个可信实例。原始文字结果保持可用，建议无效时也不改变业务工具的成功结果。

```js
return {
  content: [{ type: "text", text: "发现 1 项问题" }],
  metadata: { ui: { schemaVersion: 2, componentId: "findings", data: { count: 1 } } }
};
```

`data` 必须是有限的 JSON 对象，最多 UTF-8 256 KiB。`pluginUi`、`uiAction`、实例 ID、revision 和执行状态由宿主保存，插件返回的同名保留 metadata 会被移除，不能取得可信身份。初始 Run 未选择该插件、源 Part 未提交或组件快照发生漂移时，不会生成可信实例。

### 已接入的 Client 后台接口

`VykorClient.pluginUi` 提供 `get`、`getDocument`、`invokeAction`、`getAction` 和 `dismiss`。它们通过已有 daemon 认证访问当前会话的实例；调用方先读实例 revision，再为提交生成新的 UUID requestId。`invokeAction` 只接收声明的 actionId 和 JSON args（最多 UTF-8 64 KiB），不接收任意工具名称。重试必须沿用相同 requestId、revision 和参数；修改其中内容会返回冲突，同一请求跨 daemon 重启不会再次执行。

动作使用原有参数检查、工具权限、Hook、超时和取消流程；它有自己的持久 Run，但不创建模型输入、不请求模型，也不唤醒 Goal。成功可按 completion 更新 data 或 resolve；失败保持准确结果，工具已经开始但无法确认结局时记为 unknown，恢复时不自动重放。下一次普通模型输入只获得有长度上限的外部工具结果摘要。

`dismiss` 只保存关闭状态，和取消运行分开；已经运行的动作不能通过 dismiss 撤销。当前会话忙、revision 过期、归档或实例终态时不能提交新动作。每次读取文档和动作准入都会核对实际安装、授权、启用状态和摘要；精确静态快照在 Native Host 暂不可用时可只读返回文档，但没有可调用动作。

feature `pluginUi: 2` 只表示 daemon 已装配这些后台接口，不代表当前客户端能安全显示 UI。Desktop 还要求 `pluginUiLifecycle: 1` 和本地隔离能力；CLI/TUI 继续读取原文字，不等待界面。

### 编写浏览器界面

每组件选一个固定 surface：tool-result 是结果内联卡片，session-sidebar 是会话侧栏。“固定”不代表自动或始终显示；由用户从工具结果打开，不在位置之间移动。只接受 UI schema/bridge 2，没有旧 surfaces/openSidebar 别名。

浏览器用 getSnapshot/onSnapshot 直接读取 appearance/capabilities，并调用 applyPluginUiAppearance 应用宿主的公共颜色、字体和减少动画设置。同 revision 的外观或能力更新保留本地输入；业务 revision 变化才重建结果。作者管理自己的表单；隐藏侧栏保留 iframe，关闭显示销毁并重置，宿主不缓存表单。

requestAction 只请求已声明的同插件 Native Tool，经宿主确认后执行。requestConversation 主动提供 { mode, expectedRevision, text, data }：draft 确认后加入输入框，submit 确认后建立普通 Input/Run 交给助手；实际提交不发送输入框已有草稿。插件没有宿主草稿 getter，也不能访问父 DOM。后台构造最终来源文本并持久保存普通会话结果；回执只代表当前受理/运行状态，不自动重试未知提交。

交接 text 非空且最多 4096 Unicode 字符，data 为最多 JSON UTF-8 32 KiB 的有限对象；业务 snapshot.data 上限仍是 256 KiB。只发送用户实际选择的内容，超限明确提示，不能静默裁剪；失败/取消保留本地输入。按钮根据 snapshot.capabilities.draft/submit 显示，交接还要求 pluginUiConversation=1。

仓库浏览器入口为 @vykor/plugins/ui-sdk，工具类型入口为 @vykor/plugins/sdk。独立作者复制 [create-plugin 离线样例](../skills/create-plugin/assets/text-inspector/) 后仅需 Node：node scripts/build-ui.mjs。附带 SDK（全局 VykorPluginUi）与 stylesheet 在构建时内联成 HTML，不依赖 npm 发布或源码仓库。维护者通过 node examples/plugins/text-inspector/scripts/build-ui.mjs --export-author-assets 从当前源机械导出两份 SDK/CSS，再运行各自构建脚本；不要手改 bundle/HTML。

完整可运行的 getSnapshot/onSnapshot/applyPluginUiAppearance/requestConversation 例子、SDK 方法和边界见 [插件 UI 作者接口](../skills/create-plugin/references/plugin-ui.md)。Native preview 与主动交接共同使用的真实 panel 源码见 [文本检查样例](../examples/plugins/text-inspector/ui/panel.mjs)。UI 没有父 DOM、Node、preload、文件、网络、剪贴板或任意 IPC；不用 CDN、外部资源、手写协议或 innerHTML 渲染用户内容。

当前设计见 [固定位置与会话交接](./superpowers/specs/2026-10-11-native-plugin-ui-continuity-design.md)；[早期规格](./superpowers/specs/2026-10-02-native-plugin-ui-design.md)保留历史交付事实。行为验证不等同用户查看样式或最终整合验收。

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

以上只说明格式，使用时须替换为真实服务地址。stdio 使用 command 和可选 args/env；http、sse 使用 url。当前不会为插件自动下载依赖、展开插件根变量或完成服务认证。静态加载成功只表示配置可读取，实际连接与工具发现发生在 MCP Runtime。

MCP 名称不会自动加插件前缀，请使用独特名称，避免与其他插件或用户设置同名。此类配置没有 Node Tool 的 plugin.root 调用上下文，不能直接把相对脚本路径当作已绑定的插件文件。

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
pnpm --filter @vykor/server exec vitest run src/http/routes/plugin-lifecycle.test.ts
```

测试使用临时用户安装记录和真实 Tool Host，不写入开发者日常插件安装状态。样例目录参与相关测试和类型检查的 Turbo 缓存输入，修改样例后会重新验证。

Output Styles、Themes、Monitors、Workflows、Channels、Providers、LSP、Wasm 和受管理二进制仍以当前 Loader 诊断为准；不要把 schema 中预留的字段当作已经开放的能力。Native UI 已接入后台、Desktop 隔离文档、公开浏览器 SDK 与参考插件；是否可用仍取决于客户端、后台、授权和当前安装快照。A4 不增加转换诊断，也不修改或删除现有转换器。UI 阶段范围见 [Native Plugin UI 规格](./superpowers/specs/2026-10-02-native-plugin-ui-design.md)；其他 Native 能力见 [开发设计](./superpowers/specs/2026-09-09-native-plugin-authoring-v1-design.md)与[实施计划](./superpowers/plans/2026-09-09-native-plugin-authoring-v1.md)。
