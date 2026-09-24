# 归档：Vykor TUI 二期设计文档

> 历史设计记录。本文的 UI 功能描述可作背景参考，但运行时和 session 协议以 [../../tui-flow.md](../../tui-flow.md) 与 [../../client-sync-flow.md](../../client-sync-flow.md) 为准。

> TUI ink→opentui 迁移二期：内联 Diff、`@` 文件补全、Frecency、Sidebar

## 背景

一期完成了完整的 ink→opentui 迁移。二期在此基础上增加三类能力：
1. **消息流内联 Diff**：Edit/Write 工具调用渲染为可视化 diff 块
2. **输入体验组**：`@` 文件补全 + frecency 历史排序
3. **Sidebar 会话侧栏**：宽屏下右侧信息面板

---

## 范围

### 二期（本 spec）

- **Diff viewer**：消息流内联 unified diff，`<diff>` 原生组件，超长截断
- **`@` 文件补全**：`git ls-files` 源，选中插入相对路径，Autocomplete 组件泛化
- **Frecency**：命令/文件使用频率排序，半衰期 14 天，持久化 JSON
- **Sidebar**：宽屏（≥110 列）自动 + `ctrl+b` 手动切换，显示会话信息/文件变动/Todo/Swarm/MCP

### 不做（三期及以后）

插件 slot 系统、全屏 diff 对比器、鼠标选区、编辑器上下文嵌入、多 workspace 切换 UI。

---

## 技术栈

- `@opentui/react` 0.4.1 + React 19（已装）
- `@opentui/core` 0.4.1 的内置 `<diff>` 组件（`DiffRenderable`，已在 node_modules）
- npm `diff` 包（opencode 同款，`createTwoFilesPatch`）
- Bun 运行时（前端进程）
- `bun test` + `testRender` 帧测试

---

## 1. Diff Viewer

### 数据来源

后端已通过 `TranscriptItem` 发送 `tool_input`（含 `old_string`/`new_string`/`path`/`content`）。
现有 `parts.tsx` 的 `case "tool"` 分支仅渲染单行摘要，二期在此增加 diff 渲染。

### 组件设计

**新文件 `apps/frontend/src/components/messages/ToolDiff.tsx`**

```tsx
type ToolDiffProps = {
  filePath: string;
  oldText: string;
  newText: string;
  syntaxStyle: SyntaxStyle;
};
```

- 用 `diff` 包的 `createTwoFilesPatch(filePath, filePath, oldText, newText)` 生成 unified patch 文本
- 喂给 opentui `<diff>` JSX 元素（属性：`diff`、`view="unified"`、`showLineNumbers={true}`、`filetype`（从扩展名派生）、`syntaxStyle`、`addedBg`/`removedBg`（主题色）
- Write 工具（全新文件）：`oldText=""`, `newText=content`，表现为全 added 块

**截断规则**：unified patch 行数超过 20 时，保留前 20 行 + 末尾追加一行灰色文本 `… +N more lines`（不嵌套滚动，避免 scrollbox 内双滚动冲突）。

**修改 `apps/frontend/src/routes/session/parts.tsx`**：

- `case "tool"` 分支识别 `Edit`/`Write`/`str_replace_editor` 等工具名
- 有 `old_string` + `new_string` → 渲染头行（文件名 + `+N / -M` 统计）+ `<ToolDiff>`
- `Write` 且 `content` 非空 → `<ToolDiff oldText="" newText={content}>`
- 其余工具保持原摘要行渲染

### 冒烟门

Task 1 先写 `scripts/probe-diff.tsx`（类同一期 Task 0），验证 `<diff>` 组件在 Windows 上可渲染 unified patch；不通过则回退到 `<code>` + ANSI +/- 着色。

---

## 2. `@` 文件补全

### 触发逻辑

光标前最近 `@` 为 token 起点，`@` 之后无空格时打开文件补全浮窗（与 `/` 命令补全互斥）。
取消：ESC 或 `@` 之后出现空格。选中：Enter/Tab → 把 `@token` 替换为 `@相对路径 `（posix 斜杠，末尾空格）。

### 文件列表来源

**新文件 `apps/frontend/src/components/prompt/fileCompletion.ts`**

```ts
export async function listProjectFiles(cwd: string): Promise<string[]>
```

1. 尝试 `git ls-files --cached --others --exclude-standard` （Bun subprocess）
2. 非 git 仓库时：受限 fs walk，深度 ≤ 6，跳过 `node_modules`, `.git`, `dist`, `.next`
3. 返回结果截断 5000 条
4. 结果缓存在内存（进程生命周期内，不需要失效）

### Autocomplete 泛化

**修改 `apps/frontend/src/components/prompt/Autocomplete.tsx`**：

props 从 `commands: Command[]` + `query` 改为通用接口：

```ts
type AutocompleteItem = { id: string; label: string; detail?: string };
type AutocompleteProps = {
  items: AutocompleteItem[];
  selectedIndex: number;
  onSelect?: (item: AutocompleteItem) => void;
};
```

渲染层（两列、10 行上限、整行高亮）不变。斜杠命令和文件补全各自在 Prompt 层组装 `items[]`。

**修改 `apps/frontend/src/components/prompt/Prompt.tsx`**：

- 新增文件补全状态（`fileAcOpen`, `fileAcItems`, `fileAcIndex`）
- `@` token 检测用正则 `/(?:^|\s)@(\S*)$/`（取光标前文本的最后匹配）
- 文件列表懒加载（首次触发时 `await listProjectFiles(process.cwd())`）
- 选中后替换 token：
  1. `const full = textareaRef.current.plainText`（UTF-16 字符串）
  2. 在 `full` 中用正则 `/(?:^|\s)@(\S*)$/`（取最后匹配）定位 `@` 的字符索引 `atStart` 和 token 末尾索引 `atEnd`
  3. `const next = full.slice(0, atStart) + "@" + relativePath + " " + full.slice(atEnd)`
  4. `textareaRef.current.setText(next)`（`TextareaRenderable` 无 `replaceRange`，必须全量替换）
  - 注：`cursorOffset`（`EditBufferRenderable` 的字符索引属性）可辅助验证当前光标处于 `@token` 之后，但 token 边界应直接从 `plainText` 字符串正则推导，不依赖 `cursorOffset` 做切割

---

## 3. Frecency

**新文件 `apps/frontend/src/services/frecency.ts`**

```ts
export function record(kind: "command" | "file", key: string): void
export function rank(kind: "command" | "file"): Map<string, number>
```

**得分公式**：`score(key) = Σ 2^(−Δ天/14)` 对每次使用的时间戳，即半衰期 14 天的指数衰减。

**持久化**：
- 路径 `$VYKOR_CONFIG_DIR/frecency.json`，默认 `~/.vykor/frecency.json`
- 格式：`{ command: { id: timestamp[] }, file: { path: timestamp[] } }`
- 懒加载（首次 `rank/record` 时读），防抖写入（500ms debounce）
- 文件损坏（JSON.parse 异常）静默重置为空对象，不崩进程

**集成排序**：

- `components/prompt/Autocomplete.tsx`：`getAutocompleteSuggestions` 在 fuzzy 分数相同时按 frecency 降序
- `components/prompt/fileCompletion.ts`：文件列表按 frecency 得分预排序后再 fuzzy 过滤

---

## 4. Sidebar

### 文件

**新文件 `apps/frontend/src/routes/session/Sidebar.tsx`**

```tsx
type SidebarProps = {
  status: Record<string, unknown>;
  transcript: TranscriptItem[];
  mcpServers: McpServerSnapshot[];
  todoMarkdown: string;           // 与 App.tsx 现有类型一致，Sidebar 自行渲染（复用 TodoPanel 逻辑）
  swarmTeammates: SwarmTeammateSnapshot[];
  swarmNotifications: SwarmNotificationSnapshot[];
  version?: string | null;
};
```

### 布局

Session 路由横向分为 `[消息区 flexGrow=1] [Sidebar width=40]`。Sidebar 固定 40 列。

### 显隐规则

使用简单布尔 `sidebarOpen: boolean`（存于 `AppInner` state）：

- 挂载时：`sidebarOpen = terminalWidth >= 110`（宽屏默认开）
- `ctrl+b`：`setSidebarOpen(v => !v)`（无论当前宽度，直接取反）
- `terminalWidth` 变化时**不**自动重置 `sidebarOpen`（避免用户手动调整后被宽度变化覆盖）

不持久化，进程生命周期内有效。

命令注册表新增 `app.sidebar`（label: `Toggle Sidebar`），让 ctrl+p 面板也能操作。

### 内容区块（无数据则不渲染该块）

1. **会话信息** — mode / model / effort / input+output tokens
2. **Modified Files** — 从 `transcript` 中 `tool_name=Edit|Write` 条目推导，累计 +N/-M 统计，去重同一文件（按最后一次修改保留）；最多显示 15 条，超出显示 `+N more`
3. **Todos** — 来自 `todoItems`，复用现有 TodoPanel 渲染逻辑（抽取或直接引用）
4. **Swarm** — 来自 `swarmTeammates`，复用现有 SwarmPanel 逻辑
5. **MCP** — 来自 `mcpServers`，每行 `[状态点] 名称 (N tools)`

### 与 TodoPanel/SwarmPanel 的关系

`sidebarVisible` 状态提升到 `AppInner`（与 `Session` 路由同层），通过 props 向下传给 `Session`（控制 Sidebar 渲染）以及控制 App.tsx 中已有的 `TodoPanel`/`SwarmPanel` 条件渲染：

```tsx
// App.tsx 中（示意）
const [sidebarOpen, setSidebarOpen] = useState(false);
// ...
{!sidebarOpen && todoMarkdown ? <TodoPanel markdown={todoMarkdown} /> : null}
{!sidebarOpen && <SwarmPanel ... />}
<Session sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(v => !v)} ... />
```

Sidebar 显示时 `TodoPanel`/`SwarmPanel` 不重复渲染；窄屏 / 手动关闭时恢复原面板位置。`ctrl+b` 快捷键在 `AppInner` 的全局键盘监听里调用 `setSidebarOpen`。

---

## 5. 测试计划

每个子功能独立 bun test：

| 测试文件 | 覆盖点 |
|---|---|
| `ToolDiff.test.tsx` | 正常 diff 渲染、超 20 行截断、全 added（Write） |
| `fileCompletion.test.ts` | git 路径、fs walk 回退、5000 条截断、缓存命中 |
| `frecency.test.ts` | score 公式、持久化 roundtrip、JSON 损坏静默重置 |
| `Sidebar.test.tsx` | ≥110 显示、<110 隐藏、ctrl+b 覆盖、Modified Files 去重统计 |

---

## 6. 实施顺序

1. Task 0：`<diff>` 组件 Windows 冒烟 probe
2. Task 1：Diff viewer（ToolDiff + parts.tsx 改动）
3. Task 2：`diff` npm 依赖 + ToolDiff 集成测试
4. Task 3：Autocomplete 泛化（接口不破坏现有斜杠补全）
5. Task 4：fileCompletion.ts（文件列表 + `@` 触发）
6. Task 5：frecency.ts（纯逻辑 + 持久化）+ 排序集成
7. Task 6：Sidebar 组件 + Session 布局改造
8. Task 7：全量回归测试 + 清理
