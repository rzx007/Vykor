# 普通会话侧边面板 Implementation Plan

> **For agentic workers:** Use subagent-driven-development task-by-task; implementers do not dispatch their own agents. 用户已确认下面的范围并要求开始，不再创建大型规格。工作区不提交、不改暂存区。

**Goal:** 在右侧使用普通会话完整聊天能力，感知左侧上下文，而不改变左侧任务。

**Architecture:** 复用普通 fork、辅助订阅、会话引用、Composer、Transcript、PermissionCard/AskUserCard。仅桌面端将共享动作从默认主会话扩展为可传目标会话；没有专用后端或运行模式。

**Tech Stack:** 已安装的 React、Zustand、Lexical、Base UI/shadcn 及现有 Desktop IPC。

**Spec:** 当前对话中用户批准的轻量方案，约束在本文件下一节完整列出。

## Global Constraints

- 只改桌面端，原估算 12–13 个生产文件；最终审核发现主聊天重载会清除辅助订阅，补一个 Desktop main 文件的小修，实际范围为 14 个。不得改 Core、Agent runtime、Server、Client、Protocol，不加依赖。
- 首次发送时使用 `window.desktop.sessions.fork({ sessionId: sourceId })`，不调用会导航的 Store `forkSession`。附件首次需要会话绑定时可以提前 fork，但不发送模型问题。
- fork 继承已有历史、工作目录与普通配置；后续用现有 conversation context item 引用主聊天。现有引用仅最近约 12,000 字符公开文字，不宣称同步全部新工具结果。
- 选区是浏览器实际选中的文字，不解析 Markdown 原文偏移，不做 SHA，不引入参考版本或特殊 metadata。
- 复用现有 Composer/Transcript、正常工具/插件/技能/附件/授权和压缩路径；不得重新强制纯文字。
- 打开菜单/面板不自动发送。点击菜单激活已有右侧 Tab；输入和滚动沿用主聊天组件。
- 发送、停止、授权与回执只更新明确目标会话；主 activeSessionId/sessionView/草稿不变。关闭面板只释放自己订阅。
- 保留用户其他 dirty/staged 修改。所有编辑用 apply_patch，Node 检查必须 --noEmit；无安装、真实模型、提交、合并或发布。

## Task 1: 共享桌面动作支持明确目标

**Files:** stores/desktop-session/{prompt-actions.ts,types.ts,session-view-actions.ts,prompt-actions.test.ts}，均在 apps/desktop/src/renderer/src 下。

**Interfaces:** `SubmitPromptOptions.target?: {sessionId:string;view:DesktopSessionView|null}`；`contextItems?: readonly SessionUserInputItem[]`。`interrupt(target?:同上)`；`replyPermission(permissionId,status,decision?,answer?,sessionId?)`。旧调用保持原行为。

- [x] 在真实 Store 的 prompt-actions.test.ts 补失败用例：主 A 保持运行时显式发给 B，结构化插件/技能/附件保留，停止和授权只给 B；失败重试沿用 ID；只清 B 原草稿，不覆盖后来编辑。
- [x] 运行单文件确认 RED；用现有实现扩展目标选择，不复制发送或回执状态机。
- [x] `contextItems` 加入发送 items，但草稿比较/清理仍基于原 `document`；用于主聊天引用，不新增 side 状态。
- [x] 辅助快照只对账对应 sessionRuntimes，不能更新主视图/模型/导航；旧主快照仍忽略。
- [x] 单文件 GREEN、web --noEmit、自查并写报告；独立任务审核后进入 Task 2。

示例实际行为：

```ts
await state.sendMessage('question', {
  document, target: {sessionId:'B', view:bView},
  contextItems:[{type:'context',kind:'conversation',id:'A',displayName:'主聊天'}],
})
expect(received.sessionId).toBe('B')
expect(store.getState().activeSessionId).toBe('A')
```

## Task 2: 面板与选区入口闭环

**Files:** 新增 components/desktop/tools/side-chat-panel.tsx；修改 conversation-page/conversation-page.tsx、layout/main-layout/{main-layout.tsx,main-layout-context.ts}、utility-panel/{utility-panel.tsx,utility-panel-tabs.ts,use-utility-panel-controller.ts}、components/ui/popover.tsx。测试新增 side-chat-panel.test.tsx 并扩展 controller 测试。

**Consumes:** Task 1 目标动作及辅助回执。**Produces:** `SideChatPanel`、`SideChatSelectionActions` 与 `openSideChat(sourceId,selectedText?)` 桌面入口；无新 IPC。

- [x] 补真实组件 RED：只打开不 fork/send；首次显式发送 fork 一次并订阅；原输入支持插件/技能/附件；授权用现有卡片；停止仅对应侧边 Run；关闭仅释放自身 subscriptionId。
- [x] 用普通 fork ID 保存桌面关联（按 source 区分的 UI 持久键即可），不用第二个 Store。fork 返回后先保存 ID，发送失败仍复用已有目标；分叉回复本身丢失不承诺超出普通 API 的幂等语义。
- [x] 草稿沿用 composerDraftsByScope。选段直接追加到侧边草稿；不覆盖主草稿。切 A/B 与晚到回调使用捕获的 source/目标，不能串到当前主会话。
- [x] 消费辅助快照必须匹配本次 subscriptionId、目标 ID 和非倒退 cursor；复用 MessageScroller/Transcript/Composer 与正常权限卡片。
- [x] 选区浮层 RED→GREEN 覆盖完整 mousedown→选词→mouseup→click，外部点击/Esc关闭、主消息更新不打断手势。只检查主消息区域，不处理编辑框选区。
- [x] 悬浮菜单唯一动作“在侧边聊天中提问”，无常驻“侧边提问/查看原文”按钮。使用实际选中文字，无哈希/源位置映射。
- [x] 小范围组件/Store/主聊天回归，web/node --noEmit；独立审核逻辑、边界和范围，记录原生窗口未验证项。

## Task 3: 最终验证与交付

- [x] 修正 Desktop main 的订阅生命周期：重开主聊天只替换主订阅，保留右侧辅助订阅；关闭窗口/明确关闭会话仍清理全部订阅。先补真实服务回归测试，再做最小修改。
- [x] 用本轮 baseline/current 对比确认无跨包生产改动，无用户改动被覆盖。
- [x] 主协调复跑受影响测试、web/node --noEmit、架构边界与文档检查；不以测试数量替代设计审核。
- [x] 最终独立审核只讨论已批准的普通会话方案及具体缺陷，不凭旧受限规格加回框架。
- [x] 报告实际文件数、验证结果和限制；保留未提交代码，不执行 Git 集成操作。
