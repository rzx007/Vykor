# 结构化输入框与多能力引用设计

> 状态：历史设计来源，已落地；本文已补齐当前 context item 和 Skill materializer 契约。当前执行流程见 [Skill Prompt Flow](../../skill-prompt-flow.md)。

## 目标

让 OpenHarness Desktop 的输入框对齐当前 Codex 桌面体验：用户可以输入 `/` 打开随位置变化的动态菜单，或输入 `$` 打开能力菜单，将一个或多个 Skill 作为无胶囊的行内引用插入正文；发送、排队、重试、编辑、历史恢复和会话投影都保留这些引用的结构与顺序。

本次不再扩展“正文开头只能有一个 `/skill`”的旧模型，而是建立可以继续承载 App、插件、文件和其他资源引用的长期输入协议。

## 已确认的交互

### `/` 与 `$`

- `/` 和 `$` 都可以在文档开头、空白字符之后或原子引用节点之后触发。
- 菜单查询范围是光标所在的当前 token。例如 `帮我用 /wri| 写计划` 只替换 `/wri`，不改动前后正文。
- `/` 打开动态菜单：当 `/` 是 composer 的首个非空字符时显示完整的应用命令与 Skill；当 `/` 位于正文中间时，只显示声明支持行内选择的条目，本次就是 Skill，不显示 Review、Compact 等应用动作。
- `$` 打开能力引用菜单。本次展示 Skill，并为 App、插件和资源引用保留扩展类型。
- 从 `/` 或 `$` 选择同一个 Skill，最终都插入同一种结构化 Skill 节点。
- 选择 Skill 后不发送消息；光标落在引用之后，并保证与相邻内容之间存在一个可继续输入的空格。
- 同一个 Skill 可以多次出现在正文中。编辑器不主动去重，因为重复引用及其位置属于用户输入；服务端加载指令时可以按规范化路径去重，避免重复加载同一份 `SKILL.md`。
- `Escape` 关闭菜单但保留已输入 token；继续修改 token 后菜单可以重新出现。
- `ArrowUp`、`ArrowDown` 移动菜单选项，`Enter` 或 `Tab` 选中，鼠标点击也可选中。

### 命令与能力的区别

菜单条目使用显式联合类型，不再把所有 catalog entry 都当成提示词模板：

```ts
type ComposerPickerItem =
  | { kind: "command"; command: DesktopCommandDescriptor }
  | { kind: "skill"; skill: ComposerSkillReference }
  | { kind: "mention"; mention: ComposerMentionReference }
```

- `command` 是应用动作，例如切换 Plan、选择模型或开始 Review。选择后交给命令处理器，不进入用户消息。
- `skill` 和 `mention` 是用户消息内容。选择后替换当前 token，成为行内原子节点。
- `/` 在首字符位置可以返回 `command | skill`，在正文中间只返回带 `supportsInlineSelection: true` 的条目；`$` 可以返回 `skill | mention`。
- 菜单可以共享过滤、键盘选择和定位逻辑，但数据源与选中后的动作必须分开。

命令描述符由 Desktop 自己维护稳定 action ID，并显式说明选择行为：

```ts
interface DesktopCommandDescriptor {
  id: string
  title: string
  description: string
  requiresEmptyComposer: boolean
  selection: "execute" | "submenu" | "insert"
}
```

- `requiresEmptyComposer: true` 的命令只在 `/` 是首个非空字符且当前没有其他正文或原子节点时出现。Review、Compact、Archive 等改变会话状态的动作属于这一类。
- `execute` 在清除当前 slash token 后执行应用动作；失败时恢复原草稿并显示错误。
- `submenu` 先打开二级选择，例如 Review 选择未提交改动或目标分支；最终确认后清除 token 并执行。关闭二级菜单恢复原 slash token。
- `insert` 只用于需要用户继续补参数的命令模板，选中后替换当前 token，不立即执行。
- 本次 Desktop 首先接入已有且能安全映射的 session command；未接入 dispatcher 的命令不展示，不能用一个字符串名称假装已经支持。
- inline `/` 只展示实现了行内替换行为的 Skill。普通应用命令即使 `requiresEmptyComposer` 配错，也必须经过第二层过滤，不得在正文中执行。

## 视觉设计

采用已选择的 A 方案，接近 Codex：

- Skill 引用由 14px 能力图标和显示名称组成。
- 使用现有语义化 `primary` 前景色，名称使用中等字重。
- 没有背景、边框、圆角、内边距或胶囊轮廓。
- 引用与正文共享行高并按文字基线对齐；长名称允许在输入框边界内截断，但节点整体不可拆分编辑。
- hover 只做轻微前景色变化并显示来源说明，不增加背景块。
- focus/键盘选中状态使用可见的文本下划线或 outline，不能只靠颜色表达状态。
- transcript 中的已发送消息使用同一套行内样式，不再额外显示顶部 Skill 胶囊。

## 数据模型

### 编辑器文档

输入框状态不再以 `draft: string` 作为唯一事实来源。新增可序列化的文档模型：

```ts
interface ComposerDocument {
  version: 1
  items: ComposerInputItem[]
}

type ComposerInputItem =
  | { type: "text"; text: string }
  | {
      type: "skill"
      name: string
      path: string
      displayName: string
      source?: "bundled" | "user" | "project" | "plugin"
    }
  | {
      type: "mention"
      name: string
      path: string
      displayName: string
    }
```

约束：

- 相邻 `text` item 在序列化时合并；空文本不保存。
- `skill.path` 是当前 Skill catalog 返回的绝对 `SKILL.md` 路径，`name` 和 `displayName` 用于提交文本与展示。路径会进入本地 Desktop 与 daemon 之间的协议，这与 Codex 的 `{ type: "skill", name, path }` 输入保持一致。
- `mention.path` 使用可扩展 URI，例如未来的 `app://...`、`plugin://...` 或文件资源 URI。
- 文档顺序就是用户表达顺序，所有层都不得按类型重新排序。
- 附件继续使用现有独立草稿列表、上传、租约和关系表，不进入本次 composer items。将来只有在产品真的支持“光标位置插入附件”时才单独设计行内附件协议。

### Session 输入协议

新增通用 `SessionUserInputItem`，由 client、server、desktop 共同使用：

```ts
type SessionUserInputItem =
  | { type: "text"; text: string }
  | { type: "skill"; name: string; path: string; displayName?: string; source?: SkillSource }
  | { type: "mention"; name: string; path: string; displayName?: string }
  | { type: "context"; kind: "conversation"; id: string; displayName: string }
```

`SendDesktopPromptInput`、`EditLatestDesktopPromptInput` 和创建 Session 的第一条输入改为接收 `items`。`attachments` 继续作为独立并行字段。原有 `content` 和单数 `skillInvocation` 直接从新接口删除，不提供双写兼容期。

`SessionInputRecord` 增加 `items` 并保留派生的 `content`：

- `items` 是持久化和恢复的事实来源。
- `content` 是把 text、`$skill-name` 和可读 mention 占位串联后的派生文本，用于标题、搜索和纯文本导出。
- attachment 记录继续使用现有存储与上传生命周期及顺序来源。

### 服务端展开

服务端在一次 run 被接纳后，将结构化输入解析成 agent/provider 可消费的内容：

1. 校验所有 item 的类型、长度和字段格式。
2. 规范化 `path`，并确认它与当前 cwd 的 Skill catalog 中某一项完全一致；renderer 不能提交 catalog 之外的任意路径。
3. 按首次出现顺序收集 Skill；执行加载时按规范化 path 去重。Skill 文件在运行时按当前内容读取，不固定选择时的历史快照。
4. 保留用户正文中的 `$skill-name` 可读标记。
5. `Skill` 工具增加可选 `path`：显式选择使用 `{ name, path }` 精确加载；隐式调用继续只传 `name`，由现有 registry 优先级选择赢家。
6. 当前 agent adapter 如果暂时只接受文本，则由单一兼容适配器生成一次集中加载指令；兼容逻辑不能散落在 Desktop、Session service 和各 provider 中。
7. 附件沿用现有流程展开成 `ContentBlock`，不与 composer items 混合排序。

当前 materializer 的文本形态为：

```text
用户显式选择了以下技能，请按出现顺序使用 Skill 工具的 { name, path } 加载并遵循：
1. using-superpowers (path: <SKILL.md path>)
2. writing-plans (path: <SKILL.md path>)

用户输入：
使用 $using-superpowers 写个计划 $writing-plans
```

Desktop 选中 Skill 时只插入结构化节点，不立即发送；TUI 的 `/<skill> args` 在 catalog 命中 template 后立即 admission。两端最终提交相同的 Skill/text items。

## Lexical 编辑器设计

### 节点

- 将现有 `SkillCommandPillNode` 更名为表达用途的 `SkillMentionNode`。
- 节点保存 `name`、`path`、`displayName`、`source`，导出 JSON 时包含稳定版本号。
- `getTextContent()` 返回 `$name`，保证复制到纯文本、搜索和降级展示仍有意义。
- 节点是行内原子元素：不能把光标放入名称内部，Backspace/Delete 一次删除整个节点，左右方向键可以越过节点。
- 后续新增 `ResourceMentionNode` 时复用相同的序列化接口和视觉组件。

### 编辑器与外部状态同步

- Lexical editor state 是编辑期事实来源；每次更新通过纯函数导出 `ComposerDocument` 给 Zustand 草稿 store。
- 外部恢复草稿时，从 `ComposerDocument` 重建 Lexical 节点，不再通过解析一个字符串猜测 Skill。
- 输入框初始化、切换 Session、提交成功清空、提交失败保留、历史恢复和编辑最新消息都使用同一套 document codec。
- 纯文本粘贴不会凭 `$name` 自动创建 Skill；只有从菜单明确选中的条目才带 catalog 返回的 path 并成为结构化节点。
- 从应用内部复制再粘贴时，自定义 MIME 只作为候选数据；仍用服务端 catalog 重新验证 path。验证失败就降级为 `$name` 纯文本。外部应用只能得到 `$name` 纯文本。

### token 识别

新增纯函数根据当前文档和 selection 返回触发信息：

```ts
interface ComposerTrigger {
  sigil: "/" | "$"
  query: string
  range: { start: number; end: number }
}
```

规则：

- 只检查当前光标所在的普通文本节点。
- token 起点必须是文档开头、空白之后或原子节点之后。
- query 不跨越空白、换行或原子节点。
- `/`、`$` 后尚无字符时 query 为空并显示完整列表。
- 光标移入 token 中间时，只替换该 token 的查询范围，保留后缀正文。
- IME 组合输入期间不打开、过滤或提交菜单，组合结束后再同步。
- query 只接受 Skill/命令名称现有允许的 ASCII 字母、数字、`.`、`_`、`:`、`-`；空白、中英文标点和新的 sigil 都终止 token。
- `//`、`$$` 视为用户想输入字面字符，不打开菜单；URL 中不满足词边界的 `/` 不触发。

## 菜单设计

- 将 `SkillCommandMenu` 拆为通用 `ComposerPicker` 和数据源适配器。
- 菜单锚定当前 token，而不是固定覆盖整个 composer；空间不足时允许退化为输入框宽度。
- `/` 首字符菜单按命令、Skill 分组；inline `/` 菜单只显示 Skill；`$` 菜单按 Skill、未来的 App/资源分组。
- 搜索字段包括 name、displayName、description 和来源，但插入身份始终使用 catalog 返回的精确 path。
- 同名 Skill 沿用现有 registry 的覆盖优先级，只展示当前赢家，不在本次改造中支持同名多版本并列选择。
- 没有结果时显示安静的空状态；不会阻止用户继续把 `/...` 或 `$...` 当普通文字发送。

## 数据流

```text
键盘输入
  → Lexical 文本/原子节点
  → 光标 token 解析
  → / 或 $ 菜单
  → 首字符 /：完整命令 + Skill
  → inline /：仅可行内插入的 Skill
  → 选择命令：清除 token 后交给命令处理器，不写入消息
  → 选择能力：替换 token 为结构化节点
  → ComposerDocument 保存到草稿 store
  → 提交时转换为 SessionUserInputItem[]
  → Session event/store 持久化 items，同时派生 content
  → run executor 解析 Skill 与附件
  → agent adapter 获得结构化输入或统一兼容展开结果
  → transcript 从 items 还原正文和行内引用
```

## 不兼容升级

- 用户明确选择不兼容旧数据。本次不读取、不转换、不回填旧 `metadata.skillInvocation`，也不提供旧 client 与新 server 的混合运行支持。
- Session input schema 直接切换为必填 `items_json`；内存 store 和 SQLite store 同步升级。
- durable event payload 保持事件名称但提升版本，只支持新版本重放；旧 event log 不做 upcaster。
- 发布与开发升级前必须通过明确的存储版本门禁。发现旧数据库时给出“需要清理旧 Session 数据”的可操作错误，不得静默部分读取或自动删除。
- 仓库测试 fixture 一次性迁移到新格式；单数 `SkillInvocationMetadata`、`parseSelectedSkillCommandDraft`、`parseSkillCommandInvocation` 和 `applySkillInvocationToContent` 直接删除。
- 新写入仍派生 `content` 作为标题、搜索和纯文本导出字段，但它不是恢复结构的来源。

## 错误处理与安全

- 提交前发现 Skill 已删除或路径不可读时，保留草稿并把对应引用标为失效，提示用户移除或重新选择。
- server 接受 renderer 传入的绝对 path，但必须规范化并验证它属于当前 cwd 的 Skill catalog；不能直接读取任意路径。
- 名称和显示名称限制长度并过滤控制字符；路径不进入 HTML title 的未转义内容。
- 未识别的 `/` 或 `$` token 始终作为普通文本，不阻塞正常发送。
- 排队、steer 和 edit 使用同一套校验，避免直接发送与排队发送行为不一致。
- 单次输入最多 256 个 item、32 个 Skill 引用、1 MiB UTF-8 文本；单个 name 最多 128 字符、displayName 最多 256 字符。超限返回稳定错误码并保留草稿。

## 测试策略

### 纯函数与协议

- 光标在开头、空格后、原子节点后输入 `/` 或 `$` 都能产生正确 trigger。
- 单词内部、URL、转义文本和 IME 组合期间不误触发。
- 选中项只替换当前 token，正文前后保持不变。
- 多个 text/skill/mention item 往返序列化后顺序和字段不丢失。
- 兼容文本按原顺序生成 `$skill-name`，相邻 text 正确合并。
- 服务端按规范化 path 去重完全相同的 Skill；同名冲突继续服从现有 registry 优先级。
- 256/257 items、32/33 Skill、文本上限前后一个字节都有边界测试。

### 组件

- 首字符 `/` 菜单包含命令和 Skill；inline `/` 只包含 Skill；`$` 菜单不包含应用命令。
- Review、Compact 等 `requiresEmptyComposer` 动作绝不出现在 inline `/` 菜单，也不能从正文中执行。
- execute、submenu、insert 三种命令选择路径分别覆盖成功、取消和失败恢复草稿。
- 键盘导航、Escape、Enter、Tab、鼠标选择符合定义。
- Skill 引用没有背景、边框、圆角和胶囊内边距，使用语义化 primary 色。
- Backspace/Delete、左右移动、复制粘贴和内部结构化粘贴保持原子节点行为。
- IME 输入不会误提交或让菜单抢走按键。

### Session 全链路

- 新会话、已有会话、queue、steer、retry、edit latest 均保留多个引用。
- optimistic transcript 与服务端 transcript 结构一致，不在确认后闪烁或改变顺序。
- Skill 删除、路径越界和无效字段返回可恢复错误，草稿不丢失。
- 文本-only、带多个 Skill、仅 Skill，以及结构化 Skill 与独立附件同时提交的场景都有覆盖。

## 实施切片

1. 定义 `ComposerDocument`、`SessionUserInputItem`，给 command catalog 补充 Skill path，并先完成 codec 纯函数测试。
2. 将草稿 store 和 Session API 迁移到结构化 items，打通持久化、排队、重试和编辑。
3. 重构 Lexical 节点与光标 token 解析，实现 `$` 能力菜单和多个 Skill。
4. 将 `/` 菜单改成动态数据源：首字符显示完整菜单，inline 只显示 Skill，并按条目类型分流。
5. 改造服务端 run 展开和 Skill 路径校验，删除分散的单 Skill prompt 注入。
6. 从 items 渲染 optimistic/confirmed transcript，应用无胶囊行内样式。
7. 删除迁移完成后的单 Skill 生产路径，运行 Desktop、client、protocol、services、server 相关测试和全仓类型检查。

## 非目标

- 本次不实现新的 App、插件或云资源连接器，只保留 `mention` 协议和菜单扩展点。
- 不自动把用户手打或粘贴的 `$name` 提升为可信 Skill。
- 不改变 Skill 的发现目录、优先级或安装流程。
- 不改变具体应用命令的业务效果，只调整菜单触发、分类和分流。

## 验收标准

- 用户可在正文任意合法 token 边界通过 `/` 或 `$` 添加多个 Skill。
- `/` 为首字符时显示完整动作菜单；位于正文中间时隐藏 Review、Compact 等应用动作，只显示可行内插入的 Skill。
- 两种入口生成同一种结构化 Skill item，并保留精确 path 与出现顺序。
- `/` 中的应用命令仍作为动作处理，不混入模型输入。
- 输入框和 transcript 的 Skill 均为蓝色图标加名称，无胶囊视觉。
- 发送、排队、重试、编辑和历史恢复不丢失引用。
- 新数据只走结构化 items，旧单 Skill 会话不兼容且不会被静默转换或删除。
- 服务端不信任 renderer 路径，并集中处理 Skill 加载与兼容展开。
