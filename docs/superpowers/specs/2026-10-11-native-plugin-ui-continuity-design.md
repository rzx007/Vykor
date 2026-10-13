# Native Plugin UI：固定展示位置、统一外观与会话交接

> 日期：2026-10-11
> 修订：2026-10-13；用户明确“不做兼容”，本轮只维护一套现行契约。
> 状态：无兼容方案已修订，等待本轮聚焦复核；此前的兼容设计不再适用。本文不代表功能已经实现。
> 基线：OpenHarness `feb050a3`；本地 Rome 对照仓库 `3ddf88cb`。
> 前置规格：[插件 UI 完整规格](./2026-10-02-native-plugin-ui-design.md)。本文是增量设计，不重做已经交付的 A1–A4。
> 配套：[实施计划](../plans/2026-10-11-native-plugin-ui-continuity.md) · [设计审查记录](../reviews/2026-10-11-native-plugin-ui-continuity-design-review.md)。

## 1. 本阶段要解决什么

现有插件组件可以同时声明内联和会话右侧，移动界面会重新创建 iframe，带来表单状态保存与恢复的额外工作。插件内部的颜色、字体也容易各自为政；用户还缺少一个明确的入口，把界面中的选择交给助手继续处理。

本阶段只交付三件事：

1. 每个 UI 组件在定义时固定选择内联或右侧面板；同一个插件可以包含位置不同的组件，不移动同一组件。
2. 宿主提供统一的外观信息；当前面板暂时隐藏时保持原 iframe，不增加表单草稿捕获、宿主缓存或关闭后恢复功能。
3. 用户可以把插件内容加入当前输入框，或者确认后作为一条普通消息提交给助手。

不加入独立应用页面、直接启动插件任务、插件 HTTP API、数据库迁移、应用商店、第三种展示位置、跨组件路由、跨插件工具调用或新的模型运行系统。LSP 继续暂缓。转换后的插件仍按 Native Plugin 管理，没有专用 UI 运行路径。

不保留旧 UI manifest、SDK、桥接或历史实例读取分支，不增加字段别名、自动转换或数据迁移。插件作者与 Desktop / daemon 使用同一现行契约；版本不匹配时明确拒绝，不继续提供部分 UI 能力。保留普通文字结果与安全错误展示，不因此删除会话历史。

## 2. 从 Rome 借什么，不借什么

调研依据是本地代码，不是对 Rome 已发布产品能力的推断。

| Rome 的做法 | 对 OHS 的借鉴 | 本阶段的边界 |
| --- | --- | --- |
| `RomeAppHost` 将主题变量传入应用；应用页与聊天内组件复用 web bundle | 不同位置的组件都使用宿主语义颜色 | 每个组件固定一个位置；继续使用单文件 HTML 与隔离 iframe，不换成 Shadow DOM / 动态模块导入 |
| `AppWidget` 固定 iframe 地址，另行同步宿主上下文 | 当前面板暂时隐藏不应丢失编辑进度 | 仅保留当前面板的原 iframe；不捕获表单，也不常驻所有历史 iframe |
| `AppComponentHost.submit` 将结果交给聊天，后台持久化 interaction result | 区分插件自己的工具操作和向助手提交普通输入 | 新增显式交接入口，不修改现有 `requestAction` 的含义 |
| SDK 的 `navigateRome` 预填草稿，`startChat` 创建输入并导航 | 区分预填与真实发送 | 只操作当前来源会话，不允许插件指定任意会话或创建新会话 |

具体参考：`rome/packages/web/src/components/rome-app-host.tsx`、`components/chat/entries/AppComponentView.tsx`、`pages/free/AppWidget.tsx` 和 `packages/app-web-sdk/src/runtime/index.ts`。

Rome 的页面模块与宿主共享 JavaScript 环境，部分 iframe 也没有 `sandbox`；OHS 不复制这条信任边界。Rome 内联组件还使用全局 bootstrap，多个组件之间可能覆盖上下文；OHS 继续以每次挂载的独立 MessagePort 绑定来源。

## 3. 保留的约束与当前落点

- 展示位置仍只有 `tool-result` 和 `session-sidebar`，每个组件只能声明其中一个。
- 原始工具调用先正常结束，文字结果始终可用；CLI、TUI 和未打开 UI 的会话不等待网页。
- `PluginUiInstanceRecord` 仍保存在来源工具 Part 的 `metadata.pluginUi`；Part 是一段会话内容记录，Run 是一次运行记录。
- 现有 `requestAction` 仍只调用同一插件声明的 Native Tool，不产生模型输入。
- iframe 继续 `sandbox="allow-scripts"`，不开放同源、网络、Node、preload、全局 DOM 或字体资源下载。
- 来源实例、插件授权、文件摘要、版本与生命周期检查继续由后台负责，插件传来的标题和标识不能替代宿主事实。
- 保留既有桥接限额、确认机制、真实 Electron 隔离测试；不扩大基础工具权限。

当前需要修改的集中点：

| 现状 | 源码位置 | 增量变化 |
| --- | --- | --- |
| snapshot 只有浅色/深色与位置 | `packages/protocol/src/plugin-ui-bridge.ts` | 直接加入必填 appearance / capabilities，不另建 presentation 通道 |
| manifest 的 surfaces 允许两项 | `packages/plugins/src/components/ui-schema.ts` | 删除数组字段，直接使用单值 surface |
| SDK 没有外观扩展或会话交接 | `packages/plugins/src/ui-sdk.ts` | 新增外观与主动交接 API，不增加读取表单的接口 |
| 移动或容量淘汰会重建/卸载 iframe | Desktop `plugin-ui-provider.tsx`、`plugin-ui-frame.tsx`；main `document-store.ts` | 移除移动入口与自动淘汰；保持当前面板暂时隐藏时的挂载 |
| 普通输入已支持持久 Input + Run 和去重 | Server `run-admission-service.ts`、`run-admission-work.ts` | 复用保存与派发，不让 UI 服务调用模型 |
| 会话已维护自己的输入框文档和附件 | Desktop `stores/desktop-session/composer-*` | 明确指定来源会话，追加文字而不覆盖草稿 |

## 4. 模块边界

```text
插件 HTML / ui-sdk
    │ 独立 MessagePort：外观、插件主动请求交接
    ▼
Desktop plugin-ui（固定位置展示、可见性、用户确认）
    │ 通过已绑定的 mountId 请求后台；不接受插件指定目标会话
    ▼
Desktop main plugin-ui（挂载所有权、连接与生命周期检查）
    │ typed client
    ▼
Server plugin-ui-conversation（来源校验、交接凭据、事务）
    │ 普通文本 Input + 普通 Run
    ▼
现有 RunAdmission / 运行队列 / SSE / 会话显示
```

| 模块 | 负责 | 明确不负责 |
| --- | --- | --- |
| `packages/protocol` | 严格类型、JSON 限额、请求与回执解析 | CSS 读取、DOM、安装状态、模型调用 |
| `packages/plugins` 的 `ui-sdk` 与可选样式文件 | 端口通信、外观应用、插件主动提交选择 | 读取表单、宿主草稿缓存、授权决定、任意 HTTP |
| Desktop renderer 的 `plugin-ui` 目录 | 固定位置展示、可见性、语义变量读取、确认预览、作用域正确的输入框追加 | 读取 iframe 表单、安装查询、后端权威状态、Run 创建 |
| Desktop main 的 `features/plugin-ui` | mount 所有权、daemon 能力探测、已绑定会话的客户端调用 | 表单字段理解、模型参数、提示词拼接 |
| `SessionPluginUiService` | 原有实例、工具 action；提供窄的来源/当前可用性校验方法 | 在现有大文件继续堆交接流程 |
| 新 `SessionPluginUiConversationService` | 构造交接文本、校验和保存提交回执、事务与重放 | Native Tool 执行、业务表单逻辑、新队列 |
| 现有 RunAdmission | 保存普通排队输入、用户消息优先规则、派发已有 Run | 插件组件、iframe、确认对话框 |

renderer 只新增两个聚焦文件：`plugin-ui-appearance.ts` 读取外观，`use-plugin-ui-conversation.ts` 管宿主确认和输入框接入。固定位置与显示数量规则仍放在已有 provider / document-store；不增加界面草稿模块。布局层和 `conversation-page.tsx` 只负责连接已有组件与回调，不实现协议解析或事务。

Server 只抽取现有来源校验供交接服务调用，以及一个无插件知识的排队输入保存方法。不要建立通用 contribution 注册器、可插拔策略框架、第二套会话模型或批量重构 RunAdmission。现有 `persistGoalRun` 保持入口与语义，由共享保存方法承接重复的保存部分。

来源校验提供三个窄入口：`readConversationSource` 只读取并验证真实来源 Part；`prepareConversationSource` 复用安装、授权、摘要和维护检查，并按 draft/submit 判断可用性；`assertConversationSourceCurrent` 在异步准备结束后同步复查来源、revision、维护标记与插件代次。它们不允许写入或执行工具。

交接可用性不能直接复用 `canInvoke`、`snapshot.readOnly` 或 `assertActionState`：draft 允许 open/resolved、不要求模型或 Native Host 成功启动；submit 要求 open 和可用模型，普通 Run 忙碌不阻止排队。两者都要求真实有效来源、已有 UI 授权与精确文件摘要，都拒绝 dismissed、归档/关闭会话、进行中或结果未知的 action。保留现有 UI 安装授权条件，不在本阶段另建权限类型。snapshot 的两个交接能力也据此判断；工具 action 的限制不变。

能力传递复用现有实例 GET：HTTP 组合层在 `PluginUiInstanceResponse` 增加必填 `conversation: { draft: boolean; submit: boolean }`，由交接服务根据该次已验证的实例/availability 与模型配置事实计算。main 严格验证两个布尔值，字段缺失或类型错误就是契约错误，不默认补齐；renderer 结合服务装配状态与可见性形成 snapshot.capabilities。该提示不是接收授权，POST 仍完整复查。不要为了按钮状态反复提交占位 prepare 请求，也不增加第四条能力路由或让原实例服务依赖交接服务。实施中的未装配模块显式返回两个 false，不以省略字段代表关闭。

appearance 只能在 renderer 读取实际 CSS。Desktop 内部 `PluginUiHostState.snapshot` 使用 `Omit<PluginUiViewSnapshot, "appearance" | "capabilities">` 表示 main 返回的业务部分，HostState 另带必填 conversation；Frame 每次用当前外观、交接事实和可见性组合出完整 snapshot 再交给 bridge。main 不读取 DOM、不硬编码主题默认值；这只是内部接线类型，不是第二条网页协议或兼容解析器。

## 5. 外观与两种位置

### 5.1 每个组件固定一个位置

组件定义直接使用必填单值 `surface`，不存在数组、默认位置或 `surfaces` 别名。UI manifest 使用 schemaVersion 2，完整文件示例：

```json
{
  "schemaVersion": 2,
  "components": [{
    "id": "text-inspector",
    "title": "文本格式检查",
    "entry": "./ui/panel.html",
    "surface": "session-sidebar",
    "actions": []
  }]
}
```

一个插件可以另外定义 `surface: "tool-result"` 的摘要组件。两者是独立组件，不是同一界面的两种布局，也不在本阶段增加组件之间跳转或共享未提交表单的机制。

缺失 surface、使用数组/别名、未知位置或非现行 schemaVersion 时拒绝 UI 定义，提示作者按现行规范重新构建插件；不猜测、不转换、不接受旧的单位置数组。此错误只使 UI 定义不可用，不以此拒绝整个插件的其他合法技能或工具。

`PluginUiInstanceRecord` 同样改为必填单值 surface，严格读取现行 schemaVersion。挂载校验当前组件、实例位置和摘要，不能由客户端选另一位置。不匹配的记录报 UI 不可用并保留来源工具文字，不解析旧形状、不重写历史，也不将旧实例绑定到新定义。

工具结果中的宿主卡片按声明提供“展开界面”或“打开面板”。右侧组件的卡片不是另一个内联 UI；它只保留结果摘要和打开入口。工具完成不自动展开或抢走当前右侧标签。重复打开同一实例只显示/聚焦原挂载，不重建 iframe。

移除“移到侧栏 / 移回内联”入口与 `openSidebar` SDK 方法、桥接方法和宿主处理器。任何此方法请求均按未知方法拒绝，不保留旧消息的聚焦或移动行为。打开/聚焦面板由宿主卡片入口负责。

### 5.2 宿主提供什么

外观来源是当前 Desktop 已应用的语义变量与外观设置，不从插件 manifest 生成另一套主题。

外观直接随 `PluginUiViewSnapshot` 初始化和更新，不提供 getPresentation / onPresentation 或单独的 presentation 通知。外观类型与 snapshot 的关键字段如下：

```ts
interface PluginUiAppearance {
  theme: "light" | "dark";
  colors: {
    background: string; foreground: string; muted: string;
    mutedForeground: string; primary: string; primaryForeground: string;
    accent: string; border: string; destructive: string;
  };
  fontFamily: string; fontSizePx: number; reducedMotion: boolean;
}
interface PluginUiViewSnapshot {
  instanceId: string; revision: number; status: "open" | "resolved" | "dismissed";
  data: Record<string, JsonValue>;
  actions: Array<{ id: string; label: string; completion: "keep-open" | "resolve" }>;
  readOnly: boolean; locale: string; surface: "tool-result" | "session-sidebar";
  activeAction?: PluginUiActionReceipt;
  lastAction?: { receipt: PluginUiActionReceipt;
    executionState: "not_started" | "completed" | "unknown"; message: string };
  appearance: PluginUiAppearance;
  capabilities: { draft: boolean; submit: boolean };
}
```

颜色采用宿主实际值，字体只提供 CSS 字体族与字号；iframe 无法访问宿主已加载的字体资源时使用系统字体，不声称字体文件完全一致。值严格限长，禁止 URL、CSS 规则片段与任意属性；SDK 逐个设置白名单变量，不拼接 `cssText`。

现有包新增可选 `ui-styles.css`，作者可以在构建单文件 HTML 时内联它。它提供背景、文字、按钮、字段、列表、焦点等最小基础规则，使用 `--ohs-*` 变量。不引入 React 组件库、Tailwind 编译约定、插件专用设计系统或强制覆盖作者的所有 CSS。stylesheet 是作者的样式选择，不是旧协议兼容开关。删除 snapshot 顶层重复 theme 字段，只以 appearance.theme 为准。

### 5.3 展示规则

- 宿主卡片已经显示组件标题，插件正文不重复大标题、插件名和操作状态。
- 作者为紧凑摘要、关键列表和少量操作选择内联；为多字段编辑、持续筛选和长列表选择侧栏。宿主不替作者动态改变位置。
- 切换右侧工具标签和折叠面板只暂时隐藏当前侧栏，不视为关闭插件显示。仅当前唯一的 sidebar display 保持挂载与原 key，隐藏时仍计入两帧限额。
- 隐藏不等于挂载失效：snapshot 与已接收请求的回执继续同步；隐藏期间拒绝新 action、dismiss 和交接，取消待确认请求，并在真正发送前复查可见性。已接收的操作不因隐藏而取消。容器使用 hidden/display:none 或 inert，不能仅用透明度阻止键盘焦点。
- 同一 owner 最多两个 iframe、最多一个侧栏。打开其他侧栏或第三个界面时拒绝新打开并提示先关闭已有界面，保留已有 iframe；renderer 和 main 均不再自动替换或淘汰。无需读取表单、判断是否编辑过或增加草稿确认框架。
- 不同实例的侧栏加载不再共用“后一次覆盖前一次”的 opening 身份；保留同实例过期加载检查。`document-store.register` 在任何写入或撤销前，同步检查同实例占用、侧栏占用和两帧容量；竞争失败只拒绝该请求，不影响其他加载或已挂载文档。拒绝时不改变原显示列表、活动标签与焦点，不增加新的协调框架。
- 默认文字与控件遵守 `apps/desktop/DESIGN.md`；普通结果不叠大 Card、厚边框和阴影。
- 可渲染 UI 的原始文本仍保留，默认折叠为“查看文字结果”；异常、无 UI 能力或加载失败时直接显示文字结果。
- 主题、字号、减少动态效果实时同步；键盘焦点与辅助技术名称保留。

## 6. 表单状态属于插件，不由宿主读取

插件用自己的 DOM / JavaScript 状态维护勾选、筛选、输入文字和滚动位置，无需提供“读取当前草稿”的函数。宿主不增加 `captureViewState`、`setViewState`、捕获通知或表单缓存，也不读取 iframe DOM。

`snapshot.data` 仍是已提交业务数据，来自后台 Part。未提交的本地表单不进入 SQLite、模型上下文、日志、安装目录或 `PluginUiInstanceRecord`。业务 revision 更新时，作者通过 snapshot 订阅处理新数据，不承诺自动合并旧表单。相同 revision 的外观或能力更新只调整样式和按钮，不重建表单或清空输入；参考插件必须把这两类更新分开处理。

| 操作 | iframe / 本地表单 | 后台业务记录 |
| --- | --- | --- |
| 切换右侧工具标签、折叠后再展开 | 同一个 iframe / key 保留，表单自然保留 | 不变 |
| 重复打开同一实例 | 聚焦原挂载，不重新创建 | 不变 |
| 打开其他侧栏、达到两帧上限 | 拒绝新打开，不卸载旧界面 | 不变 |
| 明确关闭显示或重新加载 | 卸载旧 iframe，本地输入不保留；重开从 snapshot 初始化 | 不改变实例业务状态，不自动提交 |
| dismiss | 按既有确认与版本检查结束实例并关闭 | 沿用既有 dismissed 状态 |
| 切换来源会话、连接重建、窗口关闭、权限撤回、禁用/卸载、摘要失效 | 直接撤销，不等待网页回调，不承诺恢复本地输入 | 沿用既有生命周期处理；已接收交接事实保留 |

关闭与重载入口用简短提示说明“未提交的界面输入不会保留”；无需探测脏表单或再增加保存确认协议。折叠面板和关闭插件标签必须有不同的语义与可访问名称。

utility-panel 删除折叠后的自动 close 和折叠按钮中的插件 close；只有明确关闭插件标签、重载或强制失效才拆卸。Frame/bridge 分开检查 mount 是否有效与当前是否允许用户交互，不以 `isActive=false` 代表暂时隐藏，避免断掉 snapshot 与回执同步。明确关闭只撤销旧挂载；显式重载先撤销已知旧挂载，再按现有所有权流程创建新挂载；之后重新打开时从 snapshot 初始化。不能用注册新文档顺带淘汰旧文档。

“加入输入框”是另一回事：插件在用户操作时主动构造 `text` / `data`，请求宿主确认并追加到聊天输入框。宿主不会为了此功能反向调用插件读取表单。当前阶段不增加插件表单的自动保存或跨会话、跨重启恢复。

## 7. 会话交接：预填与真实提交

### 7.1 插件能请求什么

```ts
interface PluginUiConversationRequest {
  mode: "draft" | "submit";
  expectedRevision: number;
  text: string;
  data: Record<string, JsonValue>;
}
```

`requestConversation` 只提出请求，不是授权。`text` 是想交给助手的说明，`data` 是用户选择的结果；正文非空，最多 4,096 个 Unicode 字符，data 最多 32 KiB，整个消息仍受 64 KiB 桥接限额约束。拒绝未知字段，尤其是目标会话、模型、权限、工具名和任意 Input/Run metadata。

宿主确认预览明确显示：来源插件与组件、目标当前会话、完整说明与数据，以及“加入输入框”或“提交给助手”。展示文本不能由插件伪装成宿主警告或授权按钮。取消、确认过期、会话切换、mount 撤销均不创建输入。

### 7.2 加入输入框（draft）

先调用后台 `prepare`，按 mode 校验真实来源与当前版本并构造最终 `promptText`；宿主显示这份完整文本让用户确认。确认后 main 再次调用 prepare，复查来源、revision、授权、维护标记与代次，要求最终文本与预览完全一致。prepare 的结果不是可跨越五分钟确认期的授权凭据。此准备与确认顺序也用于 submit；submit 最终仍在接收事务前复查。

最后 renderer 在一次同步 store 更新中检查当前连接、来源会话、代次和 revision 仍匹配，向**最新** composer 文档末尾追加一个文本项，并记录同一次确认已经处理；保留已有文字、skill 等输入项和附件，不清空、不自动发送、不修改实例状态。不在 prepare 时捕获一份旧 composer 文档再覆盖回去。不存在来源会话输入框时拒绝，不跳到别的会话追加。

追加与相同确认的重放在当前窗口内去重。回执只表示已追加；若窗口进程在追加后崩溃，不承诺跨重启“恰好一次”。用户可编辑这些文字，并按原来的发送按钮发送；编辑后的内容就是普通用户消息，不携带隐藏授权。

加入输入框不要求已经配置模型，也不使用 Goal 模式提交。界面已 resolved 但来源仍有效时允许用户加入草稿；归档/关闭会话、无效插件或结果不确定的 action 不允许。

### 7.3 提交给助手（submit）

必须经宿主确认，不依赖 iframe 声称有“用户点击”。可信 Desktop 宿主在确认流程开始时生成并保留稳定的 requestId；iframe 不能指定它。main 根据已绑定的 mountId 获得 sessionId/instanceId，在发出网络请求前同步记录该 requestId 对应的 owner、来源会话/实例和请求指纹。iframe 不能挑选后台输入 ID、调用模型或绕过普通工具权限。

首版每个实例只能成功提交一次，提交后实例变为 `resolved`。已由工具 action 结束的实例只能加入草稿，不能再次直接提交。需要多轮交互的插件可以通过新工具结果产生新实例，不在旧实例内增加一个无限增长的提交列表。

Server 的流程：

1. 捕获请求 JSON 与会话插件代次，通过现有 `SessionOperationRunner` 串行进入来源会话。
2. 检查已有宿主提交回执：同 requestId、同指纹直接返回原 Input/Run；同 ID 不同内容报冲突。不因实例已 resolved 或插件后来禁用而把已完成接收当成新提交。
3. 没有回执时，用现有来源校验确认实际已提交工具 Part、来源 Run 和实例绑定；校验插件启用、UI 授权、摘要、revision、非归档、实例 open、没有进行中或结果未知的 action。模型未配置则拒绝，允许改用加入草稿。
4. 异步准备后，提交事务前再次检查来源、revision、生命周期维护标记和捕获的插件代次。普通模型 Run 可以正在进行，此输入只排队、不 steer；插件 action 进行中则拒绝。
5. 在**同一 SQLite 事务**内保存普通文本 Input、普通 Run、来源 Part 的宿主提交回执，以及实例 `resolved` / revision + 1。
6. 事务提交后通过现有用户输入优先规则与 `dispatchPersistedRun` 派发该 Run；模型结果通过原有 SSE 和会话展示返回。

不从 UI 服务调用 agent 的模型方法，不创建新队列，不用 Goal 的入口替代普通用户输入，也不把一次交接变成新的自动 Goal。活动 Goal 的处理遵循已有普通用户消息优先规则；共享保存方法不能跳过取消待运行 Goal continuation 等行为。

### 7.4 回执与崩溃边界

来源 Part 新增独立的宿主字段 `metadata.pluginUiSubmission`，包含 schemaVersion、requestId、requestFingerprint、expectedRevision、inputId、runId、实际插件/组件摘要与接收时间。它不扩展已有严格的 `PluginUiInstanceRecord`，也不把用户未提交的草稿持久化。

此字段只能由宿主写入。Core 的工具结果 metadata 保留字段过滤必须排除 `pluginUiSubmission`，拒绝插件伪造；测试同时检查恶意原始输出不能变成受信 Part 字段。读取回执需验证它属于真实来源 Part，Input/Run 存在、会话一致且 Run 指向该 Input；不能凭插件传来的 inputId 查询其他输入。Input 只含普通 text 项，无新的输入类型、系统消息或保留 metadata 写入例外。

接收事务成功就是“已提交”，不是“助手已经完成”。派发失败则把**同一个** Run 标记 failed，返回已接收回执与失败状态；不能删除 Input、重新打开实例或自动发第二条消息。进程在提交与派发间崩溃时，沿用启动时对未完成 Run 的中断处理，显示已接收但中断；不自动执行未知结果。用户通过既有会话重试入口继续，而不是重新提交旧插件实例。

响应丢失时，Desktop 只使用原 requestId 查询回执。main 的查询入口使用已记录请求的 owner/来源会话/实例绑定，不要求 HTML mount 仍存活；检查窗口身份、当前来源会话和当前 daemon 连接后，调用只读 GET。它只提供给可信宿主，不增加 iframe 的查询任意目标能力。记录仅用于当前窗口和连接的未决请求，最多 16 条；宿主观察到来源 Part 中匹配的已接收事实，或窗口/连接失效后释放。不能仅因网络层已有响应就提前丢弃窗口尚未确认的请求；达到限额拒绝新提交而不丢弃未决记录。

查询本身不派发、不补创建、不自动换 ID 重试。未找到回执时展示“尚未确认提交”，用户重新确认同一请求才能重试；仍使用原 ID 和原内容。查询允许返回后来已被禁用插件的既有接收事实，但不重新加载其 HTML 或授予新操作。连接重建后不继续使用旧连接的记录；已提交事实仍可通过现有会话 Part/Run 显示恢复，不承诺跨连接自动恢复未决确认。

生成的消息正文明确分成“用户说明”和“插件提供的数据”，实际插件/组件来源由后台填写。所有内容是普通用户输入中的外部数据，不提升为系统指令、不提取内嵌指令执行；正文按固定顺序序列化并受限额约束，确认预览与保存正文必须一致。

## 8. 只维护现行协议

本阶段是破坏性更新，不协商旧形状，也不在当前解析器中接受多个版本。版本边界如下：

| 契约 | 现行规则 |
| --- | --- |
| UI manifest、工具 UI proposal、持久实例与 UI action 关联记录 | schemaVersion 2；位置字段仅为 surface |
| ready/init、桥接请求、响应与通知 | version 2；单一严格解析路径 |
| daemon UI 基础能力 | pluginUi: 2；Desktop 在加载文档前要求精确匹配，不回落到 1 |
| 新交接服务 | 装配后公布 pluginUiConversation: 1；实例响应的 conversation 字段始终必填 |

上述改动只针对 Plugin UI，不改变 Native Plugin 根 manifest、全局 daemon 协议或数据库表结构。已有生命周期能力的检查与语义继续保留。宿主新写入的 pluginUiSubmission 使用现行 UI schemaVersion 2，没有旧回执读取分支。

新增：

- `requestConversation({ mode, expectedRevision, text, data })`：返回带 `kind: "conversation"` 的回执。draft 返回已加入标识；submit 返回宿主 requestId、inputId、runId、revision 与 Run 状态。

SDK 使用现行 snapshot 的必填字段。创建 client 不接收草稿回调；工具 action、resize、dismiss 等已有业务功能保留，但不是旧协议的实现分支：

```ts
createPluginUiClient(): Promise<PluginUiClient>;
getSnapshot(): Promise<PluginUiViewSnapshot>;
onSnapshot(listener: (value: PluginUiViewSnapshot) => void): () => void;
applyPluginUiAppearance(value: PluginUiAppearance, root?: HTMLElement): void;
requestConversation(input: PluginUiConversationRequest): Promise<PluginUiConversationReceipt>;

type PluginUiConversationReceipt =
  | { kind: "conversation"; mode: "draft"; instanceId: string; revision: number; added: true }
  | { kind: "conversation"; mode: "submit"; instanceId: string; revision: number;
      requestId: string; inputId: string; runId: string;
      status: "pending" | "running" | "completed" | "failed" | "interrupted" };
```

作者通过 getSnapshot / onSnapshot 读取业务数据、appearance 和 capabilities，在页面内部应用外观；applyPluginUiAppearance 是 SDK 导出的独立样式辅助函数，不是桥接请求或 PluginUiClient 方法。主题或可见性变化推送相同业务 revision 的新 snapshot，SDK 不得仅因 revision 相等就丢弃更新。无 opt-in、null fallback、可选字段补齐或方法缺失时继续运行的分支。receipt 的 instanceId 必须匹配本挂载；draft 的 revision 等于请求版本，submit 的 revision 等于成功接收后的新版本，不因晚到 snapshot 而回退。

requestConversation 与 requestAction/dismiss 共用一次确认互斥、五分钟确认限额及 330 秒请求时限，取消与端口撤销语义一致，不能落入普通 30 秒请求时限。

Bridge parser 对现行 snapshot、工具 action 回执和 conversation 回执使用明确分支与严格字段，而不是接受任意 result 对象。未知方法、旧 envelope、旧字段和缺失必填字段直接报契约错误；不尝试另一种写法。

服务尚未装配、权限不足或模型未配置，可以在已匹配的现行协议中明确关闭业务能力；这不是跨版本降级。与 pluginUi: 2 不匹配的 daemon 直接拒绝整个 UI 挂载，提示更新，不仅仅隐藏交接按钮。

后台新增三条有类型的路由：两个 POST 由有效 mount 所有权校验后的 Desktop main 调用；只读 GET 使用宿主已记录请求的 owner/来源绑定校验，不要求 mount 存活。

```text
POST /sessions/:sessionId/plugin-ui/:instanceId/conversation/prepare
POST /sessions/:sessionId/plugin-ui/:instanceId/conversation/submissions
GET  /sessions/:sessionId/plugin-ui/:instanceId/conversation/submissions/:requestId
```

prepare 不产生持久记录；submit 请求额外带宿主 requestId；GET 仅查已接收事实。客户端添加三个对应方法。请求/回执类型放在小文件 `packages/protocol/src/plugin-ui-conversation.ts`，桥接文件只引用它，不承载业务规则。

## 9. 错误与拒绝行为

| 情况 | 行为 |
| --- | --- |
| 非现行 manifest / SDK / daemon / UI 记录 | 明确拒绝，提示按现行规范更新；无旧读取、字段转换或部分 UI 运行 |
| surface 缺失、数组/别名或请求错误位置 | 拒绝加载/挂载，给出单值字段提示；保留文字结果 |
| 外观读取异常 | 使用 SDK 内置中性默认值；不让 UI 因主题失效而无法使用 |
| 面板被占用或达到两帧上限 | 拒绝新打开，提示先关闭已有界面；不自动挤掉旧界面 |
| revision 已变化 | 拒绝旧交接；通过 snapshot 读取业务数据，由插件处理本地表单 |
| 插件禁用/卸载/摘要失效 | 撤销挂载；未提交请求失败，已有回执仍可查询 |
| 来源会话切换、连接代次变化、确认过期 | 取消确认，不向新目标写草稿或发送消息 |
| 没有模型 | 禁止直接 submit，保留 draft |
| 普通 Run 正在执行 | 新 submit 作为正常用户输入排队，不 steer、不取消正在执行的工具 |
| action 正在执行/结果未知 | 交接暂不可用，保留既有查看/取消/错误说明路径 |
| requestId 重用但内容不同 | 返回 `plugin_ui_request_conflict`，不产生第二条输入 |
| 数据库事务失败 | Input、Run、回执和 resolved 状态全部不提交 |
| 已接收但派发/模型运行失败 | 保留原 Input/Run/回执，展示失败或中断，不自动重放 |

错误采用现有 code/message 结构，新增 `plugin_ui_protocol_mismatch`、`plugin_ui_capacity_reached`、`plugin_ui_conversation_unavailable`；已有位置、revision、来源、生命周期和忙碌错误继续复用，不另造一套错误系统。

## 10. 验收与改动控制

| 可观察结果 | 必须有的证据 |
| --- | --- |
| 外观和可用性实时变化，只有现行协议可用 | protocol/SDK 严格必填字段与版本拒绝测试；相同 revision 更新和外观白名单测试 |
| 每个组件只有一个位置，宿主不提供移动入口 | manifest 单值校验、卡片入口、错误位置挂载及未知 openSidebar 请求拒绝测试 |
| 面板暂时隐藏后保留输入，明确关闭后重置 | provider / utility-panel 挂载身份与可见性测试；不需要草稿读取函数 |
| 新打开不会悄悄卸载已有界面或顶掉其他加载 | renderer / main 面板占用、并发侧栏、后一次加载失败与第三帧竞争拒绝测试 |
| 旧 mount、旧 revision 不污染新界面 | 端口迟到、显式重载与生命周期撤销测试 |
| 加入输入框保留原文字、技能项和附件 | 使用真实 composer store 的作用域/追加测试 |
| 确认取消和过期不发送 | Desktop bridge、main 所有权与确认测试 |
| 提交一次只产生一组 Input/Run | SQLite 事务、两客户端并发、响应丢失后的回执重放测试 |
| 来源/授权变化与伪造回执不能绕过 | Core metadata 过滤、Server 来源和生命周期竞态测试 |
| 排队和 Goal 行为仍正确 | RunAdmission 普通消息与 Goal continuation 回归测试 |
| 故障不形成重复模型调用 | 派发失败、事务中断、daemon 重启测试 |
| 原 iframe 隔离未退化 | 原有真实 Electron 安全用例；不新增样式截图/预览系统 |

交付按三个可分别验证的增量安排：固定位置与隐藏保留、统一外观、会话交接。前两项不依赖 Server 交接服务；第三项在完整端到端接通前保持能力关闭。更新现有文本检查参考插件与作者指南，不再创建一套 showcase 应用。

本阶段不迁移或自动删除旧历史数据，不改插件目录/安装/转换器，不自动发消息，不自动提交或 push。格式不匹配的 UI 记录不可操作，来源文字仍保留。实现完成仍需用户查看样式；自动检查通过不替代人工视觉验收。
