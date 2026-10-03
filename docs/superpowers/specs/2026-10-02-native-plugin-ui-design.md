# 插件 UI 完整规格：工具结果卡片与会话侧栏

> 状态：当前首版设计；A1 静态定义、加载、授权与管理反馈，以及 A2 可信实例、持久动作和 HTTP / Client 后台接口已实现。A2 审查遗留的普通 Run 关闭遗漏已修复并通过定向回归，本次未重复全分支独立审查；Desktop 隔离文档、消息接口和交互界面尚未实现。具体证据和未验收范围见 A2 验收记录。
> 日期：2026-10-02
> 产品：OpenHarness；仓库包名和原生插件目录继续使用 Vykor / `@vykor/*` / `.vykor-plugin`。
> 首版交付：Desktop 中的 Native Plugin UI，包括自定义 HTML、工具结果卡片、会话侧栏、受控工具操作和持久状态恢复。
> 实现范围以各阶段验收记录为准；本文仍包含尚未实施的 UI 运行接口。

## 1. 目标与成功条件

插件除了给模型提供工具，还能给用户提供可操作的界面。用户可以在聊天中查看结构化结果、填写表单、选择条目、审阅内容，并通过明确操作调用插件自己的工具。

首版必须完整走通以下流程：

1. 用户安装含 UI 的原生插件，安装预览展示 UI 数量与相应授权。
2. 模型调用插件工具，工具正常结束，同时在返回值中提供 UI 组件标识和数据。
3. Desktop 在该工具结果的位置显示插件卡片；用户展开后加载界面，也可以移到会话侧栏。
4. 用户在界面请求一项操作，宿主显示操作名称、目标工具和参数；用户确认后，后台通过现有工具检查与执行流程运行。
5. 操作结果、运行记录和更新后的业务数据写入会话存储，再同步回所有连接中的客户端。
6. 用户关闭页面、重开聊天或重启 daemon，已经提交的状态仍可恢复，副作用不会因为恢复显示而重复执行。

判断价值的首个产品场景是 PR 审查：显示问题列表、勾选待处理问题、查看对应 diff、执行选定操作，再查看结果。首个自动验收插件采用现有“文本检查助手”的 UI 扩展，避免把 GitHub 认证、真实代码修改或模型网络引入基础验收。

## 2. 用户场景与范围

| 场景 | 用户需要的界面 | UI 操作后的结果 | 首版覆盖 |
| --- | --- | --- | --- |
| 文本检查 | 问题列表、筛选、条目选择 | 调用无副作用的分析工具，更新选中项的解释 | 是，参考插件 |
| PR / 代码审查 | 问题列表、diff、选择操作 | 调用插件声明的检查或修改工具 | 是，能力支持；外部服务由业务插件提供 |
| 数据查询 | 表格、图表、查询参数 | 用户确认后重新查询，更新结果 | 是 |
| 部署准备 | 环境参数、预检结果、执行摘要 | 调用插件自身的预检或发布工具，继续受工具权限约束 | 是；UI 本身不批准发布 |
| 多文件操作 | 待处理列表、选择范围、执行结果 | 调用插件自身的批量工具 | 是 |
| 上下文占用 / CI 状态条 | 常驻输入框附件、全局状态栏 | 订阅会话或外部事件并持续更新 | 后续扩展位置 |
| 收件箱 / 价格监控 | 独立应用页面、历史列表、持续后台任务 | 离开聊天后仍持续运行 | 后续应用阶段 |
| 通用 MCP 工具界面 | MCP Apps 提供的 HTML、表单、图表 | 通过标准桥接调用 MCP 工具 | 独立后续阶段 |

首版运行端是 Desktop。连接远程 daemon 时，HTML 从远程 daemon 取回后在 Desktop 的隔离文档中显示，插件工具仍在 daemon 所属的运行环境执行。Native Tool 目前只支持 local 环境；本规格不扩大到 WSL。

CLI、TUI、普通 Web、IDE 和 Bot 在首版继续使用工具文字结果；不向这些入口注入浏览器脚本。Headless 运行不会因为 UI 组件未打开而等待或失败。

## 3. 明确不在首版内的能力

- 独立应用路由、应用市场、插件自己的 HTTP 服务、数据库迁移或后台调度系统。
- 任意修改宿主 React 树、替换权限对话框、注入全局 CSS、访问 Electron preload 或 Node API。
- 为插件开放任意工具名、其他插件、任意 MCP server 或宿主全部会话。
- 自动执行 UI 操作、自动发送模型输入、自动批准权限、自动重试副作用。
- 类似 Claude Mods 的内部函数 Hook 执行兼容层。
- 一个新的通用 JSON UI 语言、组件工厂系统或独立 SDK 包。
- 暂停一个模型工具调用数小时，等待用户完成网页操作，再恢复旧调用。
- 第三方 Node Tool 的操作系统级沙箱。本规格新增的是前端隔离，不改变现有 Node Tool 的安全保证。

完整的 MCP Apps 接入和 Rome 式独立应用分别见第 22 节；它们不是首版验收的隐含要求。

## 4. 设计前事实与复用点

下表以 2026-10-02 设计前的工作区代码为依据；A1 交付后的能力见验收记录与当前作者指南。

| 当前能力 | 代码位置 | 设计影响 |
| --- | --- | --- |
| Manifest 已认识 `components.ui: string[]` | `packages/plugins/src/types.ts`、`manifest/schema-v1.ts` | 沿用 Native manifest schemaVersion 1；为 UI 文件单独定义格式版本 |
| UI 仍在延后支持的组件列表 | `packages/plugins/src/load-native-plugin.ts` | 必须实现 UI 元数据加载，不能把识别字段等同于已能显示 |
| 安装授权根据 manifest 重新计算 | `packages/plugins/src/installation/installer.ts`、`verify.ts` | UI 新增授权必须同时进入预览、安装和安装后校验 |
| 安装快照包含内容摘要，开发 link 单独处理 | `packages/plugins/src/installation/cache.ts` | UI 必须绑定准确快照；不能只按插件 ID 找“当前最新版” |
| Native Tool 已有来源登记和 Run 能力视图 | `packages/agent-runtime/src/native-tools/activate.ts`、`run-capability-view.ts` | 后台可证明工具属于哪个插件，并固定本次运行的定义和调用函数 |
| 工具结果支持自由 metadata，宿主身份字段会过滤 | `packages/core/src/types/tools.ts`、`engine/tool-result-feedback.ts` | 插件只能提议 UI；最终身份、状态和权限仍由宿主生成 |
| 工具结果会进入会话 Part 的 output 与 metadata | `packages/server/src/application/session/transcript-projection.ts` | 原始工具结果保持不变，UI 当前状态放在该 Part 的宿主 metadata 中 |
| Run 可以没有 inputId；调度器接受 work 回调 | `packages/services/src/runs/run-repository.ts`、`packages/server/src/runtime/run-coordinator.ts` | UI 操作复用 Run 和会话执行车道，无需伪造模型 Prompt |
| 工具校验、授权、Hook、超时和取消目前在 QueryEngine 内组合 | `packages/core/src/engine/query-engine.ts` | 必须提取可复用的受检工具执行入口，不能直接调用 `tool.execute()` |
| Snapshot、SSE 和 Part/Run 更新已存在 | `packages/protocol/src/session.ts`、`packages/client/src/resources/session-resource.ts` | 不新增 UI 专用持久数据库或另一条会话同步连接 |
| Desktop 已禁止 Node integration，主页面限制内联脚本 | `apps/desktop/src/main/features/main-window/window.ts`、`src/renderer/index.html` | 插件文档必须使用独立文档来源，不能靠放宽主页面 CSP 运行 |
| MCP 结果目前被压成文本 | `packages/mcp/src/index.ts` | MCP Apps 需要另外完成原始结果与工具 UI 元信息保留 |
| Claude Converter 处理传统 Hook 事件映射 | `packages/plugin-converters/src/claude-code/converter.ts` | Mods 的 `modules` 入口必须明确诊断为不支持，不得宣传直接兼容 |

实现时仍需遵守 [协议契约](../../protocol-contract.md)、[安全边界](../../security-and-trust-boundaries.md)、[运行状态契约](../../agent-lifecycle-contract.md) 和 [原生插件开发指南](../../native-plugin-authoring.md)。

## 5. 方案选择

### 5.1 选用：宿主外壳 + 隔离 HTML + 受控消息接口

宿主拥有卡片标题、插件身份、展开/关闭按钮、操作确认、权限提示和错误提示。插件只拥有内容区域，交付一个预构建、单文件 HTML；JavaScript、CSS 和小型图片打包进该文件。

首版所有自定义插件界面统一在 sandbox iframe 中运行。插件可以使用 React、Vue 或普通 JavaScript，宿主不需要知道其框架，也不动态 import 第三方组件。

Run 准备时同时捕获插件 UI 定义、pluginVersion、pluginDigest 和 componentDigest，随现有 RunCapabilityView 保持不可变。创建实例使用这份定义，不能根据 ownerPluginId 再查询已经更新的全局插件目录。UI 动作则根据实例摘要校验当前快照后捕获新的执行视图。

宿主通过消息接口提供有限能力：读取本实例状态、请求已声明操作、打开侧栏、调整卡片高度、取消本交互。数据和工具调用由后台决定。

### 5.2 未选用方案及原因

| 方案 | 优点 | 本阶段不选的原因 |
| --- | --- | --- |
| 直接把插件 React 组件注册到宿主 | 交互自然、共享组件方便 | 第三方代码进入宿主页面；框架版本、卸载和全局状态约束更重 |
| 用 JSON 描述所有表格、表单和布局 | 可由宿主统一绘制，也方便跨端 | 需要设计和长期维护新的 UI 语言；复杂图表和 diff 最终仍需要自定义界面 |
| 每个插件启动自己的 Web 服务 | 能直接使用普通网站工具链 | 增加端口、认证、服务生命周期与远程部署问题 |

宿主继续复用已有组件实现卡片和侧栏，不为第三方前端提供任意 Slot。DeepSeek 的扩展位置机制和 Claude 的事件绘制思路用于确定边界，不复制其整套运行系统。

## 6. 核心概念与归属

| 概念 | 含义 | 谁拥有 |
| --- | --- | --- |
| UI 定义 | 插件包中的组件 ID、HTML 入口、位置和允许操作 | 插件声明，插件加载器校验 |
| UI 提议 | 工具返回的组件 ID 和初始数据 | 插件工具返回；尚不代表可执行权限 |
| UI 实例 | 某次已结束工具调用产生的具体界面与业务状态 | daemon 生成并持久化 |
| 挂载 | 一个窗口中正在运行的一份 iframe、消息通道和上下文 | Desktop；属于临时显示状态 |
| UI 操作 Run | 用户确认后执行一个已声明工具的独立运行 | daemon；走现有会话执行车道 |
| 业务终态 | 该交互已经完成或被取消 | daemon；与 iframe 是否打开无关 |
| 可用性 | 当前插件快照、权限和运行环境能否继续支持该实例 | 后台根据当前事实计算 |

数据的实际路径：

```text
Native Tool 返回文字结果和 UI 提议
  → daemon 根据本次 Run 的工具来源校验定义，生成实例
  → Part 写入 SQLite，已有 SSE 推送 Part 更新
  → Desktop 显示卡片，用户展开后加载隔离 HTML
  → iframe 请求操作，宿主显示确认，用户确认
  → daemon 原子创建 UI 操作 Run，固定本次工具与插件快照
  → 同一会话车道执行校验、授权、Hook、超时、取消和 Tool Host 调用
  → 保存操作工具结果、Run 终态和 UI 实例更新
  → SSE 更新 Desktop，宿主把最新状态送入 iframe
```

## 7. 插件文件与 Manifest

### 7.1 插件目录

```text
examples/plugins/text-inspector/
  .vykor-plugin/plugin.json
  tools/index.mjs
  ui/manifest.json
  ui/findings.html
  README.md
```

在原生 manifest 中增加现有字段的声明：

```json
{
  "schemaVersion": 1,
  "id": "example.text-inspector",
  "name": "text-inspector",
  "version": "1.1.0",
  "components": {
    "tools": ["./tools/index.mjs"],
    "ui": ["./ui/manifest.json"]
  },
  "runtime": { "engine": "node", "isolation": "process" }
}
```

该片段展示 UI 接入方式；实际样例继续保留原有 Skills 和 Agents。

### 7.2 UI 定义文件

```json
{
  "schemaVersion": 1,
  "components": [
    {
      "id": "findings",
      "title": "文本检查结果",
      "entry": "./ui/findings.html",
      "surfaces": ["tool-result", "session-sidebar"],
      "actions": [
        {
          "id": "explain",
          "label": "解释选中的问题",
          "tool": "TextInspectorExplain",
          "completion": "keep-open"
        }
      ]
    }
  ]
}
```

规则：

- UI 文件的字段严格校验，未知字段报错；版本只接受 `1`。
- 每个 UI 定义文件至少包含一个组件；纯展示组件用空 actions 数组表达，不使用空定义文件。
- UI manifest 与 HTML 的路径都相对于插件根目录，不相对于 UI manifest 文件。
- 路径必须以 `./` 开头，经 realpath 校验仍位于插件根内；不允许符号链接、URL、目录或非普通文件。
- 一个插件中组件 ID 唯一；动作 ID 在所属组件内唯一。ID 匹配 `^[a-z][a-z0-9-]{0,63}$`。
- `title` 和 `label` 是纯文本，长度为 1–80 个 Unicode 字符。
- `surfaces` 是无重复的非空数组，只接受 `tool-result` 和 `session-sidebar`。
- `completion` 只接受 `keep-open` 或 `resolve`，必须显式声明。
- 允许纯展示组件，`actions` 必须存在，但可以为空数组。
- UI 加载阶段只读取 JSON、文件信息与摘要，不执行 HTML、JavaScript 或 Node Tool。
- 动作中的 `tool` 是精确注册名。静态加载不启动 Tool Host；实际激活后检查该工具的来源，只有同一插件的 Native Tool 可以成为动作。
- 不在 UI manifest 复制工具 inputSchema。以本次捕获的 Tool 定义为唯一参数检查来源。
- 未注册、属于其他插件、属于 builtin 或 MCP 的工具使该组件不可交互，并产生诊断；其文字结果仍可显示。

## 8. 工具结果与可信实例

### 8.1 插件可返回的 UI 提议

沿用 `ToolResult.metadata`，新增有文档约定的 `ui` 命名空间：

```ts
type PluginUiProposal = {
  schemaVersion: 1;
  componentId: string;
  data: Record<string, JsonValue>;
};

type JsonValue = null | boolean | number | string | JsonValue[]
  | { [key: string]: JsonValue };
```

```json
{
  "content": [{ "type": "text", "text": "发现 2 个文本问题，可展开卡片查看。" }],
  "metadata": {
    "ui": {
      "schemaVersion": 1,
      "componentId": "findings",
      "data": {
        "findings": [
          { "id": "line-1-space", "line": 1, "rule": "trailing-whitespace" },
          { "id": "line-2-tab", "line": 2, "rule": "tab-indentation" }
        ]
      }
    }
  }
}
```

首版每个工具结果最多产生一个 UI 实例。`content` 必须包含非空文字结果，让没有 UI 的客户端和模型仍能理解结果。HTML、前端脚本、UI 数据和操作许可不拼进模型消息。

### 8.2 宿主生成的记录

共享协议拟定义以下类型：

```ts
type PluginUiInstanceRecord = {
  schemaVersion: 1;
  instanceId: string;
  sessionId: string;
  sourceRunId: string;
  sourcePartId: string;
  sourceToolUseId: string;
  sourceToolName: string;
  pluginId: string;
  pluginVersion: string;
  pluginDigest: string;
  componentId: string;
  componentDigest: string;
  title: string;
  surfaces: Array<"tool-result" | "session-sidebar">;
  status: "open" | "resolved" | "dismissed";
  revision: number;
  data: Record<string, JsonValue>;
  activeActionRunId?: string;
  lastActionRunId?: string;
  dismissal?: {
    requestId: string;
    requestFingerprint: string;
    expectedRevision: number;
    revision: number;
    dismissedAt: number;
  };
  createdAt: number;
  updatedAt: number;
};
```

`instanceId` 由后台生成 UUID。来源、版本、摘要、状态、revision 和时间全部由宿主填写。客户端和插件不能覆盖这些字段。

pluginDigest 使用现有安装行为摘要算法。componentDigest 对规范化组件定义的 UTF-8 JSON、一个 NUL 分隔字节以及 HTML 原始字节依次求 SHA-256；规范化 JSON 的规则与请求指纹一致。摘要包含动作、位置和标题，不能只检查 HTML 内容。

实例写在原工具 Part 的 `metadata.pluginUi` 中。原始 `part.output` 保持初次工具结果，不随后续 UI 操作改写。UI 操作的工具结果写在该操作自己的 Run 和 Part 中。

原始 `metadata.ui` 仅是插件数据。实例创建后，客户端以宿主 `metadata.pluginUi` 为准，不根据原始提议自行加载代码。

### 8.3 创建与更新规则

- 根据源 Run 的捕获工具来源查插件；不信任提议中的插件身份，不按工具名字猜归属。
- 校验组件存在、源快照相符、数据有效、授权满足，然后在写入工具结果 Part 的同一事务内创建实例。
- 初次 revision 为 `1`。实例同一业务变更只递增一次，并通过已有 Part 更新事件发布。
- 工具成功且执行状态明确时才创建可交互实例。失败或执行状态不确定时只保留文字结果与诊断。
- UI 提议损坏时不把已成功的业务工具改判为失败；忽略 UI 提议，保留工具结果，并记录 `plugin_ui_invalid_result`。
- UI 动作工具可以再次返回同一 `componentId` 的 `metadata.ui` 来更新当前实例数据。它不能修改身份，不能从一次动作创建第二个实例。
- `completion: resolve` 的动作只有在工具成功且 `executionState: completed` 后才将实例变为 `resolved`。
- `keep-open` 动作成功后保留 `open`；失败保留原业务数据，展示该操作的错误。
- 动作返回无 UI 提议时保留原数据，只更新动作记录。返回错误组件 ID 或无效数据时保留原数据，显示更新失败诊断，不隐瞒已经发生的工具副作用。
- `resolve` 成功与有效数据更新同事务提交；即使数据更新被拒绝，明确成功的最终业务操作也应进入 resolved 并显示最后有效数据及诊断，避免再次执行。

## 9. 授权、工具来源与元数据保护

Native manifest 格式不新增权限字段。只要 `components.ui` 非空，`requestedPluginPermissions()` 自动加入两项 UI 能力授权：

| 授权标识 | 安装页说明 | 实际含义 |
| --- | --- | --- |
| `ui:render` | 显示插件的隔离交互界面 | 可以运行该安装快照中声明的前端 HTML |
| `ui:invoke-own-tools` | 请求调用插件自身工具，执行前仍需确认 | 可以请求组件动作中声明的同插件 Native Tool |

两项均从 manifest 的 UI 声明推导，不读取或运行前端代码。纯展示组件也使用同一授权集合，但因为动作白名单为空，无法请求工具调用。首版不维护更多 UI 授权组合。

旧安装记录若含有此前不支持的 UI 声明而未批准这些能力，升级后不能自动执行其前端。安装后校验必须报告权限缺失，用户通过现有重新导入 / 授权流程恢复；保留现有整体权限缺失处理，不为 UI 写绕过分支。

安装级 UI 授权不替代工具级权限。每次 UI 工具操作仍检查参数、工具来源、当前禁止规则、运行环境、已有 Permission 和 Hook。宿主操作确认是用户意图确认，也不替代工具执行权限。

新增 `pluginUi`、`uiAction` 为宿主保留 metadata 名称。`externalToolMetadata()` 过滤插件伪造的同名字段；可信字段仅在 Application 保存事实时生成。

普通 Prompt 准入及客户端提供的 runMetadata 同样拒绝这两个保留名称，不能通过普通输入伪造 UI Run。服务端验证记录来源与字段形状，不仅按 `metadata.uiAction` 是否存在切换执行模式。

`ui` 数据不得设置宿主 `compactSummary`、权限状态、工具执行状态或高优先级模型指令。插件界面不能修改、覆盖或批准宿主权限提示。

## 10. UI 操作 Run 与一次执行保证

### 10.1 请求类型

```ts
type InvokePluginUiActionInput = {
  requestId: string;
  expectedRevision: number;
  actionId: string;
  args: Record<string, JsonValue>;
};

type PluginUiActionReceipt = {
  requestId: string;
  runId: string;
  instanceId: string;
  revision: number;
  status: "pending" | "running" | "completed" | "failed" | "interrupted";
};
```

sessionId 和 instanceId 来自请求路由。客户端不能指定 pluginId、插件版本、toolName、cwd、Run ID、Permission 决定或任意执行环境。

`requestId` 为一次用户确认生成的 UUID；网络重试沿用同一个 ID。重复点击在确认或执行期间禁用，不为同一操作连续生成不同请求。

### 10.2 保存方式

复用 `SessionRunRecord`，不建立单独 UI 操作表。该 Run 没有 inputId，metadata 中有宿主生成的 `uiAction`：

```ts
type PluginUiActionRunMetadata = {
  schemaVersion: 1;
  instanceId: string;
  requestId: string;
  requestFingerprint: string;
  expectedRevision: number;
  actionId: string;
  label: string;
  args: Record<string, JsonValue>;
  pluginId: string;
  pluginVersion: string;
  pluginDigest: string;
  componentDigest: string;
  toolName: string;
  toolUseId: string;
  executionState: "not_started" | "completed" | "unknown";
};
```

Run ID 由后台确定：`ui_run_` 加 SHA-256，对 `[sessionId, instanceId, requestId]` 的 JSON 数组求摘要。这样可以直接按 ID 查询重复请求，不增加全库扫描或新的索引。

`requestFingerprint` 对规范化 JSON 对象 `{ actionId, args, expectedRevision }` 求 SHA-256；对象键递归按序排列，数组顺序保持，拒绝非有限数字。不能仅比较工具名或忽略参数。

已完成工具事实由独立工具 Part 保存；Run metadata 的 executionState 与该 Part 同步结算。Run 和 Part 终态同事务提交，并遵守现有终态不可重新进入 running 的约定。

### 10.3 准入顺序

在现有 `SessionOperationRunner` 的会话串行入口中执行：

1. 检查 daemon 认证、Session 与实例归属；归档和 closing 会话不能执行新动作。
2. 计算 Run ID，先检查是否已有相同请求。指纹相同返回已有回执；不同则返回 `plugin_ui_request_conflict`。终态回执查询不要求旧版本仍可执行。
3. 对全新请求检查实例为 open、expectedRevision 等于当前值、插件启用、授权有效、快照和组件摘要精确匹配。
4. 检查同一会话没有活动或排队工作，实例没有 activeActionRunId。首版忙时返回冲突，不自动排队，也不打断模型 Run。
5. 根据 actionId 查当前组件动作定义，准备精确同插件工具能力视图；工具不可用则返回错误，不创建悬空 Run。
6. 在一个事务中创建 pending Run，设置 activeActionRunId，递增实例 revision，保存 Part 更新。数据提交成功后才允许开始工具执行。
7. 交给现有 `SessionRunCoordinator.enqueue({ sessionId, runId, work })`；该工作运行一个工具，不请求模型。

如果保存成功而入队失败，立即将 Run 收束为 failed / not_started，清理 activeActionRunId，并发布状态；不能只在内存里丢弃该请求。

### 10.4 复用工具检查与执行

当前 QueryEngine 的工具流程没有现成的独立公开入口。实施必须从 `query-engine.ts` 提取职责收窄的共享受检执行函数，使模型工具调用和 UI 操作共同使用：

- 工具存在、可见性与注册来源检查。
- 完整参数校验；UI 操作只接受明确参数，不能使用模型历史中的参数复用引用。
- Permission、禁止规则、执行环境和 pre/post Tool Hook。
- 超时、AbortSignal、工具运行事件、错误分类与执行状态。
- 当前捕获定义的调用函数、Native Tool Guard、Tool Host 并发限制和审计。

UI 不能绕过检查直接调用 ToolRegistry、Tool Host 或 `tool.execute()`。提取必须保留已有模型调用中的批次取消与同组执行顺序，不把 UI 的单工具限制施加给模型批次。

UI 操作只使用声明的同插件 Native Tool。重新构造的能力视图除必要的宿主控制接口外不开放其他工具；执行开始后也不能因重载而重定向到另一个版本。

### 10.5 取消、失败和恢复

- 操作进行中，宿主显示取消按钮；复用 Run 取消入口，不把 iframe 关闭当成工具取消。
- Run 进入 running 不等于工具已经开始。通过参数与权限检查后，在调用工具前先持久记录该工具的运行事实，并把 executionState 保守设为 unknown；若此前取消或失败，则仍为 not_started。
- 未开始的取消、权限拒绝或参数错误记为 not_started。
- 工具明确返回且结束时使用 completed；失败不等于未执行。
- 执行中取消、超时、进程崩溃或提交结果前 daemon 退出，无法证明副作用状态时使用 unknown，Run 收束为 interrupted 或 failed。
- unknown 禁止自动重放。界面提示“结果尚未确认，先检查实际状态”；新调用仍需用户确认与工具策略检查。
- 首版 unknown 会使原实例保持 open 但只能查看，不能继续请求工具动作。用户核对实际状态后重新调用初始查询工具，生成新实例再操作；不增加“确认成功”或“解锁未知结果”的客户端自报接口。旧实例仍可由用户明确取消交互，这不会撤销原操作。
- 同一 requestId 永不重新执行；安全工具的再次尝试也必须是新的用户确认和新 requestId。
- 重启发现无活跃 owner 的 pending / running UI Run：如果没有工具开始的持久事实，则 interrupted / not_started；已有工具开始事实而无最终工具事实，则 interrupted / unknown。不能只看 Run.status 判断副作用；先结算旧操作，再开放实例操作。
- 工具结束后的投影或事务提交失败不能提前返回成功。复用现有投影失败收束规则，保留失败证据；重启无法恢复明确结果时按 unknown 处理，不再次执行工具来补写结果。
- 不能沿用普通 Prompt replay 去恢复没有 inputId 的 UI Run。恢复、导出和 resume 路径必须识别 uiAction，返回明确状态；普通“继续运行”按钮不重放其副作用。

## 11. 模型与 UI 的交互语义

首版采用“先完成工具，再由用户发起独立操作”。初始工具不会等待 iframe 打开；初始模型 Run 可以在卡片仍为 open 时正常结束。

UI 操作不创建模型请求、不生成虚假模型 Attempt，也不自动唤醒 Goal 续跑。Transcript 显示宿主标记的“用户在插件中执行操作”和真实工具活动，不能把按钮点击伪装成模型决定。

不能在活动 QueryEngine 的消息列表中强插入没有对应调用的 tool_result，也不能假冒 system 指令。UI 操作的详细调用保留在 durable transcript，后续模型需要结果时，由 Application 在下一条正常输入的上下文材料中补充受限文字摘要。

每条正常输入最多带入最近一次模型 Run 后的 8 条已结束 UI 操作，总计不超过 8,000 个 Unicode 字符。摘要包含插件名、动作标签、Run ID、明确执行状态和文字结果；标记为外部工具数据，不提升为指令。失败和 unknown 不能被摘要成成功。这个材料从持久记录重新生成，不依赖 iframe 存活。

宿主可提供“让助手继续”按钮，将固定的结果说明放入输入框草稿。用户仍需发送；iframe 无直接 submitPrompt 能力。关闭 UI、动作 resolve 和动作完成事件均不能自动创建模型 Run。

## 12. 状态机、保存和多端同步

### 12.1 业务状态

```text
open ── resolve 动作明确成功 ──→ resolved
open ── 用户确认取消交互 ─────→ dismissed
```

resolved 和 dismissed 是业务终态，不可回到 open。界面仍可显示已有数据，但动作只读。重新做任务需要重新调用初始工具，产生新实例。

activeActionRunId 只表示有一项执行中的操作，不是新的业务状态。最后一次 Run 的状态决定成功、失败或结果不确定。

### 12.2 业务状态与可用性分离

可用性由当前插件和 Session 事实计算，不写成永久业务终态：

返回值为 `{ code, canRender, canInvoke }`。canInvoke 为 true 必须同时满足 canRender、实例 open、会话可变、Runtime 准备成功和没有未知结果保护。plugin-disabled、permission-missing、snapshot-missing、snapshot-changed、invalid-definition 的 canRender / canInvoke 都为 false。Session 归档或 Tool Host 暂不可用但快照仍有效时，可以 canRender=true、canInvoke=false，以只读方式查看既有数据。

后台读取设置、安装记录、文档与准备 Runtime 的整段流程使用现有 operation gate（运行与维护互斥入口）。reload、卸载或全局维护持有维护入口时，UI 读取不能重新创建 Runtime；daemon 尚未就绪或已开始关闭时也不准备 Runtime，不返回可显示的 HTML。已进入的读取在关闭时排空并清理，Host 真正启动失败的精确快照只读回退仅适用于 daemon 正常运行期间。关闭流程先封住新入口、取消并等待活动 Run 结算，再等待既有读取与执行租约释放；动作执行租约仍覆盖权限等待、工具调用和原子结算。

实例查找只在请求所属会话的 Parts 内进行，不扫描其他会话。缺少组件、工具归属或 UI 运行端造成的诊断只限制 UI 能力，不作为所有业务工具的准备失败；整体插件权限缺失仍遵守既有安装校验规则。

| 可用性 | 行为 |
| --- | --- |
| available | 可以显示；open 实例可以请求动作 |
| plugin-disabled / permission-missing | 卸载 iframe；保留文字结果和原因 |
| snapshot-missing / snapshot-changed | 保留摘要；不运行其他版本来替代旧界面 |
| runtime-unavailable / session-archived | 展示持久结果；不可执行动作 |
| action-unknown | 显示最后数据和未知结果说明；不再请求工具动作 |
| invalid-definition | 保留文字结果和组件诊断 |

禁用后再启用同一个精确快照、重新批准授权并准备成功，可以重新显示仍为 open 的实例。更换版本后，历史实例不自动迁移到新组件；不自动下载旧版本，也不为了显示历史而执行未启用的旧代码。

### 12.3 保存位置与内容

- UI 定义和 HTML：已安装插件快照，受现有安装摘要校验约束。
- 业务数据和实例状态：源 Part 的 `metadata.pluginUi`。
- 动作参数、执行状态与结果：UI Run metadata 和该 Run 的工具 Part。
- 当前挂载、MessagePort、文档 URL、pending Promise：只在 Desktop 内存中。
- 未提交表单内容、排序、滚动位置：插件前端临时状态，首版不承诺跨关闭保存。
- 不提供通用 `state.set()`、任意文件写入或浏览器 localStorage 持久接口。

已有 SQLite 事务、Part/Run 事件、Snapshot 与 SSE 是唯一业务事实来源，不新增独立 UI 数据库、周期轮询或专用 WebSocket。

SSE 按既有 cursor 去重。实例 revision 防止同一 Part 的迟到显示更新；mountId 防止旧 iframe 事件进入新挂载。快照替换时清理已不存在的挂载，不重复 append 历史实例。

两个窗口可以显示同一实例。第一个有效动作准入递增 revision，第二个旧 revision 请求被拒绝；终态通过 SSE 同步到全部窗口。

### 12.4 取消交互和关闭显示

“关闭侧栏”只销毁前端挂载，实例仍为 open，操作 Run 继续执行。

“取消交互”使用带 requestId 与 expectedRevision 的 dismiss 请求，将实例变为 dismissed。已有 activeActionRunId 时返回 busy，用户须先取消操作并等待结算。

dismiss 不调用插件工具，不启动模型，也不撤销已经发生的副作用。重复相同 dismiss 请求返回已有结果；复用相同 requestId 但参数不同返回冲突。成功请求保存在实例的 dismissal 中，指纹对规范化 `{ expectedRevision }` 求 SHA-256，revision 是取消完成时的版本；实例其他身份字段和原数据保持不变。

Session 删除按已有删除事务清理实例和 UI Run。普通插件卸载保留会话事实，不保留可执行 iframe；会话保留/清理规则继续由现有 retention 管理。

导出保留原始工具结果及已提交 UI 事实，继续受会话导出认证与内容保护约束。导入外部 transcript、复制会话和 fork 时，不能把原实例 ID 或源 Run 归属直接用于新会话；首版移除复制 Part 中的 pluginUi，保留文字和原工具结果，不执行外部记录中的 UI 提议。用户重新运行初始工具后获得新实例。

rewind / 替换 transcript 删除源 Part 时，相关挂载立即失效；保留规则允许存在的历史 UI Run 不再授权任何动作。进行中的操作必须先按既有会话控制流程停止并结算，不能删除源记录后继续执行。导入、fork 和 replay 不调用 UI 工具来“恢复界面”。

## 13. 后台 HTTP 与共享 Client 接口

首版新增可选能力 `features.pluginUi = 1`。保持当前基础协议形状，使用现有 Part/Run metadata 和事件，因而该功能自身不要求提升基础协议版本。实现时若实际改变必填 Snapshot 字段或既有请求形状，必须按协议契约提升版本，不能用 feature 掩盖破坏性改动。

所有路由通过现有 daemon 认证和 Origin 检查，输入由 `@vykor/protocol` 的 decoder 严格读取。

| 方法与路径 | 输入 | 返回 | 说明 |
| --- | --- | --- | --- |
| `GET /sessions/:sessionId/plugin-ui/:instanceId` | 路由 ID | `{ instance, availability, actions }` | actions 来自当前有效定义；不返回包内绝对路径或秘密 |
| `GET /sessions/:sessionId/plugin-ui/:instanceId/document` | 路由 ID | `{ html, sha256 }` | 仅可信宿主读取；检查安装摘要、权限、组件和会话归属 |
| `POST /sessions/:sessionId/plugin-ui/:instanceId/actions` | InvokePluginUiActionInput | `202 { receipt }`；重复终态请求为 `200 { receipt }` | 保存后返回，不等待长工具调用 |
| `GET /sessions/:sessionId/plugin-ui/:instanceId/actions/:requestId` | 路由 ID | `{ receipt, result? }` | 按确定 Run ID 查询，结果从持久 Part 读取 |
| `POST /sessions/:sessionId/plugin-ui/:instanceId/dismiss` | `{ requestId, expectedRevision }` | `{ instance }` | 业务取消，事务内执行 |

`actions` 的安全描述只包括 id、label、toolName、inputSchema 和 completion。敏感参数不会预先填充进定义响应。

共享 Client 增加 `client.pluginUi.get()`、`getDocument()`、`invokeAction()`、`getAction()`、`dismiss()`；取消 UI Run 使用已有 Run/Session 控制接口。支持 AbortSignal，但 HTTP 请求取消不等于撤销已经准入的操作。

文档响应只返回完整单文件 HTML 与摘要，不提供任意路径 assets 路由。错误不泄露插件 cache root、源码绝对路径、Bearer token 或 Tool Host 环境变量。

## 14. 前端 SDK 与消息接口

### 14.1 SDK 入口

在现有插件包增加浏览器安全子路径 `@vykor/plugins/ui-sdk`。它只依赖浏览器 API 和共享协议的类型，不运行 Node 模块，不创建新的 npm 包，也不要求作者使用特定前端框架。

拟提供：

```ts
interface PluginUiClient {
  getSnapshot(): Promise<PluginUiViewSnapshot>;
  onSnapshot(listener: (value: PluginUiViewSnapshot) => void): () => void;
  requestAction(actionId: string, args: Record<string, JsonValue>): Promise<PluginUiActionReceipt>;
  openSidebar(): Promise<void>;
  resize(height: number): Promise<void>;
  dismiss(): Promise<void>;
  dispose(): void;
}

type PluginUiViewSnapshot = {
  instanceId: string;
  revision: number;
  status: "open" | "resolved" | "dismissed";
  data: Record<string, JsonValue>;
  actions: Array<{ id: string; label: string; completion: "keep-open" | "resolve" }>;
  readOnly: boolean;
  activeAction?: PluginUiActionReceipt;
  lastAction?: {
    receipt: PluginUiActionReceipt;
    executionState: "not_started" | "completed" | "unknown";
    message: string;
  };
  theme: "light" | "dark";
  locale: string;
  surface: "tool-result" | "session-sidebar";
};
```

`createPluginUiClient()` 等待宿主初始化后返回以上接口。requestAction 在宿主操作确认后提交请求，Promise 在取得持久准入回执时结束；最终状态通过 onSnapshot 通知，不长时间占用消息请求。

lastAction.message 是从持久工具结果生成、最多 1,024 个 Unicode 字符的普通文字摘要；不传入完整工具结果、HTML 或其他实例。失败和结果不确定必须包含对应状态说明，不能仅靠 receipt.status 让插件猜测副作用。完整操作详情由宿主 transcript 展示。

首版不向 iframe 提供完整 Session ID、会话列表、prompt、完整 Tool 输入、其他实例数据或工具能力表。后端请求所需的 sessionId 由宿主挂载记录持有。

### 14.2 挂载握手

1. 宿主创建 iframe、不可预测 mountId 和挂载记录。
2. SDK 向父窗口发送只含协议版本的 ready 消息。
3. 宿主只接受 `event.source === iframe.contentWindow` 的 ready，并检查尚未初始化、挂载仍有效。
4. 宿主创建 MessageChannel，通过 postMessage 转移一个端口，附带 mountId；隔离 iframe 的 origin 为 opaque，不能把字符串 `"null"` 当成身份认证。
5. 首次端口消息携带快照，后续只在该专用端口通信。不得继续用无来源约束的全局 message 监听执行操作。

端口转移可使用 `targetOrigin: "*"`，但仅限已核验 contentWindow 的一次初始化，且不携带凭据。其他消息均通过专用端口发送。

### 14.3 消息格式与方法

请求固定为 `{ version: 1, mountId, id, method, params }`，响应为 `{ version: 1, mountId, id, result }` 或同形状的 error。id 是每次挂载内唯一、最长 80 字符的字符串。

只开放 `getSnapshot`、`requestAction`、`openSidebar`、`resize`、`dismiss`。宿主推送 `snapshot` 和 `dispose`。未知方法返回 `plugin_ui_method_not_supported`；不接受任意 JSON-RPC 透传。

每个请求严格校验字段、大小、挂载身份、组件允许的位置和当前只读状态。来源和工具白名单最终仍由后台校验。快照只是显示信息，不是授权凭证。

readOnly 禁止 requestAction，不禁止 getSnapshot、resize 或打开允许的侧栏。dismiss 另外检查业务仍为 open、会话可变且没有活动操作；resolved / dismissed / archived 实例不能取消交互。

requestAction 只产生宿主确认请求。确认界面在 iframe 外，由宿主填写插件身份、动作标签、真实工具名和经过转义的参数。未确认、取消或挂载已失效时不调用后台动作 API。

取消交互同样由宿主呈现确认，插件不能在加载时直接使业务实例终结。resize 和 openSidebar 只影响显示，不改变业务状态。

iframe 不能携带某个 `approved: true` 来跳过确认。每次挂载最多存在一个待确认请求；宿主拒绝确认期间的其他操作请求，避免弹窗堆积。

## 15. Desktop 隔离文档与安全要求

### 15.1 独立文档来源

使用专用 Electron 文档协议 `vykor-plugin-ui://frame/<mountId>`，由 main 中的 UI 文档服务响应内存中的已验证 HTML。它不是文件协议，也不把 mountId 解释为文件路径。

main 通过共享 Client 获取 document，校验尺寸和摘要，再登记短期挂载文档。挂载绑定拥有窗口的 WebContents ID、当前 daemon 连接身份、实例和精确摘要；协议入口只允许该窗口发起的已登记 frame 加载，不为其他窗口或顶层导航提供文档。renderer 只得到文档 URL 和对应挂载记录；Bearer token 留在既有可信 Client/main 链路中。

专用协议必须在 Electron 启动前注册，使用独立 origin，不启用绕过 CSP、Node、通用文件读取或任意网络代理的特权。协议处理器只响应已登记挂载的 GET，其他方法拒绝；未登记或已撤销挂载返回 404。卸载、窗口销毁和 daemon 切换时删除 HTML 缓存。

主页面 CSP 仅增加该协议的 frame-src，不放宽主页面 `script-src 'self'`，不增加主页面 unsafe-eval / unsafe-inline。不能使用继承主页面 CSP 的 srcdoc / blob 文档再以放宽整个 renderer 策略来运行插件脚本。

### 15.2 iframe 与文档策略

iframe 仅使用 `sandbox="allow-scripts"`，不增加 allow-same-origin、allow-top-navigation、allow-popups、allow-forms、allow-downloads 或 allow-modals。父级设置 Permissions Policy，禁用 camera、microphone、geolocation、clipboard-read、clipboard-write 和 fullscreen。

专用文档响应设置 CSP：

```text
default-src 'none';
script-src 'unsafe-inline';
style-src 'unsafe-inline';
img-src data:;
connect-src 'none';
font-src 'none';
media-src 'none';
frame-src 'none';
worker-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none'
```

允许内联脚本仅发生在隔离文档内，作用是运行插件主动交付的脚本，不代表这些脚本可信。插件必须预构建，不支持 CDN、运行时 import、eval、外部字体、网络 fetch 或嵌套 iframe。

任何插件 frame 的导航都必须由 Electron 子框架导航策略阻止，只有宿主初次加载精确登记文档 URL 可以通过；同文档片段变化允许。CSP 的 connect-src 不能阻止所有导航外传，故导航检查不可省略。弹窗、外部打开、下载和另起 WebContents 也由 main 拒绝。

未登记 scheme 请求、file/http/https/data/javascript 导航、带查询参数的文档 URL、导航到其他 mountId，以及加载后再次跨文档跳转均拒绝。URL 不携带 UI 数据、daemon token 或可复用后端授权。

### 15.3 不向插件开放的东西

- Electron bridge、IPC channel 名称、preload 对象、主页面 DOM、宿主 React context。
- daemon token、Provider key、环境变量、认证 Cookie、权限批准凭据。
- 任意文件读取、目录浏览、shell、工具代理 URL、任意 HTTP 请求。
- 其他 Session、其他插件工具、原始消息历史和完整工具输入。

通过 iframe 沙箱隔离父页面，通过后台白名单约束工具能力，通过既有工具权限约束文件/进程操作；三者不能互相替代。

浏览器 sandbox 不提供严格 CPU / 内存配额。超时、限制挂载数量和禁用功能可减轻故障，但不能宣称能完全抵抗恶意死循环或浏览器漏洞。生产接入必须实际验证 Electron 的 frame、导航和 preload 隔离行为，不能仅靠组件单测证明。

## 16. 界面行为与可访问性

### 16.1 工具结果卡片

- 卡片外壳始终显示插件名、组件标题和原始文字摘要；这些内容按普通文本转义。
- 历史卡片默认折叠，不自动运行历史前端代码。用户展开或选择侧栏后才加载 HTML。
- 含 UI 的工具结果不并入普通工具活动折叠组，否则用户无法发现交互入口。
- UI 加载失败时保留文字结果，提供“重新加载界面”和“查看插件状态”；重新加载不会重新执行工具。
- 工具结果本身出错时保留原工具错误展示，不用 UI 卡片遮盖。
- 显示可交互、操作中、已完成、已取消、不可用、结果不确定的宿主状态文案。

### 16.2 会话侧栏

- 从卡片打开指定实例，不从全局插件列表任意创建无数据页面。
- 每个窗口最多打开一个插件侧栏；侧栏跟随当前会话。
- 同一窗口、同一实例只保留一个运行中的 iframe。从卡片移到侧栏时销毁旧 frame，卡片外壳保留“已在侧栏打开”。
- 切换会话或关闭侧栏只销毁挂载，不取消操作；重新打开从后台快照恢复已提交数据。
- 不移动其他内置文件预览、终端和审查面板的业务状态；复用已有面板容器，插件面板有明确类型和关闭行为。

### 16.3 操作与键盘

- 插件请求动作后，宿主确认区域能用键盘完整访问，显示真实参数，提供确认与取消。
- 模型或 UI 操作 Run 进行中显示“会话正在执行，结束后可操作”；首版不提供隐式排队。
- resolved / dismissed / archived 和不可用实例禁止提交；前端禁用只是显示，后台仍强制检查。
- iframe 有可读 title；宿主按钮、确认区域和错误提示有无障碍名称，状态变化通过 aria-live 提示。
- iframe 不自动抢焦点；用户主动展开可将焦点送入内容，关闭后恢复到打开它的按钮。
- 侧栏宽度不足时使用宿主现有窄屏面板行为，不要求插件改变主页面布局。
- 插件前端应提供键盘操作和至少 WCAG AA 的文本对比度；参考插件必须满足这两项。
- 提交前的临时表单内容未保存，作者指南和参考插件明确这一点。

## 17. 限额与超时

以下是首版固定上限，放在共享协议常量与加载器中；不增加用户设置面板。

| 项目 | 上限 / 行为 |
| --- | --- |
| 单插件 UI manifest 数 | 8 |
| 单个 UI manifest JSON | UTF-8 256 KiB，解析前通过有界读取检查 |
| 单插件组件总数 | 16 |
| 单组件动作数 | 16 |
| 单个预构建 HTML | UTF-8 2 MiB |
| 单个实例业务 data | JSON UTF-8 256 KiB |
| 单次动作 args | JSON UTF-8 64 KiB |
| JSON 最大嵌套深度 | 20 |
| iframe → 宿主单条请求 | JSON UTF-8 64 KiB |
| 宿主 → iframe 快照消息 | JSON UTF-8 512 KiB，包含数据及有限描述字段 |
| 待响应的消息请求 | 每挂载 16；待用户确认至多 1 |
| 消息请求速率 | 每挂载滚动 60 秒内 60 次，超限返回 plugin_ui_rate_limited |
| iframe 初始化 | 10 秒；超时卸载并保留摘要 |
| 普通桥接请求 | 不需要用户确认的方法为 30 秒 |
| 用户确认等待 | 5 分钟；超时关闭确认并不提交动作 |
| requestAction 获取准入回执 | 用户确认后 30 秒；超时按原 requestId 查询，不新建动作 |
| 需要用户确认的桥接请求 | 最多 5 分钟确认 + 30 秒提交；取消确认立即返回，工具执行不计入桥接等待 |
| 同窗口存活的插件 iframe | 至多 2；展开新卡片前销毁最早非侧栏挂载，保留其外壳 |
| 卡片高度 | 160–640 CSS px；非法数值拒绝，不扩大到宿主外 |
| Tool 执行超时、并发和取消宽限 | 沿用已有 Runtime / Tool Host 配置，UI 不覆盖 |

超限拒绝整个 UI 提议或动作参数，不截断数组、JSON 或 ID 后继续执行。总大小校验应在 JSON 解析及 IPC 接收边界有对应保护，不能只在 React 渲染后检查。

动作执行后返回的超大 UI 数据忽略，保留旧数据和工具结果事实。插件持久数据必须符合既有工具输出上限；不能借 UI metadata 绕过 Tool Host 的输出预算。

## 18. 错误码与诊断

统一使用现有 ProtocolError，message 用普通用户可读语言，客户端按 code 分支。首版定义：

| code | 含义 | 用户或作者的下一步 |
| --- | --- | --- |
| `plugin_ui_invalid_definition` | 定义字段、ID、入口或工具归属错误 | 查看插件详情，修正后重新导入 |
| `plugin_ui_invalid_result` | 工具提供的 UI 提议无效 | 查看文字结果和组件诊断 |
| `plugin_ui_not_found` | 实例不存在或不属于此会话 | 刷新会话；不展示其他会话信息 |
| `plugin_ui_permission_missing` | UI 授权未批准 | 按现有流程重新导入并批准 |
| `plugin_ui_unavailable` | 插件禁用、运行环境不支持或 Host 不可用 | 查看具体 availability 和插件状态 |
| `plugin_ui_snapshot_changed` | 精确快照或组件摘要已改变 | 重新运行初始业务工具生成新实例 |
| `plugin_ui_closed` | 业务实例已进入终态 | 查看结果或重新发起任务 |
| `plugin_ui_revision_conflict` | 操作基于旧状态 | 读取最新状态后让用户重新确认 |
| `plugin_ui_request_conflict` | 相同 requestId 带不同内容 | 修正调用，不复用该 ID |
| `plugin_ui_session_busy` | 会话仍有活动或排队工作 | 等待现有工作结束 |
| `plugin_ui_action_not_allowed` | 动作未声明或目标工具不属于此插件 | 修正组件定义 |
| `plugin_ui_payload_too_large` | 文档、参数、数据或消息超限 | 缩小内容，不能截断后执行 |
| `plugin_ui_mount_expired` | 消息来自已销毁挂载 | 重新打开界面 |
| `plugin_ui_method_not_supported` | 非首版消息方法 | 使用公开 SDK 接口 |
| `plugin_ui_rate_limited` | 消息过于频繁 | 停止循环调用，等待窗口恢复 |
| `plugin_ui_load_timeout` | 前端未完成握手 | 重载界面或禁用有问题插件 |
| `plugin_ui_user_cancelled` | 用户取消了宿主确认 | 保留界面和数据，不执行工具 |
| `plugin_ui_action_unknown` | 无法证明工具最终副作用 | 查看实际状态，禁止自动重放 |

格式错误为 400，权限拒绝为 403，不存在为 404，状态/请求冲突为 409，大小超限为 413，频率超限为 429，运行服务不可用为 503。底层 Tool 失败仍保留现有 failureKind 和 executionState，不强行转换为某个 UI 错误。

插件管理页增加 UI 定义数量、可加载数量和 UI 诊断。安装后元数据有效只证明可加载；不把“用户尚未打开 iframe”报成失败，也不据此宣称某个窗口已经运行 UI。

管理响应增加可选 uiInventory：`{ manifestCount, componentCount, validatedComponentCount }`。manifestCount 是定义文件数；componentCount 在定义无法校验时为 null；validatedComponentCount 是通过静态校验的组件数，不代表已经运行。原 inventory.ui 仍表示声明的定义文件数，不改变旧字段含义。

## 19. 插件生命周期与运行诊断

- 安装：校验 UI manifest、路径、HTML 大小，计算内容摘要，展示 UI 授权；不运行前端代码。
- 激活：读取有效 UI 定义，检查组件动作的 Native Tool 归属；UI 元数据加载和 Tool Host 启动失败分别报告。
- 禁用 / 卸载：先停止新动作准入并撤销挂载，再取消并结算相关 UI Run，最后走已有插件 Runtime 清理链路。
- 重装 / 更新：新快照成功切换后撤销旧挂载；旧实例保留摘要，不能静默改绑到新快照。
- `/reload-plugins`：保留现有“关闭旧 Runtime，下一次准备”的语义；撤销旧挂载与调用绑定，重新准备成功后才开放新操作。
- 开发 link：每次创建实例、读取文档和准入动作都校验行为摘要；源码变更不得继续使用旧实例和旧能力。修改后重新 link / reload 并生成新实例。
- daemon 断线：立即禁用动作；可保留最后已提交数据显示，且标记离线。重连以后台快照替换状态和可用性。
- 切换 daemon：销毁全部挂载、确认请求与文档 URL，不能把同名 Session 或插件视为原连接对象。
- 全局 `plugins.enabled=false` 与当前会话关闭插件能力时，同样阻止文档加载和动作准入；不因为单插件安装记录仍为 enabled 而继续运行。

UI 授权、定义加载、后台 Runtime 可用性和某窗口挂载状态分别记录，不新增一个难以核实的“全局 UI 已运行”状态。

## 20. 源码改动边界

以下路径为实施定位，新增文件不代表当前已经存在。实现可以在同一职责内调整文件名，但不得改变数据与权限归属。

| 范围 | 修改 / 新增位置 | 责任 |
| --- | --- | --- |
| 共享协议 | 新增 `packages/protocol/src/plugin-ui.ts`；修改 `index.ts`、`capabilities.ts` | 公共类型、限额、请求 decoder、安全读取宿主 UI metadata |
| 插件加载 | 新增 `packages/plugins/src/components/ui.ts`；修改 `types.ts`、`load-native-plugin.ts` | 严格定义校验、HTML 路径与摘要、组件结果与诊断 |
| 插件授权 | 修改 `packages/plugins/src/installation/installer.ts`、`verify.ts` 及安装预览调用方 | 推导两项 UI 授权，预览/安装/验证一致 |
| SDK | 新增 `packages/plugins/src/ui-sdk.ts`；修改 package exports | 浏览器消息接口；无 Node 依赖 |
| 工具公共执行 | 新增 `packages/core/src/engine/checked-tool-execution.ts`；修改 `query-engine.ts`、`tool-result-feedback.ts` | 复用受检工具执行和宿主 metadata 保护 |
| Runtime 绑定 | 修改 `packages/agent-runtime/src/native-tools/activate.ts`、`run-capability-view.ts`、扩展装配入口 | 提供来源与精确版本绑定，限制 UI 动作工具集合 |
| Application | 新增 `packages/server/src/application/session/session-plugin-ui-service.ts`、`session-plugin-ui-action-executor.ts` | 实例创建、原子动作准入、Run 执行、恢复和生命周期 |
| Transcript / Context | 修改 `transcript-projection.ts`、`session-input-materializer.ts`、相关 Run 恢复入口 | 持久实例、真实 UI 操作记录、后续模型上下文摘要 |
| HTTP | 新增 `packages/server/src/http/routes/session-plugin-ui.ts`；接入现有 route assembly | 认证路由与协议 decoder，无业务逻辑复制 |
| Client | 新增 `packages/client/src/resources/plugin-ui-resource.ts`；接入公开 exports / client | 所有产品入口共用 HTTP 客户端 |
| Desktop main | 新增 `apps/desktop/src/main/features/plugin-ui/` 中的 service、document-protocol、IPC 模块 | 获取文档、独立协议、导航阻断和窗口生命周期 |
| Desktop shared / preload | 新增 `apps/desktop/src/shared/plugin-ui-types.ts`；接入既有 IPC 与 preload 入口 | 类型化有限方法，不能暴露任意 HTML / URL 加载器 |
| Desktop renderer | 新增 conversation-page 下的 plugin-ui 外壳、frame 和 bridge；修改消息模型与页面面板接入 | 按需挂载、宿主确认、快照显示、焦点与错误处理 |
| 参考插件 | 扩展 `examples/plugins/text-inspector/` | 真正通过公开 SDK 交互的单文件 UI 与无副作用动作 |
| Converter / 作者文档 | Claude Converter 诊断、`docs/native-plugin-authoring.md`、插件交接文档 | 清楚区分 Native UI、传统 Hook、Mods 和 MCP Apps |

数据继续使用现有 Part/Run metadata，不增加业务表，不要求数据库迁移。若实施发现必须增表，需要先修订本规格及恢复、备份、导出和清理契约，不能顺手增加第二套持久状态。

## 21. 首版验收与测试范围

以下编号是完成门槛。测试不能仅通过 mock 的调用次数证明实际权限、进程执行或浏览器隔离。

| 编号 | 验收内容 | 最小证据 |
| --- | --- | --- |
| UI-01 | 两种 manifest 版本与字段严格校验，重复组件/动作 ID 被拒绝 | 插件加载器聚焦测试 |
| UI-02 | 包内路径、符号链接、缺失 HTML、入口越界、超大文件被拒绝 | 临时真实文件夹验证 |
| UI-03 | 安装预览、requested / approved、安装后验证均包含两项 UI 授权 | 真实 PluginService 测试 |
| UI-04 | 安装与元数据加载不执行 HTML、脚本或 Tool 模块 | 带执行标记的夹具验收 |
| UI-05 | 同插件 Native Tool 动作可绑定；其他插件/builtin/MCP 工具被拒绝 | 捕获能力视图与真实注册来源验证 |
| UI-06 | 伪造 pluginUi、身份、权限、revision 或执行状态不能取得可信实例 | Metadata 边界测试 |
| UI-07 | 有效工具结果产生一个持久实例，无效 UI 不改变业务工具成功事实 | Transcript + SessionStore 测试 |
| UI-08 | 初始工具和模型 Run 在 UI 未打开时仍可结束 | 无界面 Runtime 集成测试 |
| UI-09 | 动作按声明工具运行，复用参数、Permission、Hook、超时和取消 | 共享工具执行回归与真实 Tool Host |
| UI-10 | 相同请求跨网络重试和 daemon 重启只执行一次；不同参数复用 ID 被拒绝 | 真数据库重开 + 工具执行计数 |
| UI-11 | 双窗口旧 revision 冲突；会话忙、归档、终态不能执行新动作 | 并发准入与 Session 状态测试 |
| UI-12 | 保存或入队失败不会产生未记录副作用，也不会留下永久 pending | 事务 / 入队故障注入 |
| UI-13 | pending / running 重启恢复分别保守结算，unknown 不自动重放 | 重启恢复与已知副作用夹具 |
| UI-14 | 关闭显示不取消业务；dismiss 与取消 Run 分离并有确定状态 | Application 与 renderer 交互测试 |
| UI-15 | 成功更新、无效更新、resolve、失败、unknown 都保存准确结果 | 持久状态机测试 |
| UI-16 | 后续模型输入获得有限 UI 结果摘要；不自动请求模型或唤醒 Goal | 输入材料与调度测试 |
| UI-17 | 浏览器 SDK 构建不依赖 Node，公开方法与真实样例一致 | SDK 类型检查与前端构建 |
| UI-18 | 专用文档协议只读取登记内存文档，撤销后不可访问 | Desktop main 协议测试 |
| UI-19 | 隔离 frame 无父 DOM / preload / Node，fetch、导航、弹窗、下载、外部资源被阻断 | 真实 Electron 窗口攻击夹具 |
| UI-20 | 主页面 script-src 未放宽；伪造来源、旧 mountId、未知方法不能调用工具 | CSP 检查与真实 MessageChannel 验证 |
| UI-21 | 切换会话、daemon、重装、禁用、卸载和 reload 都撤销旧挂载与调用绑定 | 生命周期集成验证 |
| UI-22 | 原始文字结果、失败详情和历史摘要仍可使用，CLI/TUI 不等待 UI | Client / renderer / 无界面回归 |
| UI-23 | 快照重连、Part 更新合并和迟到消息不重复显示或回退状态 | 现有 SSE / Desktop 订阅聚焦回归 |
| UI-24 | 参考插件卡片和侧栏可用，确认、取消、键盘和焦点恢复正常 | Desktop 人工验收记录 |
| UI-25 | 日志和错误无 token、HTML 正文、完整参数或绝对安装路径 | 日志内容断言 |
| UI-26 | 作者文档、安装诊断、feature 与实际可用能力一致 | 文档检查与功能关闭验收 |

单元与集成验收不调用真实模型、不连接 GitHub。PR 审查业务演示可以另做，但不能代替文本样例和安全夹具。

实施阶段按所改包运行聚焦 Vitest、check-types 和浏览器构建；修改共享工具执行时必须覆盖既有参数复用、批次取消和权限回归。真实 Electron 验收是首版发布门槛，Node 单测不能替代。

规格编写阶段只执行文档检查。A1 已有实现与测试证据；A2 的逐项后台回归与未验证范围见 [A2 验收记录](../reviews/2026-10-03-native-plugin-ui-a2-verification.md)。完整 UI-01–UI-26 仍是首版发布门槛，不把单阶段实现等同于完整交互 UI 已交付。

## 22. 后续阶段及明确边界

### 22.1 阶段 B：MCP Apps 接入

这一阶段独立编写实施计划，可复用首版文档隔离、宿主外壳、工具权限和持久交互事实，但必须实现官方协议，不能把 Native 自定义消息接口宣称为 MCP Apps。

必须完成：

1. `packages/mcp` 保留工具定义中的 `_meta.ui.resourceUri` 和完整 CallToolResult 的 content、structuredContent、`_meta`；区分模型可见内容与 UI 专用内容。
2. UI 资源读取固定在声明该工具的同一 MCP server 及捕获连接上；只接受协议允许的 UI 资源与 MIME，不能借 resourceUri 请求任意 URL。
3. 使用官方 `@modelcontextprotocol/ext-apps` 的 View / AppBridge 契约接入，提供初始化、工具输入/结果、交互工具调用、显示模式及卸载流程。
4. 将 iframe 工具请求限制到标准声明的可见工具与宿主批准范围，继续使用现有工具权限；认证凭据和 stdio 不进入 iframe。
5. UI resource 请求的 CSP / 外部资源权限由宿主校验，默认拒绝；不能自动使用外部域名或扩大 Native 首版的网络策略。
6. 保存完整可重建的关联与结果，对连接重建、server 变化、历史工具结果和用户重复操作执行相同的防重放规则。
7. 用官方例子和协议测试验证支持范围。未支持的标准方法返回明确错误，只在达到声明能力的协议要求后公布 `features.mcpApps`。

Native 的组件动作白名单不能直接当作 MCP Apps 工具 visibility，Native 的业务 resolve 也不能替代标准方法的语义。这些差异由适配模块处理，不修改核心状态的来源规则。

### 22.2 阶段 C：更多宿主扩展位置

有实际插件需要常驻状态条、工具栏按钮或独立设置页时，再定义明确位置及各自允许的数据与操作。每个扩展位置必须说明所有权、排列冲突、焦点、卸载和无界面替代行为。

首版不提供任意 CSS selector 或宿主组件名替换入口，也不提供“一个全局事件对象能读取所有会话”的接口。

### 22.3 阶段 D：Rome 式持久应用

当插件需要脱离单次工具结果，长期拥有列表、历史和后台任务时，单独设计 App 能力。范围包括独立入口、应用数据、任务记录、定时执行、应用权限和分享，复用现有 Jobs / Schedule / Application 服务。

它不通过把某个会话 iframe 永远开着来实现后台任务，也不让前端浏览器成为任务事实来源。

### 22.4 Claude Mods 与外部转换

首版 Native UI 与 Claude Mods 不是代码级兼容。Claude Mod 可以改写宿主内部事件和绘制组件，这些行为没有本规格中的等价入口。

Converter 必须把 `hooks.json.modules`、相关代码入口及内部 UI 能力明确标为 unsupported，给出“需要按 Native UI 接口重新编写”的原因；不得只转换普通 Skill 后报告整个插件完全可用。

可以以后为“纯结果界面”提供移植指南，不自动执行 Mod 模块，也不把 `ui.render` 翻译成具有不同权限含义的任意调用。

## 23. 实施顺序与阶段出口

本文是规格，不是逐条编码计划。后续 writing-plans 从此规格生成详细文件、测试和执行步骤，按照以下依赖顺序组织：

| 阶段 | 完整交付 | 阶段出口 |
| --- | --- | --- |
| A1：定义与授权 | UI 文件校验、加载结果、摘要、安装授权、诊断 | UI-01–UI-04 可独立验证，尚不执行前端 |
| A2：实例与工具操作 | 精确工具归属、可信实例、共享受检执行、UI Run、防重放、状态恢复、API / Client | UI-05–UI-16 通过，无界面也可验证全部后台事实 |
| A3：Desktop 与 SDK | 专用文档协议、隔离 frame、消息接口、卡片、侧栏、宿主确认 | UI-17–UI-23 通过，包括真实 Electron 隔离 |
| A4：参考插件与交付 | 样例、开发指南、Converter 诊断、错误文案、人工验收 | UI-24–UI-26 通过，首版可发布 |

feature `pluginUi` 只在完整后台能力接线后公布；Desktop 还需检测本地隔离文档能力。缺任一端能力时不开放交互入口，继续显示原工具结果，不试探其他请求形状。

本规格区分拟议接口与已验证实现；未交付的交互接口不能宣传为当前 API。最终发布需要全部首版验收证据，而不是仅凭 feature 字段或插件数量证明完成。

已实现入口：[A1 定义、加载与授权实施计划](../plans/2026-10-02-native-plugin-ui-a1.md)和[A2 实例与工具操作实施计划](../plans/2026-10-03-native-plugin-ui-a2.md)。A2 的真实 Native Tool、SQLite、Daemon / Hono / Client 证据见验收记录；A3 / A4 和真实 Electron 首版验收仍待实施。

A1 实际交付与验证：[2026-10-03 验收记录](../reviews/2026-10-03-native-plugin-ui-a1-verification.md)。

## 24. 已确定的取舍与调研依据

已确定：Desktop 先交付；两个显示位置；单文件 HTML；统一隔离 iframe；仅同插件 Native Tool；宿主确认；复用工具检查、Run、Part、事务和 SSE；工具完成后交互；历史快照不自动迁移；MCP Apps 单独接入；没有新业务表和通用 UI 语言。

这些取舍是本项目方案，不是下面项目的原样接口。下面资料在 2026-10-02 调研中读取，用于解释各自解决的问题；本规格不以这些项目“最新分支始终兼容”为运行前提。

- [DeepSeek Client Modules](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/client-modules.zh.md)：插件前端声明、加载和卸载。
- [DeepSeek Web Client Slots](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/slots.zh.md)：宿主扩展位置和组件生命周期。
- [DeepSeek 计划 UI](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-plan/src/client/index.ts)：同一能力同时拥有卡片、按钮和侧栏。
- [Claude Mods 概览](https://code.claude.com/docs/en/plugins/mods/overview)：内部事件、界面扩展、运行范围和权限。
- [Claude Mods 界面接口](https://code.claude.com/docs/en/plugins/mods/interface)：宿主绘制组件、输入和持久状态。
- [Rome Web UI](https://romeos.cc/docs/building-apps/capabilities/web-ui)：应用页面、聊天内组件、状态返回和 Shadow DOM 的边界。
- [Rome 应用设计](https://romeos.cc/docs/building-apps)：先保存业务状态，再启动长任务。
- [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) 与 [官方开发示例](https://apps.extensions.modelcontextprotocol.io/api/documents/quickstart.html)：标准工具 UI 资源和受控宿主桥接。

## 25. 规格自检

- 首版与后续阶段分开，Native、Mods、MCP Apps 和独立应用没有混成一套接口。
- 每条主要流程都给出入口、保存位置、执行步骤和结果返回方式。
- 插件声明、工具提议、宿主实例、窗口挂载和执行授权分别有明确来源。
- 网络重试、多窗口冲突、工具未知结果、重启、重载和插件版本变化都有确定规则。
- HTML 隔离不要求放宽主 renderer 脚本策略，不把 Shadow DOM 当安全边界。
- UI 不绕过工具权限，不自动调用模型，也不以恢复界面为由重放副作用。
- 首版验收是 UI-01–UI-26；现有文档检查和未来实现测试明确区分。
