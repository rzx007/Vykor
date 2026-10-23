---
title: Vykor MCP Apps 开发与运行机制
subtitle: 统一右侧应用面板，保留工具执行、权限校验和操作回执
template: doc
theme: paper
source: 当前工作区源码 · 2026-10-23
---
> 状态：当前 MCP Apps 开发与运行机制说明；以当前源码和配套实施方案为准。

MCP Apps 让插件在聊天旁运行一个可交互页面。当前应用统一显示在右侧面板，聊天中只保留具名入口。

插件包、安装和能力加载见 [新插件体系文档](plugin-system.html)。本文单独说明应用协议和运行边界。

同一个 MCP Apps 页面可以使用两种后台：Native Tool 或 MCP 服务。两者的页面写法相同，区别在宿主怎样找到并执行工具。

## A 页面、宿主和后台怎样分工

```flow
用户 -> 应用页面: 编辑与点击
应用页面 -> 官方 App 协议
官方 App 协议 -> 桌面宿主: AppBridge 与控制器
桌面宿主 -> 主进程: 有限接口与来源检查
主进程 -> 会话服务: 授权与操作回执
会话服务 -> Native Tool 后台 & MCP 后台
Native Tool 后台 -> Tool Host 与 Guard
MCP 后台 -> 原 MCP Client
```

| 角色 | 负责什么 |
| --- | --- |
| 页面 | 表单、草稿、问题选择和结果展示 |
| 桌面宿主 | 固定右侧位置、确认框、可见性和协议通信 |
| 主进程 | 窗口归属、有限接口和固定请求 |
| 会话服务 | 应用身份、授权、操作准入、Run 和回执 |
| 实际后台 | 用原有工具执行业务逻辑 |

页面使用官方 @modelcontextprotocol/ext-apps 1.1.2。它没有 Node、任意 IPC 或宿主文件访问能力。

旧 Native UI 已退役。新应用使用 components.apps，不再注册旧页面入口。

### 两种组合的区别

MCP Apps 是页面与宿主之间的标准交互协议。宿主在这里指 Vykor：它展示页面，转交工具请求，并检查权限。

| 问题 | Native Tool＋MCP Apps | MCP 服务＋MCP Apps |
| --- | --- | --- |
| 后台入口 | Vykor 的 registerTools 和 invoke | MCP 的工具、资源接口 |
| 谁执行代码 | Vykor 的 Tool Host 子进程 | MCP 服务进程；天气模板使用本地 stdio |
| 页面从哪里取 | apps.json 将 ui:// 地址映射到包内 HTML | MCP 服务通过资源读取接口返回 HTML |
| 工具怎样关联页面 | apps.json 中的 tools[].ui.resourceUri | 工具元数据 _meta.ui.resourceUri |
| 页面数据放哪里 | metadata.appData；宿主转为 structuredContent | MCP 工具结果的 structuredContent |
| 页面怎样调用 | 官方 App SDK，经宿主适配到 Native Tool | 官方 App SDK，经宿主转为 MCP 工具调用 |
| 跨宿主复用 | 工具入口依赖 Vykor；页面使用标准协议 | 工具与资源使用标准 MCP；目标宿主仍需支持 Apps |

通信分成两段：页面与 Vykor 用 MCP Apps；Vykor 与后台使用相应工具接口。

页面通过 postMessage 发送 JSON-RPC 请求。MCP 模板的后台通过 stdio，即进程的标准输入输出，传输 MCP 消息。

Native Tool 的适配发生在 Vykor 内部。页面仍使用官方协议，不需要自定义通信协议，也不需要额外启动 MCP 服务。

这里的 Native Tool 指 Vykor 的工具接口，不指操作系统原生界面。两种组合都在右侧运行 HTML 页面。

## B 一个应用需要声明哪些信息

根清单用 components.apps 指向 ui/apps.json。应用清单保留 schemaVersion 1。

| 字段 | 实际含义 | 约束 |
| --- | --- | --- |
| backends | 页面可以使用的原有后台 | kind 为 native-tools 或 mcp-server |
| resources | Native 后台的页面资源 | 精确 ui:// 地址映射到包内 HTML |
| tools | Native 后台的工具引用 | 引用真实注册名，不另写参数定义 |
| visibility | 哪些调用方看得见工具 | model、app 或二者 |
| surfaces | 用户可直接打开的应用入口 | 指定后台、资源地址和可读标题 |

### Native Tool 如何适配

作者先实现 registerTools，返回真实工具名、inputSchema 和 invoke。根清单用 components.tools 声明这些入口。

随后在 apps.json 声明 native-tools 后台，引用真实工具名。resources 把页面地址映射到离线 HTML，surfaces 提供具名打开入口。

```flow
页面 -> Vykor 宿主: 官方 App SDK 请求
Vykor 宿主 -> 应用授权与操作回执
应用授权与操作回执 -> Native Tool 适配层
Native Tool 适配层 -> Tool Host: 原工具的 invoke
Tool Host -> 业务代码: 查询天气或保存备忘
```

安装批准后，宿主加载真实注册结果，取得参数定义和执行绑定。打开页面时，宿主读取已校验的包内 HTML。

调用继续经过原 Tool Host、Guard 和权限检查。适配层不创建第二套工具。

普通文字保留在 content 中。页面数据放在 metadata.appData，由宿主转为 structuredContent。

天气模板的 Native 入口从宿主 context 取得数据目录、会话和工作区。页面参数不能替换这些身份或目录。

### MCP 服务如何接入

作者先实现 MCP 服务，提供工具列表、工具调用和资源读取。根清单用 components.mcpServers 指向服务配置。

apps.json 声明 mcp-server 后台，server 引用配置中的真实服务名。surfaces 指向服务提供的页面资源地址。

```flow
页面 -> Vykor 宿主: 官方 App SDK 请求
Vykor 宿主 -> 应用授权与操作回执
应用授权与操作回执 -> MCP Client: tools/call
MCP Client -> MCP 服务: 模板使用 stdio
MCP 服务 -> 业务代码: 查询天气或保存备忘
```

安装批准后，Vykor 启动并连接服务，读取工具和资源声明。打开应用时，Vykor 用 resources/read 取得页面 HTML。

页面资源使用 text/html;profile=mcp-app。工具通过 _meta.ui.resourceUri 关联页面，visibility 声明调用方可见性。

服务提供 HTML，但 HTML 在 Vykor 的页面沙箱中运行。页面不会直接连接 stdio、访问文件或请求天气网站。

例如点击“查询天气”：页面请求宿主，宿主检查后调用 MCP 天气工具。服务访问天气接口，返回文字和 structuredContent，页面再显示数据。

天气模板由宿主向服务注入固定的数据目录、会话标识和工作区。MCP 的通用协议不会自动提供这些 Vykor 安装与授权约定。

```callout info 可见性与权限分开
app-only 只表示模型看不到该工具。
它不会跳过安装批准、角色限制或每次调用的检查。
```

## C 应用怎样打开，结果怎样进入页面

| 入口或事件 | 当前行为 |
| --- | --- |
| 右侧“应用”目录 | 打开或复用当前会话的应用标签 |
| 聊天中的“查看…” | 打开或定位右侧标签，不嵌入聊天 |
| 首次实时工具结果 | 优先展开右上角工作摘要；点击具名应用后才定位右侧面板 |
| 后续实时结果 | 更新原页面，保留当前标签选择 |
| 历史消息渲染 | 不自动打开应用 |
| 查看已打开页面的旧结果 | 只定位，不补发旧正文覆盖当前内容 |

主进程根据可信来源决定页面身份。多个入口共用资源地址时，不能仅凭地址合并页面。

每条不同的可信工具结果只投递一次。页面主动调用的结果直接返回原 Promise，不再推送第二份通知。

### Agent 调用：宿主把工具结果交给页面

用户说“查杭州天气”时，Agent 选择并调用天气工具。工具必须已经关联页面；返回一段 JSON 或 HTML 本身不会创建应用。

```sequence num
participants: Agent, Vykor, 插件后台, 应用页面
Agent -> Vykor: 调用已关联页面的天气工具
Vykor -> Vykor: 检查当前任务权限与工具来源
Vykor -> 插件后台: 执行 Native 或 MCP 工具
插件后台 --> Vykor: 文字与页面结构化数据
Vykor --> Agent: 工具结果，用于继续回答
Vykor -> 应用页面: 推送可信结果；未连接则等待连接
应用页面 -> 应用页面: ontoolresult 校验数据并更新界面
```

Vykor 根据原会话、插件、后台及资源关联定位页面。Agent 不操作页面 DOM，也不需要再发送一条“刷新界面”指令。

Agent 继续走原会话的工具调用链。页面调用则由宿主创建工具 Run，即一次工具执行记录；两条路径复用实际工具，不要求 Agent 先向页面发请求。

当前只把来源校验通过、已完成且成功的模型工具结果用作应用结果入口。页面尚未连接时，宿主先保留结果，握手后投递。

实时结果可以准备或更新常驻页面，但不会每次抢占右侧焦点。是否展示仍遵循上面的工作摘要与具名入口规则。

### 页面按钮调用：作者绑定事件并显示返回值

页面作者需要把“查询天气”按钮与真实工具名绑定。Vykor 不会从按钮文字猜测要调用什么工具。

```sequence num
participants: 用户, 应用页面, Vykor, 插件后台
用户 -> 应用页面: 点击查询天气
应用页面 -> Vykor: callServerTool 名称与参数
Vykor -> Vykor: 核对来源、权限及所需确认
Vykor -> 插件后台: 执行已绑定工具
插件后台 --> Vykor: 工具结果与业务回执
Vykor --> 应用页面: 结算原 Promise
应用页面 -> 应用页面: 校验返回值并更新界面
```

这里不需要 Agent 再做一次决定。页面自己的调用结果不会再触发 ontoolresult，作者必须处理 await 的返回值。

下面是接线示意，省略业务渲染和错误界面。names 来自生成工程的统一身份配置，不能随意填写不存在的工具名。

```js title="两种结果入口 · 接线示意"
import { App } from "@modelcontextprotocol/ext-apps";
import { names } from "../src/identity.mjs";
const app = new App({ name: "天气助手", version: "1.0.0" },
  { availableDisplayModes: ["fullscreen"] });
function receive(result) {
  // 校验 isError 与 structuredContent，更新结果区；保留本地草稿。
  // 不在结果回调里再次调用工具或触发保存。
}
app.ontoolresult = receive; // Agent 结果；必须在 connect 之前注册。
await app.connect();
document.querySelector("#read-plan").addEventListener("click", async () => {
  try {
    receive(await app.callServerTool({ name: names.ReadPlan, arguments: {} }));
  } catch (error) {
    // 显示失败或待核实状态，保留输入；不得直接重放写入。
  }
});
```

直接从具名入口打开页面时，不一定有 Agent 结果。天气模板在连接后主动读取备忘与收藏，天气查询由用户或 Agent 发起。

对订阅了业务资源的 MCP 页面，资源更新通知只说明“数据变了”。页面还需读取最新资源并检查版本；通知本身不携带完整新文档。

宿主保留应用支持的显示模式。省略声明按 inline 处理，inline-only 应用也能进入右侧面板。

fullscreen 请求仍受右侧面板边界约束。需要更大空间时使用宿主的面板最大化操作。

当前窗口最多保留 8 个页面，同会话最多打开 4 个应用。超限拒绝新开，不驱逐已有草稿。

## D 常驻、隐藏和后台运行的准确含义

实际 iframe 由根 Provider 持有。右侧面板只提供显示位置，切换不会搬移 iframe。

| 用户动作 | 页面与草稿 | 新操作 | 已提交操作 |
| --- | --- | --- | --- |
| 切换应用标签 | 保留，旧页面隐藏 | 旧页面禁止发起 | 继续结算原结果 |
| 收起面板 | 保留，同一窗口对象 | 禁止发起 | 继续结算原结果 |
| 切换会话 | 保留原会话页面 | 原页面禁止发起 | 继续绑定原会话 |
| 返回或展开 | 恢复原页面 | 检查通过后可操作 | 不重复提交 |
| 显式关闭应用 | 确认后可丢弃未保存草稿 | 关闭流程阻止新操作 | 按关闭与回执规则处理 |
| 窗口关闭或重启 | 不保证恢复内存草稿 | 重新打开后重新校验 | 不自动重放 |

### 隐藏以后还能做什么

| 行为 | 当前规则 |
| --- | --- |
| 保留页面脚本、本地状态和草稿 | ok 继续保留 |
| 接收后台资源更新并读取已授权资源 | ok 按现有权限继续 |
| 完成已经提交的工具操作 | ok 返回原操作结果 |
| 从页面发起新的工具调用 | no 即使是只读工具也会被拦截 |
| 从页面发送新聊天消息 | no 隐藏时拒绝 |
| 从页面新增聊天上下文引用 | no 隐藏时拒绝 |
| 继续等待尚未确认的请求 | no 隐藏时取消确认 |

限制作用于页面发起的操作。聊天中的模型任务不会因收起应用面板而自动停止。

连续后台工作若需要反复调用工具，会受到这条可见性规则限制。当前实现没有为隐藏应用提供持续自主调用授权。

## E 一次操作怎样确认、执行和返回回执

```sequence num
participants: 页面, 桌面宿主, 主进程, 会话服务, 原有后台
页面 -> 桌面宿主: callServerTool 名称与参数
桌面宿主 -> 主进程: 准备固定请求
主进程 --> 桌面宿主: 请求编号、参数与控制版本
桌面宿主 -> 桌面宿主: 按授权策略确认；有限自身保存免重复确认
桌面宿主 -> 主进程: 满足确认条件后提交原请求
主进程 -> 会话服务: 校验固定来源与授权
会话服务 -> 会话服务: 去重并创建一次 Run
会话服务 -> 原有后台: 执行原工具
原有后台 --> 会话服务: 执行结果
主进程 -> 会话服务: 查询原操作回执
会话服务 --> 主进程: 执行事实与结果
主进程 --> 桌面宿主: 原请求的回执
桌面宿主 --> 页面: 完整 MCP 工具结果
```

应用直接操作走宿主创建的工具 Run。它不会为了点击按钮而再次请求模型决定执行什么。

| 执行事实 | 实际含义 | 页面应怎样处理 |
| --- | --- | --- |
| not_started | 执行尚未开始 | 展示取消或准入失败，保留草稿 |
| completed | 执行已结算 | 继续区分业务成功、业务错误和数据展示错误 |
| unknown | 无法确认最终副作用 | 显示待核实，阻止新工具和消息 |

运行中的 unknown 仍需等待原回执，不能提前当作终态。终态仍为 unknown 时，也不能宣称操作没有发生。

丢失响应后只查询原请求，不重新 invoke。相同请求编号若对应不同内容，会被拒绝。

取消不保证回滚已经发生的写入。重新打开页面也不会清除持久化的待核实事实。

## F 权限校验为什么不会因新页面而放宽

| 层次 | 每次核对的内容 |
| --- | --- |
| 安装批准 | ui:render、ui:invoke-own-tools 和实际工具权限；自身自动保存另需 pluginData:write |
| 页面交互 | 是否可见、在线、仍打开，是否有待核实操作 |
| 主进程绑定 | 原窗口、页面挂载、原会话和固定请求 |
| 服务端授权 | 插件版本、内容摘要、后台代次及 lease |
| 工具执行 | 原工具归属、参数、角色、禁用项和执行环境 |

lease 是宿主保存的临时授权凭证。它把原会话、插件来源和后台绑定在一起，不下发给页面。

页面处于脚本沙箱和内容安全策略内。它不能直接使用父页面 DOM、Node、文件、任意网络或剪贴板。

引用到聊天使用 updateModelContext，只加入可见上下文条目。用户可以移除，引用不会自动发送消息。

sendMessage 需要宿主确认，并发送到原会话。它不附带主输入框已有的未发送草稿。

### 有限授权与大载荷

后台可在 toolPolicies 中按精确工具声明 authorization: "plugin-data-write" 和 maxArgumentsBytes。只有原安装明确批准 permissions.pluginData: ["write"]、真实工具为 app-only 且原绑定仍有效时，宿主才免除自身保存的重复确认。模型调用、工作区导出、deny、角色限制和 hook 不受此授权放宽。插件 Node 进程依然是受信任代码；工具声明不等于操作系统文件隔离。

普通工具参数仍默认 64 KiB；已声明工具可在应用请求 64 MiB 硬上限内使用更高额度。HTML、单次资源和工具结果保留原额度，大画板通过资源读取，不在保存结果里回传整张图。

会话忙且原操作尚未创建 Run 时，服务端才返回带原身份的 plugin_app_not_accepted / reason: busy。桌面核对后以标准 MCP 错误 data 返回 {code: "plugin_app_busy", notAccepted: true}；调用前隐藏返回 plugin_app_hidden。应用据此保留未提交编辑并等待，其他未知情况不得重新发起操作。

## G 草稿、冲突与两套版本怎样处理

### Text Inspector

- 编辑文本后使旧问题选择失效。
- 用户点击检查后显示新问题。
- 选择问题后生成修复预览。
- 模型新结果到达时保留本地编辑。
- 用户明确替换后才采用新结果。

### Notes

- 编辑立即标记为未保存。
- 保存只由用户手工触发。
- 远端更新保留本地正文并提示冲突。
- 手工合并后使用最新业务版本保存。
- 采用远端正文需要单独确认。
- 保存结果不确定时保留草稿，不自动重试。

### Excalidraw

- 连续编辑合并为串行自动保存，收到服务端确认后才显示已保存。
- 切换标签、收起面板或切换会话保留原页面草稿；隐藏期间的新保存等待恢复。
- 版本冲突和未知结果暂停自动保存，保留本地内容供另存或明确采用远端版本。
- 引用选区固定文档和元素 ID；Agent 修改前先读取最新业务版本。
- 导出到工作区及覆盖已有文件继续单独确认，操作保留原 Run 与回执。

### 天气与出行模板

- Native 与 MCP 两版共用业务代码、页面和保存规则。
- 页面编辑备忘与收藏使用有限自动保存，收到匹配的业务回执后显示已保存。
- 新结果更新天气与远端备忘快照，不覆盖尚未保存的本地编辑。
- 切换或收起保留草稿；隐藏期间不发起新保存。
- 冲突和未知结果暂停写入，保留草稿；已接纳请求只查询原回执。
- 引用出行条目携带 documentId、revision 和条目 ID，Agent 修改前读取最新版本。

| 标识 | 由谁维护 | 解决什么问题 |
| --- | --- | --- |
| controlRevision | 宿主应用记录 | 拒绝过期确认和关闭请求 |
| requestId | 宿主操作流程 | 找回同一次操作的 Run 与回执 |
| revision | 插件业务后台 | 判断笔记、画板或出行备忘是否已被修改 |
| operationId | 插件保存请求与后台 | 业务写入去重，重复请求返回原回执 |

宿主的操作回执与插件的业务回执各有职责。页面不能把业务版本当作宿主授权版本。

MCP Apps 只规定交互方式，不自动实现草稿、自动保存或冲突合并。插件负责业务状态，宿主负责页面常驻、权限和操作事实。

关闭应用发生版本冲突时，宿主保留原页面。用户检查最新状态后再明确重试。

## H 开发顺序、验收与源码入口

完整工程从 [天气与出行模板](../skills/create-plugin/templates/weather-travel/README.md) 开始。初始化脚本通过 --backend native 或 --backend mcp 生成一种后台；不需要同时启用两种后台。

两版都用 plugin.config.json 生成身份、工具名和页面地址。业务代码、页面与测试共用；安装包只包含所选后台的构建产物。

1. 先实现和验证原有后台工具。
2. 声明 Apps 后台、资源和打开入口。
3. 使用官方 App SDK 编写页面。
4. 先注册结果通知，再连接宿主。
5. 处理按钮返回值；初始化读取与自动保存按明确规则执行。
6. 将 SDK 和页面构建为离线 HTML。

页面应分别处理通知结果与主动调用结果。渲染结果时不要再次调用工具或自动保存。

主题通过 hostContext 更新，保留输入内容。控件沿用宿主语义颜色，并支持键盘操作。

| 边界 | 当前值 |
| --- | --- |
| 单页 HTML | 不超过 16 MiB |
| 资源解码总量 | 不超过 8 MiB |
| 工具参数 | 默认 64 KiB；按精确工具声明提高，应用请求硬上限 64 MiB |
| Native appData | 不超过 256 KiB |
| MCP 结果 | 不超过 1 MiB |
| 消息文本 | 不超过 4096 个 Unicode 字符 |
| 结构化交接数据 | 不超过 32 KiB |

验收时覆盖切换、收起、待确认取消、执行后隐藏、断线和丢失回执。还要覆盖旧结果定位及新结果不覆盖草稿。

当前不接入实验性的 widgetState。跨重启保存依赖插件后台和业务数据，不依赖 iframe 内存。

作者操作说明见 [原生插件开发指南](native-plugin-authoring.md)。可独立分发的步骤见 [插件制作参考](../skills/create-plugin/references/plugin-apps.md)。

| 想修改什么 | 仓库内入口 |
| --- | --- |
| 应用清单校验 | packages/plugins/src/components/apps.ts |
| Native Tool 适配 | packages/agent-runtime/src/node/plugin-apps/native-plugin-app-backend.ts |
| MCP 后台适配 | packages/agent-runtime/src/node/plugin-apps/mcp-plugin-app-backend.ts |
| 页面身份与授权 | packages/server/src/application/session/plugins/session-plugin-app-service.ts |
| 操作去重与执行 | packages/server/src/application/session/plugins/plugin-app-operation-service.ts、plugin-app-operation-executor.ts |
| 窗口绑定与确认请求 | apps/desktop/src/main/features/plugin-apps/plugin-app-service.ts |
| 常驻页面、协议和交互 | apps/desktop/src/renderer/src/components/desktop/shell/plugin-apps/ |
| 右侧应用标签 | apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/ |

源码基准为 D:/code/personal-project/OpenHarness-ts 当前工作区。历史文档中的聊天内嵌页面和 fullscreen-only 侧栏规则已被当前实现替代。

返回：[Vykor 新插件体系](plugin-system.html)。
