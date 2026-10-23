# 插件应用（MCP Apps）

MCP Apps 是页面与宿主之间的标准交互协议：页面使用官方 App SDK 请求工具、接收结果和引用选区，宿主负责展示、授权与执行转交。当前 Vykor 只在右侧面板展示插件应用，聊天保留具名入口。

根清单保持 `schemaVersion: 1`，页面入口是 `components.apps: ["./ui/apps.json"]`，`apps.json` 也使用版本 1。默认工程通过 `scripts/create-plugin.mjs` 生成；`--backend native|mcp` 选择一种后台，两版共用业务代码与页面，不要求同时运行。

## 两种后台的制作与运行流程

| 项目 | Native Tool＋MCP Apps | MCP 服务＋MCP Apps |
| --- | --- | --- |
| 后台接口 | Vykor 的 registerTools / invoke | 标准 MCP 的工具和资源接口 |
| 根清单组件 | components.tools 和 components.apps | components.mcpServers 和 components.apps |
| Apps 后台 | kind: native-tools | kind: mcp-server，server 指向真实服务名 |
| 页面来源 | resources：精确 ui:// 地址映射包内 HTML | MCP resources/read 返回 HTML |
| 工具关联 | Apps tools[].ui.resourceUri | MCP 工具 _meta.ui.resourceUri |
| 页面数据 | metadata.appData，由宿主转换 | MCP 结果 structuredContent |
| 执行进程 | 原 Tool Host 子进程 | MCP 服务进程；模板通过 stdio 启动 |

### Native Tool＋MCP Apps

1. 实现 `registerTools`，返回真实工具名、inputSchema 和 invoke；根清单声明工具入口。
2. 在 `apps.json` 声明后台、资源、工具和 `surfaces` 具名入口。工具参数来自真实注册，不重复定义或增加别名。
3. 构建离线页面和 Native 工具，安装时批准页面及实际工具所需权限。
4. 宿主读取包内 HTML，在右侧沙箱运行；页面使用官方 App SDK。
5. 页面调用路径为页面 → 宿主校验 → Native 适配 → Tool Host／Guard → invoke → 业务代码。
6. 文字放 `content`，页面数据放 `metadata.appData`；宿主转为 `structuredContent` 后返回。

Native 的适配只发生在宿主内部，页面协议仍是标准 MCP Apps，无需额外 MCP 服务。Native Tool 指工具接口，不指操作系统原生界面。

### MCP 服务＋MCP Apps

1. 实现标准 MCP 工具、资源列表与读取接口；根清单指向 MCP 服务配置。
2. 工具通过 `_meta.ui.resourceUri` 关联页面，并声明 `visibility`。页面资源类型为 `text/html;profile=mcp-app`。
3. `apps.json` 的 `mcp-server` 后台引用同插件真实服务名，`surfaces` 提供具名入口。
4. 构建服务入口和离线页面，安装批准后由宿主启动服务。天气模板使用 stdio，即进程标准输入输出。
5. 宿主用 `resources/read` 取得 HTML，在宿主沙箱运行；HTML 不在服务进程内运行。
6. 页面调用路径为页面 → 宿主校验 → MCP Client → `tools/call` → 服务业务代码，结果直接带 `structuredContent`。

页面与宿主通过 postMessage 上的 JSON-RPC 通信；宿主与 MCP 服务通过另一段 MCP 连接通信。页面不直接连 stdio，也不直接请求天气网站。MCP 后台接口可由其他兼容客户端使用；展示页面还需要目标宿主支持 MCP Apps，安装与授权仍按目标宿主规则。

两版天气工程都从 `plugin.config.json` 生成工具名与 `ui://<name>/panel`。Native 通过宿主 context 取得数据目录、会话和工作区；MCP 通过宿主注入的环境绑定取得对应值，不接受页面参数替换。`surfaces` 提供会话内入口，模板页面声明 `fullscreen`，仍在右侧面板展示。`assets/text-inspector/` 只作为更小的 Native 接线参考。

Native 工具保留普通 `content` 文字，页面数据写入 `metadata.appData`，宿主将它转成 MCP `structuredContent`。普通业务工具不生成可信 appId、requestId、控制版本或宿主执行状态。业务文档 revision 与 operationId 可以由业务维护，不能冒充宿主回执。app-only 可见性只限制调用入口，不能单独授予执行权限。

## 页面入口与结果

工具声明页面关联后，宿主才知道应把结果送到哪里。单纯返回 JSON、HTML 或文字，不等于注册了页面。

| 谁发起 | 页面要写的逻辑 | 宿主怎样反馈 |
| --- | --- | --- |
| Agent 调用工具 | connect 前注册 app.ontoolresult，校验并渲染数据 | 原结果返回 Agent；可信成功结果按原会话、插件、后台关联推给页面 |
| 用户点击按钮 | 绑定事件，await app.callServerTool，处理返回值和错误 | 结算原 Promise；不重复触发 ontoolresult |
| 用户直接打开页面 | 连接后按业务需要读取初始数据 | 不保证已有 Agent 结果，不能伪造默认业务结果 |

实时结果可以准备或更新常驻页面，工作摘要优先提示新事项；点击具名入口才定位右侧。历史消息不会自动打开页面，查看已打开应用的旧结果不会覆盖新正文。页面渲染来自宿主的结果，Agent 不直接操作 DOM。

Agent 使用原会话工具调用链，不先向页面发请求。页面操作则由宿主创建工具 Run（一次执行记录）；两条路径复用实际工具，继续接受各自的权限与来源检查。

下面是按钮接线示意，省略渲染和错误界面；`names` 使用生成工程的真实工具名，不能硬编码另一插件的工具名称。

```js
import { App, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { names } from "../src/identity.mjs";
const app = new App({ name: "My Weather", version: "1.0.0" }, { availableDisplayModes: ["fullscreen"] });
function show(result) {
  if (result.isError) throw new Error("工具失败，请查看回执");
  // 校验 structuredContent 后显示；这里不能再次调用工具或保存。
}
app.ontoolresult = show; // Agent 结果；必须在 connect 前注册。
app.onhostcontextchanged = context => {
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
};
await app.connect();
document.querySelector("#read-plan").addEventListener("click", async () => {
  try {
    const result = await app.callServerTool({ name: names.ReadPlan, arguments: {} });
    show(result); // 主动返回值不会自动触发 ontoolresult。
  } catch (error) {
    // 显示失败或待核实状态，保留输入；不直接重放写入。
  }
});
```

必须先登记通知再 connect。直接打开页面时主动读取真实文档与收藏，未取到天气前显示搜索入口，不伪造天气结果。天气模板的页面源码在 `templates/weather-travel/ui/`。主题通过官方 hostContext 更新，不清空输入；沿用宿主颜色与字体，以黑白灰、清晰日期与带单位的数值组织信息，支持键盘及减少动态效果。遵循所在项目的样式查看约定，不因接入页面自动搭建预览或截图。

天气 MCP 服务还可订阅备忘与收藏资源。资源变更通知只说明数据已变化，页面仍要读取最新资源、检查版本并保留本地草稿。MCP Apps 不会自动实现保存、冲突合并或表单持久化，这些由插件业务负责。

## 插件数据的有限自动保存

根清单声明 `permissions.pluginData: ["write"]`，安装时批准 `pluginData:write`。页面后端的 `toolPolicies` 只为精确 app-only 保存工具声明 `authorization: "plugin-data-write"`，并限制参数大小。例如工具名由当前配置生成后可得到：

```json
{
  "toolPolicies": [
    { "tool": "MyWeatherSavePlanDraft", "authorization": "plugin-data-write", "maxArgumentsBytes": 65536 },
    { "tool": "MyWeatherSetFavorite", "authorization": "plugin-data-write", "maxArgumentsBytes": 65536 }
  ]
}
```

这只允许页面把已编辑的备忘、收藏保存到当前插件数据目录。保存工具不接收 URL、后台地址、数据目录、会话或文件路径，不读取网络，不导出工作区文件。模型工具 `ApplyPlanOperations` 和导出工具 `ExportPlan` 不加这项策略，继续使用普通确认。不能给模型可见工具或任意网络/文件操作套上自动保存权限。

页面同一时刻只发送一次保存，收到 `saved: true` 且 operationId、文档和 revision 匹配的业务回执后才标成已保存。在途请求之后的新输入继续留在本地，不能被旧结果覆盖。后台将新版本和操作回执原子写入 SQLite：同 operationId 同参数返回原结果，异参数拒绝。

冲突时显示最新文档并保留收到的草稿；迟到回复不降低已知版本，读到相同版本不取消自动保存。用户明确采用新版时，通过同一有限保存工具确认清除后台冲突草稿，收到回执后再显示成功。错误或 unknown 时保留当前输入，不自动重试写入。恢复时只查询原 operationId 的 `GetOperation`，不能换 ID 重放；没有回执也不能推断失败。导出文件已发布但后续回执提交失败时，`operation_outcome_unknown` 同样进入待核实状态。如果宿主仍阻止调用，就显示待确认状态并继续保留草稿。收藏持久化并按插件共享，天气缓存只保留在后台实例内存；出行文档、回执和冲突草稿按会话隔离。只有后台收到并保存的数据可承诺恢复，尚未送达后台的最后输入不能保证跨关闭或重启恢复。

## 可见上下文与普通消息

`app.updateModelContext({ content: [{type:"text",text}], structuredContent: selection })` 把明确选中的内容加入原会话可见条目；不覆盖输入框，也不自动发送。普通发送时仍重新检查来源、授权和版本。用户可移除条目。

天气模板的出行选区包含 documentId、revision 和条目 ID；文档版本变化后旧选区不能直接作为写入依据，模型先读取最新文档。天气选区保留地点、日期、来源和时区，不能把引用操作当成修改或导出授权。

`app.sendMessage({ role:"user", content:[{type:"text",text}] })` 经宿主确认后发送普通用户消息，成功保持应用打开。只支持文本角色 user，不发送主输入框已有草稿。先检查 `app.getHostCapabilities()` 的 message/updateModelContext 能力。消息总共最多 4096 个 Unicode 字符；上下文结构化 JSON 最多 32 KiB。只携带必要选区，超限提示用户减少选择，不静默裁剪。

工具参数默认最多 64 KiB；精确工具的 `toolPolicies.maxArgumentsBytes` 可以声明符合宿主硬上限的有限值，仍应按实际业务设限。Native appData 最多 256 KiB、MCP 结果最多 1 MiB、HTML 最多 16 MiB、资源解码总量最多 8 MiB。Text Inspector 进阶参考在原文 JSON UTF-8 超过 48,000 字节时仍返回文字检查结果并省略交互数据；这个阈值不是所有插件的通用要求。

## 构建、安装和更新

作者生成独立工程后使用 Node.js 24 执行 `npm ci` 和 `npm run build`。package.json/package-lock.json 锁定官方 `@modelcontextprotocol/ext-apps` 1.1.2，以 esbuild 打包页面；MCP 另将官方 SDK 1.29.0 打包进服务入口。依赖准备需要 npm 或本地缓存，默认工程最终安装的 `dist/ui/panel.html` 是单文件，后台入口也已构建，安装时不构建、不下载依赖。不得分发 node_modules、使用 CDN、外部脚本/字体或私有页面 SDK。完整检查和打包见 [验证与交付](verification.md)。

修改源码后重建 HTML，增加插件版本，按原 install-local/重新导入流程升级。不修改用户安装快照和 dataDir；新权限仍按原规则批准。安装需要 ui:render/ui:invoke-own-tools，仍需实际工具权限、角色 allowedTools、deny 与环境检查。

## 常驻页面边界

切换面板或会话仅隐藏同一 iframe，保留输入和光标。隐藏脚本不能发起新工具、消息或上下文请求；已发送工作继续结算。取消、丢响应和 unknown 不自动重放。unknown 持久阻止后续工具和消息，重开不能解除。

官方 1.1.2 的实验能力 schema 会剥离自定义 namespace，当前不装配 widgetState。窗口关闭或重启不保证表单恢复；跨重启业务数据由插件自行使用原 dataDir 保存。页面没有 Node、preload、父 DOM、文件、网络、子 frame、任意 IPC 或剪贴板权限。不要手写通信协议或用 innerHTML 渲染用户数据。

页面通过官方 `App` 构造函数的 `availableDisplayModes` 声明显示模式。宿主根据握手结果选择支持的模式；省略按 inline 处理，inline-only 页面也统一进入右侧面板，不恢复聊天内嵌 UI。fullscreen 受右侧面板边界约束，更大空间使用宿主面板最大化。切换位置同步 hostContext，保留同一 iframe 和草稿。
