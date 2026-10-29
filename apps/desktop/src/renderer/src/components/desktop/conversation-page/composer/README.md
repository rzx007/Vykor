# Composer

Composer 是会话页的结构化输入入口。它负责编辑文本、选择 Skill、执行 Slash 命令、添加上下文和管理待发送附件，但不直接执行 Agent 工具。

## 入口语义

| 入口 | 作用 |
| --- | --- |
| 普通输入 | 编辑用户请求文本 |
| `/` | 打开命令与 Skill 面板；首字符可显示会话命令，中间位置只显示允许插入的能力 |
| `$` | 打开 Skill 面板并插入结构化 Skill mention |
| `@` | 打开“添加上下文”面板并在光标位置插入上下文引用 |
| `+` | 用鼠标打开与 `@` 相同的“添加上下文”面板，不改写正文 |
| 拖拽/粘贴 | 添加附件，继续使用独立的附件上传链路 |

`@` 与 `+` 共用 Context Picker，可选择插件或添加上下文；Skill 仍使用 `/` 或 `$` 入口。

## 当前范围

Context Picker 当前提供：

- 文件和文件夹：继续调用现有文件选择与附件上传逻辑。
- 计划模式：独立切换当前会话的 `workMode`，保留原授权档位；支持从标记或 `/plan` 退出。
- 历史对话：插入结构化、只读的会话引用。
- 插件：按服务端目录插入本轮插件引用，后端决定实际可用的 Skill、工具与 Agent；选择插件不授予执行权限。
- 目标：进入独立目标输入模式；提交后由会话级 Banner 展示和控制状态。

目标暂停时若补充消息仍在处理，可以点击“排队继续”。后台为每个目标保留一个待继续请求，
所有补充消息处理完后重新检查目标版本、批准与预算，只启动一次。Banner 可取消排队；
暂停、取消、编辑目标或预算、补充消息失败都会撤销排队。切换会话不影响已接受的排队；
后台重启则取消排队并提示重新确认，不在启动时静默续跑。
输入的插件和上下文准备阶段也算处理中；准备失败时不会越过这条补充启动目标。
回答目标提问后若排队启动失败，会恢复提问和已填答案，用户可检查后再次确认，已增加的额度不会重复增加。

当前不提供：

- 站点
- 独立应用和文件聊天搜索（没有稳定数据源前不展示）

## 主要文件

| 文件 | 职责 |
| --- | --- |
| `composer.tsx` | Composer 外壳、底部控制区、`+` 入口和 Context Picker 数据组装 |
| `rich-prompt-input.tsx` | Lexical 编辑器、结构化节点、触发器、选择和光标处理 |
| `composer-picker.tsx` | Picker 列表、搜索、键盘导航、图标和选择回调 |
| `composer-trigger.ts` | `/`、`$`、`@` 的 token 边界识别 |
| `skill-mention-node.tsx` | Skill 的 Lexical 原子节点 |
| `resource-mention-node.tsx` | 文件/资源/历史会话上下文的 Lexical 原子节点 |
| `composer-attachments.tsx` | 待发送附件的预览、进度、取消、重试和移除 |
| `composer-file-input.ts` | 拖拽、粘贴和文件输入解析 |
| `context-usage-control.tsx` | 当前上下文用量入口 |
| `goal-banner.tsx` | 当前目标状态、详情、暂停/继续和取消入口 |
| `../../../../stores/desktop-session/goal-actions.ts` | 按会话隔离的目标草稿、请求和状态同步 |

## 数据模型

编辑器状态使用 `ComposerDocument`：

```ts
interface ComposerDocument {
  version: 1
  items: SessionUserInputItem[]
}
```

输入项包括文本、Skill、资源引用、历史对话、插件及插件 Agent。规范数据定义位于 `packages/domain-contracts/src/inputs/items.ts`，`packages/protocol/src/session/session-input-items.ts` 将其作为通信数据公开。这里不复制整份联合类型，新增输入项时同步核对编辑器节点、发送与服务端校验。

## `@` 与 `+` 数据流

```text
键入 @ / 点击 +
        ↓
Context Picker
        ↓
文件 ─────→ 现有附件选择和上传链路
计划模式 ─→ 更新 workMode，保留 approvalMode
插件 ─────→ 插入 plugin capability item
历史对话 ─→ 插入 conversation context item
        ↓
ComposerDocument
        ↓
发送 SessionUserInputItem[]
```

键入 `@查询词` 后选择历史对话时，编辑器会用结构化节点替换 `@查询词`，保留其前后正文并把光标放回节点后。点击 `+` 不向正文插入 `@`。

## 历史对话引用

历史对话引用只保存：

- `kind: "conversation"`
- 会话稳定 ID
- 展示名称

客户端不携带历史消息正文。服务端收到引用后：

1. 拒绝引用当前会话。
2. 根据 ID 读取会话。
3. 拒绝不存在或已归档的会话。
4. 读取用户和助手文本消息。
5. 将内容限制在 12,000 字符以内。
6. 作为只读参考上下文放在当前用户输入前。

历史对话不会被合并到当前会话，也不会改变当前导航位置。

## 附件不变量

Context Picker 不替换附件系统。以下能力必须保持：

- 拖拽文件到 Composer。
- 从剪贴板粘贴文件或图片。
- 上传进度、取消、重试和移除。
- 发送失败后保留草稿和附件。
- 新会话创建成功后原子迁移草稿。

`+` 选择“文件和文件夹”最终仍调用已有 `onPickFiles`，因此附件存储、校验和发送路径不变。

## 命令与 Skill

- 首字符 `/` 可以执行要求空 Composer 的命令，例如 `/compact`。
- 中间位置 `/` 不显示只能独立执行的命令。
- `$` 在任意合法 token 边界打开 Skill 列表。
- Skill 选择结果是原子节点，复制和粘贴时保留结构化内容。
- Skill 路径必须由服务端目录再次校验，客户端值不能直接用于读取文件。

## 输入法与键盘

- Picker 支持 ArrowUp、ArrowDown、Enter、Tab 和 Escape。
- IME composition 期间 Enter 由输入法处理，不发送消息。
- Picker 选择后不得生成额外段落或换行。
- `//`、`$$`、URL 中的 `/` 等内容不能误触发菜单。

## 系统状态

Composer 触发的系统操作通过 metadata presentation 展示，不作为普通模型消息：

- 模型切换
- 正在压缩上下文
- 已压缩上下文
- 上下文压缩失败

对应消息在服务端 transcript 转换时会被排除，避免污染模型上下文。

## 测试

主要测试位置：

- `composer/__test__/composer-trigger.test.ts`
- `composer/__test__/composer-picker.test.tsx`
- `composer/__test__/rich-prompt-input.interaction.test.tsx`
- `composer/__test__/composer.attach-button.test.ts`
- `composer/__test__/composer-attachment-preview.test.ts`
- `packages/protocol/src/session/__test__/session-input-items.test.ts`
- `packages/server/src/application/session/interactions/__test__/session-input-materializer.test.ts`

运行相关测试：

```powershell
pnpm --filter @vykor/protocol test
pnpm --filter @vykor/server test
pnpm --filter @vykor/desktop test
```

类型检查：

```powershell
pnpm exec tsc --noEmit -p packages/protocol/tsconfig.json
pnpm exec tsc --noEmit -p packages/server/tsconfig.json
pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json
```

## 目录归类约定

同一次输入交互所需的组件和插件相邻；消息渲染和记录滚动不放入这里。

测试、测试辅助模块和基准测试放在同级 `__test__`。目录变动时同步维护入口和引用，完整规则见 [Desktop 协作约定](../../AGENTS.md)。

插件标签的图标从输入框当前插件列表提供。草稿只保存插件引用；恢复草稿和从插件详情跳转时，图标仍由 PluginMentionIcons 提供，不写入发送给服务端的输入。

## 输入、停止与窄窗口

输入法确认键同时检查原生 `isComposing` 和兼容键码 229，不能触发发送或选择候选菜单。禁用输入时同步 Lexical 的可编辑状态并关闭候选交互，键盘与粘贴不能绕过禁用；恢复后保留原草稿与编辑能力。

停止按钮读取现有停止操作：请求发出后显示“正在停止”并禁用重复点击，等对应运行的会话更新确认终态后结束。它与普通发送分别表示，不把停止显示成“正在发送”。工具栏空间不足时自动换行，保留模型、上下文和发送入口。

上下文用量面板只在组件内保存读取中和失败状态。显式打开及重试会接收 `refreshContextUsage` 的结果：成功写入为 true，读取失败或不可用为 false，同会话被后台刷新接替时等待最新结果，切会话后的旧请求不更新反馈。没有数据和读取失败分别展示，更新失败时保留上次快照，关闭面板后忽略迟到结果。
