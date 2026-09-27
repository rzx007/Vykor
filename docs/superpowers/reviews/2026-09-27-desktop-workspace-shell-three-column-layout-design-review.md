# Desktop 工作区三列布局设计审核记录

**日期：** 2026-09-27
**审核对象：** [三列布局设计](../specs/2026-09-27-desktop-workspace-shell-three-column-layout-design.md)
**结果：** 两位独立子代理复审均报出阻断项，主线程已逐条修订进设计；本记录不是实现验收或真实界面测试报告。

## 第一轮发现及修订

| 问题 | 修订 |
|---|---|
| 冷启动"收起但上次宽度已知"时，`collapse()` 的 `expandToSize` 只在同一次运行内有效，首次 `restore()` 会落到 320px 最小值 | 行为契约新增 item 6：首次冷启动恢复保留一次性 `setLayout(nextLayout)` 并清除过渡；验收新增用例 3 |
| 最大化状态靠挂载后 `setLayout` 表达，而 item 5 又禁止挂载后 `setLayout`，会丢冷启动最大化态 | item 5 明确 `defaultLayout` 三态（maximized/open/collapsed），并给最大化与首次恢复各留一次例外；验收新增用例 4 |
| 移除外层 RRP Group 后拖拽热区从 ≥12/28px 缩到约 4px | 行为契约 item 2 增加命中层不小于 `resizeTargetMinimumSize` 的要求 |
| 开合动画未结束时切 scope，过渡类仍生效会把 scope 切换也动画化 | item 4 要求过渡返回 `cancel()`，在任何非开合布局写入前清除；验收新增用例 7 |
| 过渡同步机制描述错误（不是"整组过渡"本身，而是 RRP 每次都会重写兄弟面板 `flex-grow`） | 选择与 item 4 改为如实描述 RRP 重算整份布局、重写兄弟 flex-grow 的事实 |
| 误称本仓存在 `AnimatedTerminalPanel` | 连带影响改为描述本仓实际机制（`main-layout.tsx:287` 条件渲染 `Separator` + `Panel disabled`） |
| 删除 `useDefaultLayout("desktop-workspace-layout")` 会留下无值可传的必填 `onWorkspaceLayoutChanged` | 连带影响明确同步删除该选项与 `handleLayoutChanged` 的调用 |
| 新增渲染层测试缺少 `// @vitest-environment jsdom`，且 jsdom 无 `ResizeObserver` | 实现位置补充测试环境约束与禁用 `ResizeObserver` 的要求 |
| `minSize` 引用漏了 `|| utilityMaximized`；`onResize` 与挂载后 RAF 混为一谈；ZCode sidebar 行号范围不准 | 现状引用逐条改正 |

## 第二轮结论

- 技术正确性审查者确认：flex-grow 过渡在本组可行（RRP 会重算并重写兄弟面板 flex-grow）；常量 `minSize` 配合 `collapsible`/`collapsedSize=0` 安全，但需保留 utility 的 `maxSize` 与 conversation 的动态 `minSize`。
- 引用/集成审查者确认：`--sidebar-width`、`contentRef`、`sidebarPanelRef`、`workspaceGroupRef` 仅 `main-layout` 使用；`settings-layout` 自带一套隐藏 sidebar，设计已明确排除；`PanelResizeHandle` 保留自洽。
- 非阻断建议（已并入或记为后续）：统一 `onCollapseSidebar` 命名；sidebar 分离"展开宽度"与"CSS 宽度"；`--sidebar-width` 写在外层 shell 且收起时阴影不动画；`StrictMode` 下需在打包版复核观感。

## 第三轮：简化 / 架构审查（用户追加要求"不要过度设计"）

结论：原设计的"自建 CSS 变量 sidebar 列"属过度设计，已改为**保留 `react-resizable-panels` 三列**。要点：

| 问题 | 修订 |
|---|---|
| 自建 sidebar 列的正当性不足：其真实动机（拖拽/窗口缩放不重渲染侧栏树）在本仓未实测，且现状 RRP sidebar 已如此运行 | 放弃自建列，保留外层 `Group`；产出从 5 个新文件降到 2 个 |
| 首帧 bug 的根因被误述为 `preserve-pixel-size`；实为 `useDefaultLayout` 的**百分比** `defaultLayout` 覆盖了面板像素 `defaultSize` | 现状改为如实描述；修法是删除 `useDefaultLayout`、用像素 `defaultSize` |
| `sidebar-resize-state.ts` 是 ZCode 的死代码（其自定义事件无监听者） | 不再移植；改为在 Group 上打 `data-panel-animating` 属性 + 一条 CSS 规则 |
| `expandedWidthPx`/`cssWidthPx`/`isResizing` 冗余，`isResizing` 作为 React state 与"不重渲染"目标自相矛盾 | 删除；不再有自定义 resize 状态 |
| transitionend + 240ms 兜底双重清理 | 简化为单一 240ms 定时器 + `cancel()` |
| 契约项与验收项数量是"离开 RRP"的副产品（键盘、热区、a11y、disabled 都要自己补） | 回到 RRP 后这些自动满足，契约与验收相应瘦身 |
| 全局已有 `:root[data-reduced-motion="true"]` 过渡开关 | 明确 reduced-motion 无需单独处理 |

保留的正当复杂度：删除并存的 utility 双重持久化、过渡仅在显式开合期间启用、`--sidebar-width` 写在外层 shell、冷启动"收起但宽度已知"的一次性恢复、测试的 jsdom 注解。

修订后新文件：`main-layout/sidebar-width.ts`、`main-layout/panel-toggle-transition.ts`；另改 `assets/main.css` 一条规则。

## 后续执行约束

本轮只写设计与审核记录，未改动任何布局/控制器代码，未运行界面验收。实现计划见 [../plans/2026-09-27-desktop-workspace-shell-three-column-layout.md](../plans/2026-09-27-desktop-workspace-shell-three-column-layout.md)，含冷启动恢复、最大化恢复、快速开合后切 scope 三个易漏路径的测试。
