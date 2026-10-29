# 笔记页面

统一便签桌面、单层文件夹、详情编辑、自动保存和恢复。

## 放置边界

笔记相关的组件与模型放在一起；通用文件预览留在 tools/files。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [notes-page.tsx](notes-page.tsx)
- [use-notes-controller.ts](use-notes-controller.ts)
- [note-save-coordinator.ts](note-save-coordinator.ts)
- [note-board.tsx](note-board.tsx)：唯一拖拽上下文、桌面与夹内网格、悬停和取消。
- [note-folder.tsx](note-folder.tsx)：复用已有文件夹和轻量菜单，负责原位展开、重命名及解散。
- [use-note-organization.ts](use-note-organization.ts)：读取组织快照，串行保存整理操作；失败时撤销未确认操作并恢复位置。
- [note-organization.ts](note-organization.ts)：按持久顺序投影置顶便签、草稿和桌面，搜索时补充文件夹归属。
- [note-drag-state.ts](note-drag-state.ts)：只判断拖拽距离、连续悬停和越界，不读 DOM 或保存正文。

## 调用与状态归属

入口是 `NotesPage -> NoteBoard -> useNoteOrganization -> window.desktop.notes`。正文和恢复稿继续由 `useNotesController`、`NoteSaveCoordinator` 管理；整理操作通过公开客户端中的纯函数生成新快照，沿 IPC 和 HTTP 保存到便签目录的 `organization.json`。正文更新时间不参与桌面排序。

拖拽前的布局、来源和文件夹开合状态保存在 `NoteBoard` 内存中。`note-drag-state` 统一保存悬停目标、截止时间和当前意图，并提供下一次计时的剩余时间；`NoteBoard` 只安排计时器、检查 DOM 命中和展示合并目标，不重复维护完整意图。移动达到 6 px 才拿起；便签连续悬停 250 ms 才合并，文件夹连续悬停 400 ms 才展开；越过展开层边界 24 px 后收起。滚动或切换目标清零计时，松手才保存，Escape 恢复原布局。系统减少动态效果只关闭动画，不改变这些阈值。

键盘用空格拿起和放下，方向键选位置，Escape 取消；在目标便签上按 M 选择合并，夹内按 Alt + 左方向键返回桌面。文件夹名称允许同名，去除首尾空白后为 1–80 个 Unicode 字符。解散只将夹内便签按原顺序放回桌面，不删除正文。

组织保存与正文保存分别排队。窗口重新聚焦或已保存便签 ID 改变后读取组织；有整理操作未确认时延后刷新。保存失败取消后续未确认操作，并回读磁盘；重试从确认的布局执行一次。只读组织仍可打开正文，禁止整理。

置顶整理只回滚置顶字段，重试失败不会覆盖后来修改的纸色。合并成功直接返回本次创建的文件夹 ID，用于打开重命名入口，不按时间戳猜测目标。

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../AGENTS.md)。
