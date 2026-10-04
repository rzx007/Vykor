# 全局便签 V1 设计

日期：2026-10-04

状态：产品范围已确认，等待书面规格复核

## 1. 背景

桌面端左侧导航当前有一项写死的“拉取请求”。它没有点击行为，不会改变状态、跳转路由或发起请求：

- 导航项定义在 `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx:75-79`。
- 渲染时只有“定时任务”和“插件”获得点击回调，见同文件 `:253-276`。

本功能用“便签”替换该占位项。第一版面向日常零碎想法和轻量笔记，重点是打开即写、可靠保存和容易找回，不把它做成知识库、任务系统或项目文档系统。

## 2. 已确认的产品决定

- 采用“便签列表 + 正文编辑器”的双栏页面。
- 所有便签全局共用，不按项目隔离。
- 正文是唯一必需输入；不要求单独填写标题。
- 列表标题从正文第一行派生，不单独持久化。
- 内容存入现有 SQLite，由 daemon 作为业务数据管理。
- 自动保存；应用异常退出时可恢复最后尚未写入 SQLite 的内容。
- 第一版支持新建、编辑、全文搜索、删除确认和重启恢复。
- 删除确认后直接删除，第一版没有回收站。

## 3. 调研结论

几个成熟产品的共同做法是先降低捕捉阻力，再提供轻量找回能力：

- [Raycast Notes](https://manual.raycast.com/notes) 把打开、创建和搜索拆成清晰动作，支持多便签，但一次只专注一条内容。
- [Apple Quick Note](https://support.apple.com/guide/notes/create-a-quick-note-apdf028f7034/mac) 区分“继续上一条”和“新建一条”。本设计对应为：点击左栏恢复上次位置，点击“＋”始终新建。
- [Microsoft Sticky Notes](https://support.microsoft.com/en-us/windows/apps/stickynotes/get-started-with-sticky-notes) 把自动保存、列表和搜索作为基础能力。
- [Drafts](https://getdrafts.com/) 强调先写再整理，新内容先进入收件箱，不要求用户先命名或分类。
- [Tot](https://tot.rocks/) 和 [SideNotes](https://www.apptorium.com/sidenotes) 说明轻量、低打扰、随时可返回比复杂格式更重要。

用户讨论反复出现两类痛点：打开和分类步骤太多会让想法在记录前消失；保存或同步不可靠会直接破坏对工具的信任。因此第一版优先保证输入路径短、内容不丢和正文可搜索，不先增加分类与格式系统。

## 4. V1 范围

### 4.1 包含

- 用“便签”替换左栏“拉取请求”，使用便签图标并提供选中态。
- 新增 `/notes` 页面。
- 全局便签列表与单条正文编辑器。
- 新建、编辑、全文搜索、删除确认。
- 从正文首个非空行派生列表标题和摘要。
- 自动保存、保存状态、失败重试和异常退出恢复。
- SQLite 持久化，并进入现有数据库备份。
- 空状态、无搜索结果状态、加载失败状态和保存失败状态。
- 深浅主题、键盘焦点、可见焦点样式和屏幕阅读器标签。

### 4.2 第二期

以下能力明确进入第二期，不在第一版预留未使用的界面入口：

1. 置顶、归档、回收站。
2. 文件夹、标签、颜色。
3. Markdown 预览、富文本、图片和附件。
4. 项目关联、AI 整理、多端同步。
5. 系统级快捷唤起或悬浮窗。

## 5. 页面结构

### 5.1 左侧主导航

将 `secondaryNavigation` 中的“拉取请求”替换为“便签”。`Sidebar` 增加 `onOpenNotes` 回调和 `/notes` 选中态，`MainLayout` 负责导航。

入口行为固定如下：

- 从其他页面点击“便签”，打开 `/notes`。
- 若上次选中的便签仍存在，恢复该便签。
- 若没有上次选择，选中最近修改的便签。
- 若没有任何便签，显示空白编辑区并立即聚焦。

最后选中的便签 ID 属于界面状态，使用带版本的独立 `localStorage` 键保存；它不是便签业务数据。记录不存在或已删除时按上述回退规则选择。

### 5.2 便签页面

工作区内部再分两栏：

- 左栏是便签列表。顶部显示“便签”“全部项目共用”、搜索框和“＋”按钮。
- 右栏是单条正文编辑器。顶部只显示保存状态、更新时间、字数和更多菜单。
- 列表按 `updatedAt` 从新到旧排序。
- 选中项显示第一行标题、单行摘要和相对更新时间。

第一版不提供可调整的内部分栏宽度。正常宽度下列表约 280px；较窄窗口降到约 230px，正文区保持 `min-width: 0` 并优先获得剩余空间。

### 5.3 正文与标题

编辑器只编辑一份纯文本正文，不展示必填标题输入框。

- 标题取正文首个非空行，去除首尾空白后最多展示 80 个字符。
- 摘要取标题之后的非空正文，折叠连续空白后最多展示 120 个字符。
- 已存在的便签被清空时仍保留，列表显示“无标题便签”；清空正文不等于删除。
- 新建草稿在首次出现非空内容前不写入 SQLite，也不进入列表。

## 6. 用户流程

### 6.1 新建

1. 用户点击“＋”，或者在首次使用的空白编辑区直接输入。
2. 页面进入本地空白草稿，编辑器获得焦点。
3. 用户输入首个非空字符后创建 SQLite 记录。
4. 创建成功后列表出现该便签，后续修改进入自动保存流程。
5. 用户未输入内容就切换页面或便签时，直接丢弃空白草稿。

### 6.2 编辑和自动保存

1. 输入立即更新页面内存状态，并同步写入临时恢复稿。
2. 停止输入约 300ms 后发起保存。
3. 同一便签的保存请求串行执行，并合并尚未发出的中间版本。
4. 保存成功后更新 `revision`、`updatedAt` 和列表顺序。
5. 切换便签或路由时立即补发尚未开始的保存。
6. 编辑器顶部通过 `aria-live="polite"` 展示“保存中”“已保存”或“保存失败”。

### 6.3 搜索

- 搜索匹配完整正文，忽略大小写。
- 搜索结果仍按最近修改排序。
- 输入搜索词时不改变当前正文。
- 当前选中便签不在结果中时，选中第一条结果；没有结果时右栏显示无结果状态，不清空原正文。
- 清空搜索后恢复完整列表，并尽量恢复搜索前的选中项。

第一版数据量较小，页面首次加载完整便签记录后在 Renderer 内过滤，不引入 SQLite FTS 或新的搜索索引。

### 6.4 删除

1. 用户从正文顶部更多菜单选择“删除便签”。
2. 确认框明确显示该操作不可撤销。
3. 确认后硬删除 SQLite 记录，并清理该便签对应的恢复稿。
4. 删除后选中列表下一条；没有下一条时选中上一条；列表为空时显示空白编辑区。
5. 取消确认不改变任何内容。

## 7. 数据模型

新增 `notes` 表：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | 应用生成的稳定 ID |
| `content` | `TEXT NOT NULL` | 纯文本正文 |
| `revision` | `INTEGER NOT NULL DEFAULT 1` | 乐观并发版本号 |
| `created_at` | `INTEGER NOT NULL` | 创建时间戳，Unix 毫秒 |
| `updated_at` | `INTEGER NOT NULL` | 最近成功保存时间戳，Unix 毫秒 |

为 `updated_at DESC` 建索引。第一版不添加 `title`、`project_id`、`folder_id`、`tags`、`color`、`pinned_at` 或 `deleted_at`。

正文最大长度按 JavaScript `string.length` 计算为 100,000。协议层拒绝超限内容，页面在达到上限时保留已有正文并显示明确提示。创建请求要求正文至少包含一个非空白字符；更新请求允许把已存在的便签清空。

## 8. 数据流与模块边界

运行路径：

```text
NotesPage
  → window.desktop.notes
  → DesktopNoteService
  → VykorClient.notes
  → daemon /notes
  → NoteRepository
  → sessions.db
```

模块职责：

- Renderer：页面状态、选中项、搜索、自动保存协调和临时恢复稿。
- preload / shared contract：只暴露窄的 notes API，不向 Renderer 暴露文件或数据库句柄。
- Desktop main：复用现有 daemon client，负责 IPC 注册和错误转换。
- protocol：定义 `NoteRecord`、创建和更新输入、长度约束与错误类型。
- server：提供 notes HTTP route，不把便签伪装成 session 或 event。
- services：`NoteRepository` 直接操作 SQLite；不把全部便签加入 `SessionState`，不为每次输入写 session event。

第一版 API：

- `list(): Promise<NoteRecord[]>`
- `create({ content }): Promise<NoteRecord>`
- `update(id, { content, expectedRevision }): Promise<NoteRecord>`
- `remove(id): Promise<void>`

`list` 返回完整正文。第一版是单机、单窗口、轻量数据集，这能避免新增详情请求和缓存一致性层；第二期引入附件或大量内容时再拆分摘要与详情接口。

## 9. 一致性与恢复

### 9.1 修订号

更新执行条件是 `id` 与 `expectedRevision` 同时匹配；成功后 `revision + 1`。匹配不到时返回冲突，不允许旧请求覆盖新正文。

Renderer 为每条便签维护一个保存队列：同一时刻最多有一个请求在途；在途期间产生的新内容只保留最新待保存版本。响应到达后，只有响应内容仍对应当前保存版本时才能更新“已保存”状态。

### 9.2 临时恢复稿

SQLite 是业务真相。`localStorage` 只保存尚未确认写入 SQLite 的临时恢复稿，键名使用带版本的独立命名，例如 `vykor.desktop.note-recovery-v1`。键值是按 `noteId` 或本地草稿 ID 索引的恢复稿集合，避免一条保存失败的正文被下一条编辑覆盖。

恢复稿至少包含：

- `draftId`，本地生成并在恢复稿生命周期内保持稳定。
- `noteId`，新建草稿尚未创建成功时为 `null`。
- `baseRevision`。
- `content`。
- `updatedAt`。

某条便签保存成功且确认正文仍一致后，只清除对应恢复稿。应用启动时若发现恢复稿比 SQLite 内容新，先在编辑器恢复它并显示“已恢复未保存内容”，随后按正常自动保存流程处理；不静默丢弃或覆盖恢复稿。若存在多条恢复稿，列表逐条标记“待恢复”，用户进入后继续保存。

### 9.3 失败与冲突

- 加载失败：保留页面壳，显示错误和“重试”，不伪装成空列表。
- 保存失败：正文继续留在编辑器和恢复稿中，显示持久错误；用户可以重试或复制正文。
- 修订冲突：停止自动覆盖，提示“内容已在其他位置更新”。提供“重新载入”和“另存为新便签”，任何选项都不能先清空本地正文。
- 删除失败：保留便签和当前选择，关闭忙碌状态并显示错误。

## 10. 持久化与备份

便签复用 `~/.vykor/data/session-runtime/sessions.db`，不写入 `desktop-preferences.json`，也不混入 `desktop-session` Zustand Store。

现有 `SessionDatabase` 已启用 WAL、外键和迁移；现有应用备份会复制该数据库，因此新增表自然进入备份。迁移同时更新 schema inventory、迁移 journal 和数据库迁移测试。

## 11. 可访问性与键盘行为

- 左栏“便签”、新建、搜索、更多菜单和删除确认都有明确的可访问名称。
- 打开空白编辑器或新建便签后，焦点进入正文。
- 切换现有便签后，焦点进入正文但不强制移动滚动位置。
- 保存状态使用礼貌播报，不在每次按键时打断屏幕阅读器。
- 删除确认支持 Escape 取消，确认后焦点回到下一条便签或空白编辑器。
- 第一版不增加系统级或应用级便签快捷键，避免与现有 `Cmd/Ctrl+N` 新对话冲突。

## 12. 验收标准

1. 左栏不再显示“拉取请求”，点击“便签”会进入 `/notes` 并显示选中态。
2. 新建后可以立即输入；未输入内容就离开不会产生空白记录。
3. 有内容的便签在应用重启后仍存在，最后选择可恢复。
4. 快速连续输入、重复保存和切换便签不会发生旧内容覆盖新内容。
5. SQLite 写入失败时正文仍留在页面和恢复稿中，重试后可正常保存。
6. 应用在 300ms 自动保存窗口内异常退出后，重启能恢复最后输入。
7. 搜索能匹配标题所在首行和正文其余部分，清空搜索后恢复列表。
8. 已存在便签清空正文后仍保留为“无标题便签”，不会被隐式删除。
9. 删除前必须确认；删除失败时列表和正文不消失。
10. 数据库备份与恢复包含便签记录。

## 13. 测试范围

- protocol：输入校验、最大长度、修订冲突错误序列化。
- services：创建、更新、删除、排序、数据库重开、修订冲突和迁移。
- server / client：四个 notes 接口及错误映射。
- desktop IPC / preload：参数转发、返回类型和失败路径。
- Renderer：首次空状态、新建草稿、自动保存合并、切换补保存、搜索、删除确认、恢复稿和保存失败。
- 备份：备份后恢复数据库，便签内容与修订号保持一致。
- 现有回归：侧栏导航、路由生成、数据库 schema inventory 和桌面构建。

测试按改动范围执行，不重复运行与便签无关的完整套件。

## 14. 主要实现位置

- `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx`
- `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx`
- `apps/desktop/src/renderer/src/routes/_main.notes.tsx`
- `apps/desktop/src/renderer/src/components/desktop/notes-page/`
- `apps/desktop/src/shared/ipc-channels.ts`
- `apps/desktop/src/shared/desktop-api-contract.ts`
- `apps/desktop/src/preload/desktop-api.ts`
- `apps/desktop/src/main/features/notes/`
- `packages/protocol/src/`
- `packages/client/src/resources/`
- `packages/server/src/http/routes/`
- `packages/services/src/notes/`
- `packages/services/src/session-runtime/schema.ts`
- `packages/services/src/session-runtime/migrations/`

当前工作区在 shared IPC、protocol、server 和 SQLite schema 附近已有其他在途修改。实现时必须在现状上增量编辑，不覆盖或回退这些修改。
