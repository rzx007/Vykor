# 归档 Spec：TUI 前端迁移 ink → opentui（对齐 opencode 交互）

> 历史记录，禁止作为当前实现说明。本文描述的是 2026-06 的三进程 BackendHost/LegacyJSON 架构；该架构已退场。当前 TUI 启动与跨端协议见 [../../tui-flow.md](../../tui-flow.md) 和 [../../client-sync-flow.md](../../client-sync-flow.md)。

日期：2026-06-12
状态：已归档

## 背景与目标

`apps/frontend` 当前是 ink + React 18 的独立进程 TUI（约 2500 行），通过
`useBackendSession` 用 LegacyJSON/stdio 协议与后端（进程 A，Node）通信。

目标：把渲染引擎从 ink 换成 [opentui](https://github.com/anomalyco/opentui)，
并**全面对齐 opencode**（参考 rzx007-fork/opencode dev 分支 `packages/tui`）的
TUI 交互：居中 logo 首页、带框多行输入、ctrl+p 命令面板、栈式 dialog、
scrollbox 消息流、底部状态栏、toast。

已确认的三个关键决策：

1. **交互范围**：全面对齐 opencode（非仅换引擎）。
2. **框架绑定**：`@opentui/react`，保留 React 18 与现有 hooks 逻辑；
   不用 `@opentui/solid`（不重写为 Solid）。
3. **运行时**：前端进程改由 **Bun** 拉起（opentui 原生渲染器需要 Bun 或
   Node 26.3+`--experimental-ffi`）；后端进程仍跑 Node，协议不动。

## 范围

### 一期（本 spec）

- Home 首页：大 logo + 居中带框输入 + 提示行 + 底部状态栏
- Session 消息流：`<scrollbox stickyStart="bottom">` + 原生 `<markdown>`/`<code>`
- 底部状态栏 Footer：cwd:git 分支 · MCP 数 · `/status` 提示 · 版本号
- ctrl+p 命令面板：模糊搜索，与 `/` 自动补全、全局快捷键共用一个命令注册表
- 栈式 Dialog 系统：permission（y/a/n）、question（带输入）、后端 select
  request、`/permissions`、模型/主题选择统一收编
- `/` 斜杠命令自动补全浮窗
- 多行 textarea 输入：历史（↑↓，输入为空时）、粘贴
- Toast 通知（右上角，自动消隐）
- `tab` 循环权限模式（default→auto→plan），模式显示在输入框内
- TodoPanel / SwarmPanel 保留，融入 Session 布局（Prompt 上方，有内容才显示）

### 二期（明确不做）

插件 slot 系统、sidebar、diff viewer、`@` 文件补全、frecency 历史排序、
编辑器上下文嵌入、鼠标选区。

## 设计

### 1. 包与运行时

- `apps/frontend` 包保留。移除 `ink`、`ink-text-input`、`ink-testing-library`；
  新增 `@opentui/core`、`@opentui/react`。React 18 保留。
- tsconfig：`jsxImportSource` 改为 `@opentui/react`。
- `build.ts`：`Bun.build` target 从 `node` 改为 `bun`。
- `apps/cli/src/commands/main.ts`（约 L674）：`spawn(process.execPath, ...)`
  改为 `spawn("bun", [frontendDistPath], ...)`；启动前检测 bun 不存在则输出
  友好错误（含安装指引）并退出。
- 后端进程、LegacyJSON/stdio 协议、`--backend-only` 模式完全不动。

**风险门**：实施第一步先做 opentui hello-world 在 Windows（开发机）上的冒烟
验证（原生 Zig 库预编译产物可用性）；不通过则停下重新评估，不继续后续步骤。

### 2. 目录结构

```
src/
├── index.tsx               # createCliRenderer + createRoot(renderer).render(<App/>)
├── App.tsx                 # Provider 栈（Theme→Dialog→Toast）+ 路由切换
├── hooks/useBackendSession.ts   # 复用，仅适配性小改
├── ui/
│   ├── DialogContext.tsx   # 栈式 dialog：push/replace/close，esc 关顶层
│   ├── DialogSelect.tsx    # 通用选择器：模糊搜索 + 分类 + 键盘导航
│   └── Toast.tsx
├── keymap/commands.ts      # 命令注册表
├── routes/
│   ├── Home.tsx
│   └── session/
│       ├── Session.tsx     # scrollbox 消息流
│       ├── Footer.tsx
│       └── parts.tsx       # 消息渲染：markdown / 工具调用 / 错误
└── components/
    ├── prompt/Prompt.tsx        # <textarea> + 左竖线边框 + 模式/模型行
    ├── prompt/Autocomplete.tsx  # "/" 命令补全浮窗
    ├── Logo.tsx
    ├── TodoPanel.tsx
    └── SwarmPanel.tsx
```

删除的旧代码：`Markdown.tsx`、`markdownParser.ts`（及其测试）、
`ConversationView` 折叠逻辑（`foldTranscript`）、`ModalHost`、`SelectModal`、
`PromptInput`、`Spinner`（opentui 下重做或用 ascii 动画）。

### 3. 路由与布局

- transcript 为空 → **Home**：logo 居中、带框输入、`tab agents / ctrl+p
  commands` 提示行、底部状态栏。
- 首次提交后 → **Session**：消息流 flexGrow 占满、Prompt 沉底、Footer 固定
  底部；Todo/Swarm 面板在 Prompt 上方按需出现。

### 4. 命令注册表与按键

- 注册表条目：`{ id, title, keybinding?, run() }`。
- 两路来源：后端下发的斜杠命令列表（`session.commands`）+ 前端本地命令
  （主题切换、权限模式、退出等）。
- 三个消费方：ctrl+p 面板（DialogSelect）、`/` 自动补全、全局快捷键。
- 按键约定：`tab` 循环权限模式；`esc` 关顶层 dialog / 清空输入；`ctrl+c`
  退出（发送 shutdown）；`↑↓` 输入为空时翻历史。
- **不引入 `@opentui/keymap`**（面向 Solid 的深度定制），用
  `useKeyboard` + 自有注册表实现。

### 5. 弹层统一

- permission modal → 确认 dialog（y/a/n 快捷键，语义不变：once/session/拒绝）。
- question modal → 带输入框 dialog。
- 后端 select request、`/permissions`、模型/主题选择 → `DialogSelect`。
- Dialog 用绝对定位盒 + zIndex 居中覆盖（终端无半透明，不做压暗）。

### 6. 错误处理

- bun 缺失：CLI 启动前检测，友好报错退出。
- 渲染器创建失败（FFI/平台问题）：捕获并输出可读错误与诊断指引。
- 后端崩溃/退出：沿用 `useBackendSession` 现有处理。

### 7. 测试与验收

- 用 opentui 官方 test renderer 做帧快照测试：Home 渲染、消息流渲染、
  dialog 栈开关、命令面板过滤。
- `useBackendSession` 及协议层测试不动。
- 删除 ink-testing-library 与 markdownParser 测试。
- 手工验收路径：`vk` 启动 → Home → 提交消息 → 流式 markdown 渲染 →
  权限弹窗 y/a/n → ctrl+p 执行 `/theme` → tab 切模式 → ctrl+c 退出。
- 提交前单独跑 `pnpm check-types`（build/test 不含类型检查）。
