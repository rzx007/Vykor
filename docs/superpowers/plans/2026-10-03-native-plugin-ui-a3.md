# Native Plugin UI A3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 状态：Task1–6 已实现并通过受影响检查与真实双窗口 Native/SQLite Electron 验收；一次独立安全审查的P2已修复。见 [A3验证记录](../reviews/2026-10-03-native-plugin-ui-a3-verification.md)。沿用已确认的首版规格，实现基线 `c3b3d411`；使用现有隔离工作区，不修改 main，不合并、推送或发布。用户在2026-10-03要求剩余任务连续完成，覆盖下面原有批次停顿约定；仅运行受影响测试，不重复 A1 / A2 全分支审查。A4 不在本计划内。

**Goal:** Desktop 能按用户操作打开可信插件实例，插件通过隔离页面和有限消息接口请求操作，宿主确认后调用已完成的 A2 后台。

**Architecture:** main 用现有 VykorClient 取得并验证 HTML，在内存登记归属明确的文档；renderer 创建隔离 iframe，用独立 MessagePort 交互。业务事实仍由后台 Part / Run 和现有 SSE 提供，显示关闭只撤销挂载。插件管理另补撤销通知和 UI Run 结算，不取消无关普通模型工作。

**Tech Stack:** 现有 Electron 39.8.10、React、TypeScript、MessageChannel、Vitest、Vite 和现有 UI 组件；不新增 npm 包、浏览器下载或数据库表。

**Spec:** [Native Plugin UI 首版规格](../specs/2026-10-02-native-plugin-ui-design.md)，落实 A3 的 UI-17–UI-23。A4 的正式参考插件、作者交付和人工验收不在本计划内。

## Global Constraints

- UI 操作只使用声明的同插件 Native Tool，不开放 builtin、其他插件或 MCP。
- UI 不能绕过检查直接调用 ToolRegistry、Tool Host 或 tool.execute()。
- 初始工具正常结束，UI 操作是没有 inputId 的独立 Run；不请求模型、不创建虚假 Attempt、不自动唤醒 Goal。
- 专用文档 URL 为 `vykor-plugin-ui://frame/<mountId>`；mountId 不是文件路径。renderer / iframe 不获得 HTML 加载后门或 daemon token。
- iframe 仅使用 `sandbox="allow-scripts"`，不加入 allow-same-origin、allow-top-navigation、allow-popups、allow-forms、allow-downloads 或 allow-modals。
- 父页面仅增加专用协议的 frame-src；保留 `script-src 'self'`，不增加 unsafe-inline / unsafe-eval。
- 文档 CSP 固定：`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`。
- 禁用 camera、microphone、geolocation、clipboard-read、clipboard-write 和 fullscreen。阻止导航、弹窗、下载和外部打开，不把 CSP 当作导航保护。
- 唯一初始化以 `event.source === iframe.contentWindow` 校验；不把 opaque origin 的字符串 `"null"` 当作身份。
- 初始化后只接受该挂载的 MessagePort；旧 mountId、旧端口、未知方法、未知字段或复制身份不能操作。
- 单 HTML：UTF-8 2 MiB；业务 data：256 KiB；动作 args：64 KiB；JSON 深度：20。
- iframe 请求：JSON UTF-8 64 KiB；快照：512 KiB；每挂载待响应至多 16，待确认至多 1；滚动 60 秒至多 60 请求。
- 初始化：10 秒；普通请求：30 秒；确认：5 分钟；动作提交：确认后 30 秒。提交超时用原 requestId 查询，不产生新动作。
- 每窗口至多 2 个插件 iframe、1 个插件侧栏；同实例只运行一个 iframe。卡片高度 160–640 CSS px。
- unknown 不重放；关闭显示不取消业务；dismiss 与 Run cancel 分离。
- 不新增业务表、周期轮询或专用 WebSocket；不提升基础协议版本或新增必填 Snapshot 字段来实现 UI。
- 后台 features.pluginUi=1、features.pluginUiLifecycle=1 和 Desktop 本地隔离能力同时有效才展示交互入口；缺任一端保留普通文字结果。旧 A2 daemon 不被假定支持即时撤销。
- 必须执行真实 Electron 隔离测试。Node / jsdom 的通过结果不能代替 UI-19。

## 已核对的接线与实施判定

| 边界 | 当前入口 | A3 接法 |
| --- | --- | --- |
| 后台 | `client.pluginUi.get / getDocument / invokeAction / getAction / dismiss` | 只复用，不复制工具执行或动作状态机 |
| daemon 连接 | `DesktopSessionService.daemonClient / refreshDaemonClient` | 当前 Client 对象作为连接身份；刷新、失败和 dispose 撤销旧挂载 |
| IPC | `IpcChannels / IpcInvokeMap / DesktopAPI / desktopAPI / allIpcContributions` | 加有限 pluginUi 方法；只允许登记的主窗口 mainFrame |
| 主窗口 | `features/main-window/window.ts`、`main/index.ts` | ready 前注册协议，创建窗口时安装 frame 导航保护 |
| 消息展示 | `message-render-model.ts`、`assistant-message.tsx` | 有可信实例的工具单独展示，不进入普通 tool-group |
| 侧面板 | `utility-panel-tabs.ts / utility-panel.tsx` | 增加有目标实例的插件标签，不提供任意空插件页面 |
| 数据更新 | `SessionSubscriptionService`、`session-view-state.ts` | 继续使用原 cursor、快照替换和 SSE；挂载另按 revision 防回退 |
| 插件管理 | `server/http/routes/service.ts / system.ts` | 现有 busy / 维护规则之外补 UI 撤销与 UI Run 结算 |

实施时作以下明确处理，不重新设计产品范围：

1. SDK 复用纯浏览器的共享常量和校验代码，不从 `@vykor/plugins` 的 Node 主入口导入；所有 Node 依赖仍禁止。规格的“仅协议类型”表述与“共享限额”存在实现歧义，以共享浏览器安全校验、避免两份规则为准。
2. 已存在的 backend busy 门禁不能代替 UI 生命周期：管理变更先阻止新的相关 UI 动作，结算相关 UI Run，再尝试原维护入口。普通模型 Run 的原 409 行为不变。
3. 撤销通知使用现有 session.updated / Session metadata 的可选 `pluginUiGeneration` 标记；它只表示显示需要重新核验，不是 UI 业务状态或授权。不新增事件传输或必填基础协议字段。
4. 卡片默认折叠，用户展开或打开侧栏后才运行前端。A3 只添加现有对话样式的外壳与确认区域，不做全应用视觉改版。

Electron 的 protocol 注册与 Session 绑定、WebRequest 的窗口 / frame 字段已对照本地 39.8.10 类型。`protocol.handle` 不能单独证明请求来自哪个窗口，必须配合请求与 frame 保护；WebRequest 每类事件只能有一个最终生效 listener，不能覆盖其他功能已有的规则。[Electron protocol](https://www.electronjs.org/docs/latest/api/protocol)、[Electron WebRequest](https://www.electronjs.org/docs/latest/api/web-request)。

## 文件与任务边界

| 任务 | 主要产物 | 可独立验证的出口 |
| --- | --- | --- |
| 1 | 浏览器安全消息格式、SDK 与公开子路径 | 真 MessageChannel、浏览器构建、无 Node |
| 2 | 内存文档登记、协议和导航隔离 | 正确窗口可加载；其他来源、撤销、攻击被拒绝 |
| 3 | main / preload 的有限操作和连接归属 | 只通过当前挂载调用 A2，无凭据泄露 |
| 4 | 卡片、侧栏、宿主确认及快照显示 | 不自动执行历史代码；确认、只读和显示关闭正常 |
| 5 | 管理变更、断线、切换和源删除的撤销 | 旧页面 / 端口 / 确认失效，相关 UI Run 保守结算 |
| 6 | 真实 Electron 全链路与交付证据 | UI-17–UI-23 有明确实测记录；A4 不冒充完成 |

## Task 1: 浏览器消息契约与 SDK

**Files:** 新增 `packages/protocol/src/plugin-ui-bridge.ts / plugin-ui-bridge.test.ts`，`packages/plugins/src/ui-sdk.ts / ui-sdk.test.ts`、`tsconfig.ui-sdk.json`，`tests/browser-plugin-ui-sdk/{index.html,main.ts,vite.config.ts}`；修改 Protocol / Client 的公开类型出口及契约清单、Plugins package exports 和类型脚本。

**Interfaces:**

- `PluginUiViewSnapshot` 逐字段采用 Spec 14.1；不增加 sessionId、完整结果、Tool 输入或后台能力表。
- 共享 capabilities 增加可选 `pluginUiLifecycle: 1`；Task5完整接线后才能公布，Desktop不能只用旧 pluginUi:1 判断管理撤销已具备。
- `PLUGIN_UI_BRIDGE_LIMITS` 包含上述消息、挂载、速率、时间和高度常量。
- `parsePluginUiBridgeRequest(value: unknown)` 严格读取 `{version:1,mountId,id,method,params}`；id 非空且最多 80 字符。
- `parsePluginUiBridgeSnapshot(value: unknown)` 严格读取快照；`readPluginUiBridgeResponse(value: unknown)` 拒绝未知字段和无效版本。
- `createPluginUiClient(): Promise<PluginUiClient>`；方法只有 getSnapshot、onSnapshot、requestAction、openSidebar、resize、dismiss、dispose。
- ready 固定 `{version:1,type:"plugin-ui-ready"}`；init 固定 `{version:1,type:"plugin-ui-init",mountId}` 和一个转移端口。
- requestAction params 固定 `{actionId,args,expectedRevision}`；dismiss 固定 `{expectedRevision}`；SDK 从已接收快照取得 revision，不增加公开调用参数。其余方法仅接受空对象或 resize 的 `{height}`。

- [ ] 写失败测试：非有限数、深度、大小、额外 approved/toolName、错误 mount、重复 id、未知方法；快照泄露 sessionId 被拒绝。预期数据独立手写，例如：

```ts
const snapshot = {
  instanceId: "10000000-0000-4000-8000-000000000001", revision: 1, status: "open",
  data: { count: 1 }, actions: [{ id: "apply", label: "应用", completion: "keep-open" }],
  readOnly: false, theme: "light", locale: "zh-CN", surface: "tool-result",
};
expect(parsePluginUiBridgeSnapshot(snapshot)).toEqual(snapshot);
expect(() => parsePluginUiBridgeSnapshot({ ...snapshot, sessionId: "secret" })).toThrow();
expect(() => parsePluginUiBridgeRequest({
  version: 1, mountId: snapshot.instanceId, id: "1", method: "requestAction",
  params: { actionId: "apply", args: {}, expectedRevision: 1, approved: true },
})).toThrow();
```

- [ ] 运行 Protocol 聚焦测试，确认缺少契约造成失败。
- [ ] 实现严格校验和 SDK：只接受父窗口的一次 init；端口消息匹配 mount/id；首次有效 snapshot 后 resolve 工厂；structuredClone 保存参数，禁止 NaN 被 JSON 转成 null 后提交。
- [ ] SDK 超时或 dispose 拒绝等待中的 Promise，移除事件、清定时器、关闭端口；迟到响应不得重新创建请求或恢复旧快照。
- [ ] 用 test-only 的真实 MessageChannel 验证请求、响应、snapshot、dispose、错误来源、超时、revision 防回退；允许同 revision 的 theme / locale 更新。
- [ ] Plugins 增加 `"./ui-sdk"` 浏览器入口，不通过 Node index；专用 tsconfig 使用 DOM 类型。浏览器 Vite 消费 SDK，构建遇到 Node builtin / polyfill 外部入口即失败。
- [ ] 运行 Protocol、Plugins 类型和 SDK 浏览器构建；只提交本任务文件。

**Commands:** 使用 `pnpm --config.manage-package-manager-versions=false` 前缀，`--filter @vykor/protocol exec vitest run src/plugin-ui-bridge.test.ts`、`--filter @vykor/plugins exec vitest run src/ui-sdk.test.ts`、两包 `check-types`、`exec vite build --config tests/browser-plugin-ui-sdk/vite.config.ts`；公开 Client 出口变化时运行 `check:client-api`。

## Task 2: main 文档协议与实际隔离

**Files:** 新增 `apps/desktop/src/main/features/plugin-ui/{document-store.ts,document-store.test.ts,document-protocol.ts,window-policy.ts,window-policy.test.ts}`，`apps/desktop/tests/plugin-ui-electron/{main.ts,host.html,host.ts,attack.html,electron.vite.config.ts}`，`apps/desktop/scripts/test-plugin-ui-electron.mjs`；修改 `main/index.ts`、`features/main-window/window.ts`、`preload/index.ts`、renderer index.html 和 Desktop 测试脚本。

**Interfaces:** `PluginUiDocumentStore` 提供 register、authorizeRequest、respond、revoke、revokeOwner、clear；register 为内部可信调用，接收 ownerId、连接身份、实例和摘要，以及已核验 HTML，不成为 IPC。`installPluginUiDocumentProtocol(store, session)` 安装 handler 和请求检查。`attachPluginUiWindowPolicy(webContents, store)` 返回清理函数。

- [ ] 先写登记与撤销失败测试；相同 URL 的错误窗口、顶层导航、XHR、POST、查询参数、其他 mount、再次跨文档加载全部拒绝：

```ts
// 本任务的 test-only createDocumentFixture 登记 owner=42 的固定内存文档，
// 用 Node crypto 从独立 HTML 字符串计算 sha256，不运行 HTML。
const f = createDocumentFixture({ ownerId: 42, html: "<p>fixture</p>" });
expect(f.request({ ownerId: 43, method: "GET", resourceType: "subFrame" }).status).toBe(404);
expect(f.request({ ownerId: 42, method: "GET", resourceType: "mainFrame" }).status).toBe(404);
f.store.revoke(f.mountId);
expect(f.request({ ownerId: 42, method: "GET", resourceType: "subFrame" }).status).toBe(404);
```

- [ ] 运行聚焦用例确认缺少登记保护失败。
- [ ] ready 前一次注册 scheme，仅开启必要 standard / secure 支持，不开启 bypassCSP、ServiceWorker、通用文件或网络代理。ready 后按真正使用的 Session 安装协议。
- [ ] 请求检查必须核验 WebContents ID、subFrame、GET、精确 URL、实际 frame 身份及初次加载；无法取得这些事实就拒绝。协议 handler 只返回已授权的内存文档，不解释为文件路径。
- [ ] 文档添加固定 CSP、Permissions Policy、no-store 和 no-referrer；父页面只加 `frame-src 'self' vykor-plugin-ui:`。
- [ ] 保护登记的插件 frame 导航、弹窗、下载和外部打开；仅允许宿主首次加载及同文档 fragment。导航策略不能覆盖原正常浏览器 / 文件 / 外链功能。
- [ ] preload 明确只在 mainFrame 暴露对象；插件子 frame 不暴露 desktop、electron、require、process 或 Buffer。
- [ ] 立刻运行隐藏 Electron 的最小攻击验证：父 DOM / preload / Node 访问失败，外部请求和跨文档导航没有副作用；错误窗口不能访问登记文档。runner 只导入模块工厂，不启动主应用、托盘、更新器或用户 daemon registry，配置和 userData 均在测试临时根。若这里不成立，不继续开放 renderer 入口。
- [ ] 运行 main 聚焦测试及 node 类型，提交本任务。

**实际运行条件:** 本机已安装 package / 类型为 Electron 39.8.10，二进制可从已有 x64 缓存离线准备。已发现 `C:/Users/ruanz/AppData/Local/electron/Cache/41a5d68646d956d50e13830e121ea0b3d6ab378b6a0ce422aefc1ff214707879/electron-v39.8.10-win32-x64.zip`。仅解包到本计划忽略目录，检查目标处于当前 worktree；不覆盖用户安装或下载新版本。测试脚本使用 windowsHide、BrowserWindow show=false、独立临时 userData 和有界超时，退出时清理测试进程。

**Commands:** Desktop 聚焦 `exec vitest run src/main/features/plugin-ui/document-store.test.ts src/main/features/plugin-ui/window-policy.test.ts`、`typecheck:node`、新增 `test:plugin-ui-electron`。真实测试脚本在 Electron 下打印 JSON 结果和版本，不把启动成功当作隔离通过。

## Task 3: 有限 IPC 与当前挂载的后台操作

**Files:** 新增 `shared/plugin-ui-types.ts`、`main/features/plugin-ui/{plugin-ui-service.ts,plugin-ui-service.test.ts,ipc.ts,ipc.test.ts}`；修改 `shared/ipc-channels.ts`、`shared/desktop-api-contract.ts`、`preload/desktop-api.ts` 及测试、`main/features/index.ts`、`features/session/daemon-connection-service.ts / session-service.ts / session-subscription-service.ts`。

**Interfaces:**

```ts
type PluginUiMountInput = {
  sessionId: string; instanceId: string; surface: "tool-result" | "session-sidebar";
};
type PluginUiMountResult = { mountId: string; url: string; state: PluginUiHostState };
type PluginUiHostState = {
  snapshot: PluginUiViewSnapshot; plugin: { id: string; version: string }; title: string;
  availability: PluginUiAvailability;
  actions: Array<Pick<PluginUiActionDescription, "id" | "label" | "toolName" | "completion">>;
};
// 以上状态只给可信 renderer；发送 iframe 时只提取 PluginUiViewSnapshot。
// DesktopAPI.pluginUi：capabilities、mount、getState、invokeAction、
// getAction、dismiss、unmount，以及 onRevoked 的解除订阅函数。
// invokeAction/getAction/unmount 以 mountId 定位；getState 以 sessionId/instanceId 读取。
// dismiss 是宿主能力，以 sessionId/instanceId 和 DismissPluginUiInput 调用，
// 不要求已挂载 iframe，以便取消不可显示但仍 open 的实例。
```

- [ ] 写失败测试：未登记窗口或非 mainFrame 的 IPC 拒绝；额外 HTML / URL / token / 任意 method 拒绝；其他窗口的 mountId 拒绝；连接刷新或关闭发生于 await 中时，不能登记迟到文档或发动作。
- [ ] 运行测试确认没有 UI IPC 时失败。
- [ ] service 从真实 `desktopSessionService.daemonClient()` 取 Client，核验两项 backend feature、实例归属和允许 surface；读取文档，校验 UTF-8 大小和 sha256，再登记，返回 URL 而非 HTML。
- [ ] 使用实际 Client 对象和 owner / session 代次固定连接归属。对每个 await 后再查当前有效性；窗口关闭、会话切换、连接刷新和 dispose 撤销未完成挂载。
- [ ] 为连接增加生产使用的 invalidation listener，为会话订阅提供 `getOwnerSessionId(ownerId:number):string|undefined`；mount开始及所有await后必须仍属于该owner的主会话。不把 token 作为 renderer 可见连接标识。
- [ ] getState 从现有 Session attach / SSE 事实取得 busy、active / last UI Run；严格读取宿主 metadata。lastAction 仅返回文本内容的前 1,024 Unicode 字符和 executionState，不 stringify 整个原始结果。
- [ ] 动作使用原 requestId、expectedRevision 和声明 actionId 调用 A2；不重新构造 Prompt / Run 或调用 Native Host。API 请求取消、unmount 不取消已经准入的动作。宿主 dismiss 仍按后台检查 open/archived/active action；不可渲染或 unknown 时也能从卡片取消交互，不能强制先创建 iframe。
- [ ] 错误只返回固定安全代码和说明；生产日志不反射 HTML、参数、token、cache root。IPC 接收时先限制体积，不只依赖 renderer 检查。
- [ ] 更新完整类型化 IPC / preload / contribution 链；无本地隔离能力时 capabilities.available=false。运行有限入口、旧 preload、连接和订阅聚焦回归，Desktop node/web 类型，提交。

## Task 4: 工具卡片、侧栏、宿主确认与消息处理

**Files:** 新增 conversation-page/plugin-ui 下的 `plugin-ui-provider.tsx`、`plugin-ui-card.tsx`、`plugin-ui-frame.tsx`、`plugin-ui-bridge.ts`、`plugin-ui-confirmation.tsx` 及聚焦测试；修改 `message/message-render-model.ts / assistant-message.tsx`、`conversation-page.tsx`、`utility-panel-tabs.ts / utility-panel.tsx` 以及需要的 panel controller 类型。

**Interfaces:** `PluginUiProvider` 拥有窗口内挂载和确认；`PluginUiCard` 消费实际源 Part；`PluginUiFrame` 消费 Task 3 的 mount 结果。`createPluginUiBridge({iframe,mountId,isActive,handlers})` 只处理 Spec 五个方法，返回 pushSnapshot / dispose。handlers 的 requestAction / dismiss 先取得宿主确认，再走 Task 3。

- [ ] 写失败测试：可信 UI 工具不进入普通 tool-group；原文字和错误保留；折叠卡片不调用 mount；无本地能力也不请求文档。独立手写 Part / instance 夹具，不用生产读取器生成预期值。
- [ ] 实现 source call / result 配对后的 UI unit；仍使用共享可信 metadata reader，不把外部 proposal 当作实例。业务操作自己的工具 Part 不生成第二个 UI。
- [ ] 卡片展示插件身份、标题和状态；按用户操作加载。失败保留文字，并提供重载和插件状态入口；重载只刷新页面，不重跑工具。
- [ ] iframe 设置 sandbox、allow、title 和受限高度；绝不使用 srcdoc、blob 或主页面 HTML 注入。ready 按 actual contentWindow 核验，初始化后移除全局执行消息入口。
- [ ] 桥接严格验证字段、总大小、方法、mount、重复请求、速率、pending 数和 surface。readOnly 禁止动作；dismiss 另查 open / archived / active action。未知方法返回 method_not_supported。
- [ ] 确认使用现有 AlertDialog / Button，位于 iframe 外；显示插件 id/version、动作标签、真实工具名和可滚动的完整转义参数。最多一个确认；用户取消、超时、源删除或 mount 失效均不调用 API。
- [ ] 确认前冻结 requestId / expectedRevision / 参数；提交超时以原 requestId 查询 getAction，不重新准入。确认期间收到更新不能悄悄把 revision 换成新值。
- [ ] 插件侧栏只能从具体实例打开，不加入空页面工具菜单。搬到侧栏销毁原 frame；同窗口最多一个侧栏和两个 frame，第三个打开时淘汰最早非侧栏 frame，保留原卡片外壳。
- [ ] 关闭显示只 unmount；业务取消调用 dismiss；活动操作先用既有 Run cancel 并等 SSE 结算。关闭后焦点回到打开按钮，iframe 不自动抢焦点，状态使用 aria-live。
- [ ] 快照按 cursor 和实例 revision 合并；较旧响应不得回退。同 revision 的主题变化允许；theme / locale 来自实际宿主。无 SourcePart、会话切换、syncStatus=reconnecting 或旧 Client 时关闭/禁用对应能力。
- [ ] 运行卡片、bridge、面板和既有消息展示 / session-view-state 聚焦回归、Desktop web 类型；提交。

核心行为断言：

```ts
// 本任务 test-only 的 host fixture 使用实际 bridge 和 MessageChannel，
// confirm 为可控制的用户选择，invoke 为 A2 Client 边界。
const request = frame.requestAction("apply", { text: "before" });
await host.waitForConfirmation();
expect(host.confirmation.parameters).toEqual({ text: "before" });
host.cancelConfirmation();
await expect(request).rejects.toMatchObject({ code: "plugin_ui_user_cancelled" });
expect(host.persistedActionRequests).toEqual([]);
host.disposeMount();
expect(frame.pendingRequests).toEqual([]);
expect(host.businessInstance.status).toBe("open");
```

此例的 fixture 名称只是测试装配，不把这些字段或清理方法加入生产业务类；实际断言同时检查无 API 请求、端口关闭和业务事实不变。

## Task 5: 管理变更和旧挂载撤销

**Files:** 扩展 `server/application/session/session-plugin-ui-service.ts` 和 daemon 装配、`server/http/routes/service.ts / system.ts` 及 plugin-lifecycle 测试；修改 Desktop 连接 / session 订阅的生命周期 observer、main UI service 和 renderer provider 的相应测试。

**Interfaces:** 后台提供 `withPluginUiLifecycleMutation<T>(scope, work: () => Promise<T>): Promise<T>`；scope 固定 `{kind:"global",pluginId?:string} | {kind:"cwd",cwd:string}`。UI admission / preparation 用同一服务的临时禁止范围检查；这是维护保护的 UI 准入状态，不是另一把业务锁或执行队列。

- [ ] 先写真实 A2 Native / SQLite 的失败回归：活动 UI 权限等待/Native 调用期间禁用、卸载、重装和 reload；禁止相关新动作，原动作保守结算，普通模型 Run 不被取消。现有普通 busy 管理测试仍返回409。
- [ ] 生命周期入口在首次 await 前登记禁止范围，已有 UI 准入在最后 await / 事务前复验；选择相关宿主 UI Run，通过现有 runControl 取消并等终态，再执行原维护、安装写入和 Runtime 清理。finally 必须释放范围，失败也不能留下永久禁用。
- [ ] 使用现有 session.updated 将可选 `metadata.pluginUiGeneration` 更新为新宿主 UUID，通知相关会话旧挂载需要撤销；不改 UI 实例业务 status/revision，不写窗口 ID、mountId、HTML 或秘密。
- [ ] 用同一 helper 包住所有支持的管理路径：用户级插件变更按全局影响，cwd reload 按现有 cwd 范围；全局 plugins.enabled / uiEnabled 和会话能力关闭也撤销。普通 API 无完整 UI 装配时保留原行为，不声称 UI 生命周期可用。
- [ ] Desktop 订阅识别该代次变化，main 清文档、发 onRevoked；renderer 关闭 frame / port / 确认。即使 SSE 迟到，后台临时禁止和之后的当前快照检查仍阻止动作。
- [ ] 断线允许只保留最后持久数据，动作立即禁用；切换 Client / Session、源 Part 删除、窗口销毁立即撤销。旧 HTTP 返回不能恢复旧挂载。
- [ ] 原内容摘要匹配且当前批准、启用、Runtime 准备成功后才能重新打开；不静默替换旧版本或自动迁移历史实例。只有真实 mutation helper、代次通知和订阅链全部接线后公布 pluginUiLifecycle:1；否则 Desktop 只显示原结果。
- [ ] 运行真实管理交错、既有 plugin lifecycle、关闭60项影响范围，以及 Desktop 连接 / 订阅 / session-view-state 回归；只因本任务真实修改而扩充测试，不重复未修改的 Kernel 全套。

## Task 6: 真实 Electron 验收、文档与交付

**Files:** 完成 Task 2 的隐藏 Electron runner / fixtures，必要的 SDK/browser 断言；新增 `docs/superpowers/reviews/2026-10-03-native-plugin-ui-a3-verification.md`；更新当前作者指南、Spec / plan 阶段状态，不修改 A4 样例宣称。

- [ ] 实际运行生产 scheme / policy / main service / renderer bridge / SDK。两个登记窗口共享同一真实后台实例，固定本地模型输出，Native 动作写测试计数文件；不连接外部模型、GitHub 或网络服务。
- [ ] 验证错误窗口、顶层、未登记、撤销后、查询参数、其他 mount URL、重载及 POST 不取得文档；仅初始精确文档和同文档 fragment 合法。
- [ ] 攻击页尝试父 DOM、preload、Node、文件、fetch、外部 script/font/image、iframe、worker、导航、弹窗、下载、外部打开和 meta CSP 放宽；检查实际网络接收数、文件访问、窗口数和宿主状态，而不只看 preventDefault spy。
- [ ] 真 MessageChannel 验证伪造 source、`origin="null"`、旧 mount、重复 init、未知字段/method、rate/pending 上限；它们不能调工具或跳过确认。
- [ ] 验证动作确认前无副作用，取消无副作用，确认后真实 Native 只执行一次；两个窗口同时基于旧 revision 确认时只一个成功，另一个冲突，SSE 最终一致。
- [ ] 验证切换会话/daemon、断线重连、Part 删除、插件管理与 pending mount/confirmation/action 的交错；显示关闭不取消业务，拒绝更新不覆盖原文字。
- [ ] 记录实际 Electron 版本、命令、结果、截图或必要的日志内容；预期错误精确匹配，未知 stderr 仍使测试失败。检查公开响应与日志中的实际字符串，避免 Windows JSON 转义漏检。
- [ ] 执行受影响包的类型、SDK 浏览器构建、Desktop build（不打包/发布）、文档及 whitespace；仅做一次聚焦隔离层审查和必要修复，不重新审查 A1/A2 全分支。
- [ ] 保存 UI-17–UI-23 每项证据、限制和剩余 A4 范围。UI-24 的参考插件人工交互、UI-25/26 的完整首版交付仍不能标成通过。

## 执行批次与效率约定

1. **第一批：Task 1 /2。** SDK 与隔离层先形成可运行证据；若真实 Electron 无法证明隔离，先解决，不搭建可交互入口。
2. **第二批：Task 3 /4。** 接后台、卡片和侧栏，验证一次实际“打开→请求→确认→回执→SSE”。
3. **第三批：Task 5 /6。** 补管理撤销、交错安全和交付证据；A3 完成后才进入 A4。

每个批次报告实测结果和下一步，不因正常检查点反复询问是否继续。只在缺关键决定、真实安全方案不成立或需要外部/不可逆操作时停下。每项先失败测试，再实现、聚焦验证和本地提交。

所有 pnpm 命令使用 `--config.manage-package-manager-versions=false`；按现有 sandbox 授权读取本地依赖。不重装全部依赖、不下载 Electron、不运行真实模型、不执行 release / updater / installer，不移动或清理 main 的用户文件。

## 计划自查

| 检查 | 判定 |
| --- | --- |
| UI-17 / SDK 真公开方法、浏览器可执行 | Task 1 与6 |
| UI-18 / 文档归属和撤销 | Task 2、3、5、6 |
| UI-19 / 实际 frame、Node、导航隔离 | Task 2 早期闸门，Task 6 全链路 |
| UI-20 / 主 CSP、消息来源、白名单和确认 | Task 1–4、6 |
| UI-21 / 全部支持的管理、连接、会话和源撤销 | Task 3–6；明确补 A2 未完成的管理组合 |
| UI-22 / 原结果和无 UI 能力回退 | Task 4、6；A2 无界面证据保留 |
| UI-23 / SSE 去重、重连和迟到响应 | Task 3–6 |
| UI-24–26 / A4 未越界 | 正式样例及人工验收不属于本次 |
| 基础协议、数据库、工具执行 | 不改必填形状、不新增表、不复制执行链 |
| 跨任务契约 | snapshot/message 在Task1定义；document在Task2；IPC/mount在Task3；界面在Task4；撤销在Task5 |
| 环境 | 本地包/类型和同版本 x64 Electron 缓存存在；运行证据仍须实际产生 |
