# Desktop 工作区三列布局重构设计

> 状态：设计已定稿（过三轮子代理审核：正确性/引用 + 简化/架构；审核记录见 [../reviews/2026-09-27-desktop-workspace-shell-three-column-layout-design-review.md](../reviews/2026-09-27-desktop-workspace-shell-three-column-layout-design-review.md)）。实现计划见 [../plans/2026-09-27-desktop-workspace-shell-three-column-layout.md](../plans/2026-09-27-desktop-workspace-shell-three-column-layout.md)。仅覆盖 Electron 桌面端主布局 `main-layout`（sidebar / conversation / utility 三列）的展开收起动画与首帧宽度。不改 daemon、协议、CLI/TUI、client，不改 `settings-layout`。

## 目标与现状

目标：主布局三列左（sidebar）、中（conversation）、右（utility）满足：

1. 每列都能拖拽改宽，宽度重启后保持。
2. 左右两列展开/收起带过渡动画（约 200ms），不是瞬间跳变。
3. 启动时三列直接以持久化宽度渲染，不出现"先默认宽再跳一下"。
4. 拖拽和窗口原生缩放不带过渡动画（避免跟手滞后与性能放大）。

现状（代码依据）：

- 三列都走 `react-resizable-panels` v4（`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx:211-318`）。外层 `Group` 管 `sidebar|workspace`，内层 `Group` 管 `conversation|utility`。
- 无动画：sidebar/utility 的 `Panel` 都没有 `flex-grow` 过渡；utility 只有 `transition-opacity duration-150`（`utility-panel.tsx:562`），收起时宽度瞬变、只有内容淡出。
- 首帧宽度不稳的真正原因，是持久化状态覆盖了首帧默认值，而不是 `preserve-pixel-size`：
  - sidebar：`defaultSize={288}`(px)（`main-layout.tsx:222`）会被 `useDefaultLayout("desktop-shell-layout")` 返回的**百分比 `defaultLayout`**（`:70-73`、`:216`）覆盖——RRP 的 Group `defaultLayout` 优先于面板 `defaultSize`。百分比是上次拖拽时按当时窗口宽快照的，窗口一变就还原成错误像素宽。随后 `onResize`（`:229-233`）和一个挂载后 RAF effect（`:103-114`）再各自补正 `--sidebar-width` 与 `sidebarOpen`，属事后修正。
  - utility：`useDefaultLayout("desktop-workspace-layout")`（`:74-77`，全局）与 `use-utility-panel-controller.ts` 自己的 `vykor.desktop.utility-panel-states`（按 scope，`:103-107`）**两处持久化并存**；挂载后还有 `group.setLayout(nextLayout)`（`:165-183`、`:307-320`）事后覆盖。

参考实现（ZCode，同一 `react-resizable-panels` v4 API）：`D:\code\personal-project\ZCode\packages\ui\src\app-shell\useAnimatedResizablePanel.ts`。它在**显式开合**时给面板元素临时加 `transition-[flex-grow] duration-200 ease-out`，调 `resize()/collapse()/expand()`，之后移除；窗口原生缩放不加过渡（注释 `:96-99` 记录了这个坑）。

## 选择及其边界

选择：**保留 RRP 三列**，只补两件事——展开收起过渡 + 修正首帧宽度。不引入自定义侧栏列。

评审结论（简化/架构审核）：ZCode 的 sidebar 之所以自建 CSS 变量列，是为了"拖拽/窗口缩放时不让侧栏大树每帧重渲染"。这是未在本仓实测的性能优化，且本仓当前 RRP sidebar 已经这么运行（`main-layout.tsx:229-233` 的 `onResize` 只写 CSS 变量、`setSidebarOpen` 在值不变时不触发重渲染）。为一个未验证的性能动机付出 4 个新文件 + 自定义 pointer/键盘/热区/a11y，属于过度设计。RRP v4 的像素尺寸（`defaultSize: number` = px）、`getSize().inPixels`、`resize()`、`groupResizeBehavior="preserve-pixel-size"` 已足够满足需求 1–3，拖拽与键盘由 `Separator` 自带。故 sidebar 不自建。

边界：只改 `main-layout` 及其 `utility-panel` 控制器、一个全局 CSS 规则、两个小工具模块；不改 `sidebar.tsx` 内容、不改 `title-bar.tsx` props 形状、不改 `settings-layout`；不引入新依赖；时长/缓动为常量。

其他做法不采用：

- 自建 sidebar 列（原方案 A）：见上，收益未证、成本过高。
- 常驻 `transition: flex-grow`：窗口原生缩放时 RRP 的 ResizeObserver 每帧产生中间尺寸，过渡会把中间帧放大成大量 layout 更新（ZCode `useAnimatedResizablePanel.ts:96-99`）。
- 给 `Panel` 加 `elementRef` 后逐个加/移除过渡类：可用，但"在 Group 上打一个属性 + 一条 CSS 规则"更少接线、幂等、好测。

## 行为契约

1. 结构不变：外层 `Group`（`sidebar|workspace`）与内层 `Group`（`conversation|utility`）保留；不新增自定义列或自定义手柄。sidebar 拖拽、键盘调整、`aria-*`、命中热区全部继续由 RRP `Separator` 提供。
2. sidebar 宽度用像素持久化：
   - 默认 288px、最小 266px、最大 420px（沿用现值）。
   - `defaultSize` 取"同步读到的持久化像素值 ?? 288"（在 render 期经 `useState` 初始化函数读取），首帧即目标宽度。
   - 删除外层 `useDefaultLayout("desktop-shell-layout")`，从而百分比不再覆盖像素 `defaultSize`。
   - 用户在 `Separator` 上拖拽/键盘改宽后，外层 `Group` 的 `onLayoutChanged(layout, meta)` 在 `meta.isUserInteraction === true` 且 `sidebarPanelRef.current.getSize().inPixels > 1` 时，持久化该像素值。窗口缩放（`isUserInteraction === false`）不写。
   - 持久化键 `vykor.desktop.workspace-sidebar-width-px`，值形如 `312`（原始十进制字符串）；脏数据回退默认值。
3. sidebar 展开/收起动画：`toggleSidebar` 调 `panel.expand()/collapse()` 前后，给外层 `Group` 元素加 `data-panel-animating="true"`；CSS 规则 `[data-panel-animating] > [data-panel] { transition: flex-grow 200ms ease-out }`（写在 `assets/main.css` 的 `@layer utilities`）。属性在约 240ms 后由定时器移除；`cancel()` 可提前移除。收起时 sidebar 的 `flex-grow` 归 0、`workspace` 面板同步让位，两列一起过渡。
   - **内容不重排**：开合过程中侧栏内容保持在展开宽度（`--sidebar-content-width`，动画期间不随面板变窄更新），由面板 `overflow: hidden` 裁剪；视觉上表现为右侧对话区滑过来覆盖它。只有指针/键盘实时改宽（`size.inPixels > 1` 且非动画中）才更新内容宽度。
4. utility 展开/收起动画：同机制，作用在内层 `Group`。`collapse()/restore()/toggleMaximized()` 等显式开合路径都包一层"加属性 → 调 imperative → 到时移除"。
5. 非开合路径不加过渡：窗口原生缩放、用户拖拽分隔线、切会话（scope 变更）应用已存布局时，属性必须不存在。切换 scope 的 `group.setLayout` 之前先 `cancel()`。
6. 首帧正确：外/内两个 `Group` 都不再使用 `useDefaultLayout`；首帧布局由同步状态得出：
   - 外层：sidebar `defaultSize` px，`workspace` 自动填充。
   - 内层 `defaultLayout` 三态（沿用现状）：`maximized → {conversation:0,utility:100}`、`open → 仓库内的 {conversation,utility}`、否则 `{conversation:100,utility:0}`。
   - RRP 挂载后不接受 `defaultLayout` 变更，故挂载后不得用 `setLayout` 去"修正"首帧布局。
7. 冷启动恢复宽度：
   - sidebar：靠 item 2 的像素 `defaultSize` 首帧到位。
   - utility `open`：靠 item 6 的 `defaultLayout` 首帧到位。
   - utility "上次收起但上次展开宽度已知"：RRP `collapse()` 只在同一次运行内记住 `expandToSize`，冷启动后丢失。首次 `restore()` 必须在**过渡启用下**直接把面板恢复到持久化尺寸（一次布局写入，落到 `lastOpenLayoutRef` 的 `utility` 值，而不是落到最小值），并沿用现有 `lastOpenLayoutRef`，不新增第二份宽度状态。
8. 单一持久化来源：utility 的 open/maximized/layout 以 `utility-panel-repository`（`vykor.desktop.utility-panel-states`）为唯一权威；删除全局 `useDefaultLayout("desktop-workspace-layout")` 及其转发。
9. 收起态不可拖出：sidebar 收起时不渲染 `Separator`（现状已如此）；utility 收起时不渲染其 `Separator`，并给 `Panel` 加 `disabled`（RRP v4 `Panel` 支持 `disabled`），避免从边缘拖出。
10. 单一切换点：`toggleSidebar`（按钮、`$mod+b`、菜单项）只切 sidebar；`togglePanel`（`$mod+j`）沿用现有 `utilityPanel.toggle`。二者在开合过程中以当前 `isCollapsed()`/`isCollapsed()` 判定，不做乐观翻转。
11. 自动收起：保留现有"窗口变窄自动收起 sidebar"语义。`use-utility-panel-controller` 在 `restore()` 需要收起 sidebar 时改为调用注入的 `onCollapseSidebar()` 回调，不再依赖 `PanelImperativeHandle`。
12. 无障碍：动画时长不需要单独处理 `prefers-reduced-motion`——全局规则 `:root[data-reduced-motion="true"] * { transition-duration: 0.01ms !important }`（`assets/main.css:804-811`）会覆盖。

## 连带影响与已知取舍

- `sidebarOpen` 仍由 `onResize`（`size.inPixels > 1`）推导为单一来源（`main-layout.tsx:231-232`）；删除挂载后 RAF 补正 effect（`:103-114`）。`title-bar.tsx`/`use-desktop-shortcuts`/`Sidebar` 接口形状不变。
- `--sidebar-width`（`main-layout.tsx:204,209`）继续写在外层 `contentRef` shell 上，供顶部阴影 `left: calc(var(--sidebar-width)+1px)`；收起时该值不参与过渡（阴影位置不动画），可接受。
- `use-utility-panel-controller` 选项变更：
  - `sidebarPanelRef: RefObject<PanelImperativeHandle>` → `onCollapseSidebar: () => void`。
  - 新增 `groupElementRef: RefObject<HTMLDivElement | null>`（内层 Group 的 DOM），供显式开合时加/去 `data-panel-animating`。
  - 删除 `onWorkspaceLayoutChanged`（其唯一来源是被删的 `useDefaultLayout`，`main-layout.tsx:92`，转发在 `handleLayoutChanged` `:329`）及其调用，否则留下无值可传的必填项。
  - 删除 `sidebarOpen` 选项（`:53,93`，仅用于让最大化 effect 依赖在 sidebar 开关时重跑，新结构不需要）。
- 删除外层 `useDefaultLayout("desktop-shell-layout")`（连带 `outerLayout`）、内层 `useDefaultLayout("desktop-workspace-layout")`（连带 `workspaceLayout`/`workspaceDefaultLayout`）。控制器的 `defaultLayout` 直接用常量 `defaultWorkspaceLayout`（`main-layout.tsx:36`）。
- utility 的 `minSize` 由 `panelOpen || utilityMaximized ? utilityMinimumWidth : 0` 改为常量 `utilityMinimumWidth`（`:292`）：`collapsible` + `collapsedSize={0}` 下常量最小值安全。`maxSize`（`utilityMaximized ? "100%" : "70%"`）与 conversation 的动态 `minSize`（`:272`）保留。
- `utility-panel.tsx` 的 `transition-opacity duration-150`（`:562`）保留为内容淡出，与宽度过渡同时进行。
- `main-layout-project-operation-error.test.ts` 的 `react-resizable-panels`/布局 mock（`:29-90`）需随新结构更新；渲染层测试需 `// @vitest-environment jsdom`。

## 实现位置

新增（放在 `main-layout/` 下，2 个文件）：

- `sidebar-width.ts`：常量（默认 288 / 最小 266 / 最大 420）+ 纯函数 `readStoredSidebarWidthPx(): number | null`、`clampSidebarWidthPx(width): number`、`persistSidebarWidthPx(width): void`。存原始十进制字符串。可单测。
- `panel-toggle-transition.ts`：`beginPanelToggleTransition(groupElement: HTMLElement | null): () => void`——加 `data-panel-animating="true"`、起 240ms 定时器移除、返回 `cancel()`（清定时器 + 移除属性）。纯 DOM 操作，可在 jsdom 单测（用 `vi.useFakeTimers()`）。

修改：

- `assets/main.css`：`@layer utilities` 增一条 `[data-panel-animating] > [data-panel] { transition: flex-grow 200ms ease-out; }`。
- `main-layout.tsx`：
  - sidebar `Panel.defaultSize` 改用 `sidebar-width.ts` 的同步像素值；删除外层 `useDefaultLayout` 与 RAF 补正 effect；外层 `Group` 增 `elementRef` 与 `onLayoutChanged`（按 item 2 持久化）。
  - `toggleSidebar` 用 `panel.expand()/collapse()` + `beginPanelToggleTransition(outerGroupElement)`。
  - 侧栏内容包一层固定宽度容器（`width: var(--sidebar-content-width)`），`Panel` 传 `style={{ overflow: "hidden" }}` 裁剪；`onResize` 仅在 `size.inPixels > 1` 且非 `data-panel-animating` 时更新该变量，实现 item 3 的"内容不重排"。
  - 内层 `Group` 增 `elementRef`（传给控制器）；其余 `defaultLayout`/`minSize`/`maxSize` 按连带影响调整。
- `utility-panel/use-utility-panel-controller.ts`：选项改造（见连带影响）；显式开合路径包 `beginPanelToggleTransition(groupElementRef.current)`；首次冷启动 `restore()` 在过渡下落到持久化尺寸；切 scope 的 `setLayout` 前 `cancel()`。
- `main-layout-project-operation-error.test.ts`：更新 mock。

不改：`sidebar.tsx`、`title-bar.tsx`、`panel-resize-handle.tsx`（其它用途 `files-tool.tsx`、`settings-layout.tsx` 不受影响）、`settings-layout.tsx`。

测试环境注意：`apps/desktop` 的 vitest 默认 node 环境，新增渲染层测试文件必须加 `// @vitest-environment jsdom`；jsdom 下不要依赖 `ResizeObserver`。

## 验收

1. 冷启动（清空 `vykor.desktop.*`）：三列以默认宽度一次成型，无可见跳动。
2. sidebar 拖到 360px、utility 拖到某宽度后重启：恢复为用户宽度，无跳动。
3. 上次收起 utility（但展开宽度已知）后重启，首次用 `$mod+j`/按钮展开：落到持久化宽度，不是 320px 最小值。
4. 上次最大化 utility 后重启：仍是最大化态；退出最大化恢复原分栏。
5. 收起/展开 sidebar（按钮、`$mod+b`、菜单）：宽度 200ms 过渡；过渡中再次触发不错乱；**侧栏内容不重排/不换行，像被对话区覆盖**。
6. 收起/展开 utility（按钮、`$mod+j`）：面板与中列 200ms 过渡，无瞬间跳变。
7. 开合动画未结束就切会话（scope 变更）：切换后的布局直接到位、不带动画。
8. 拖拽 sidebar 改宽：跟手无滞后（拖拽期间无过渡）；松手后宽度稳定并持久化。
9. 窗口原生缩放：三列不出现过渡动画，布局连续更新无抖动。
10. sidebar 收起时不可从边缘拖出；utility 收起时不可从边缘拖出；sidebar `Separator` 键盘（方向键）仍生效并持久化。
11. 窄窗口自动收起 sidebar 的现有行为不回归（控制器 `window.innerWidth < 1180` 分支）。
12. 单测：`sidebar-width` 夹取/读取/持久化、`panel-toggle-transition` 属性与定时器清理通过（`// @vitest-environment jsdom`）；`apps/desktop` 的 vitest 与 `pnpm --filter @vykor/desktop typecheck` 通过；`node scripts/check-docs.mjs` 通过。

## 风险

- RRP 的 `collapse()` 只在同一次运行内记住 `expandToSize`，冷启动首次展开依赖 item 7 的一次性恢复；这条路径必须有测试，否则静默回到最小值。
- 删除 `useDefaultLayout` 后，尺寸恢复完全依赖自管逻辑；需确认 RRP 的 `onLayoutChanged` 在拖拽松手时确实带 `isUserInteraction: true`（d.ts `:110-121`），以及键盘调整是否同样置真。
- 过渡靠 240ms 定时器清理；若 240ms 内触发多次开合，需保证定时器被 `cancel()` 重置（幂等）。
- `StrictMode` 双渲染（`apps/desktop/src/renderer/src/main.tsx`）下首帧读取可能跑两次，验收需在打包版确认观感。
- 保留 RRP sidebar 意味着拖拽时侧栏子树可能仍有重渲染开销；若实测卡顿，再按 ZCode 的 CSS 变量列单独优化（本设计不做）。

## 本阶段不做

- 自建 CSS 变量 sidebar 列（ZCode 风格）——仅在实测到拖拽卡顿后再评估。
- `settings-layout` 的同类 sidebar 改造。
- utility 面板内部 tab/文件/browser 逻辑调整。
- 三列宽度/开合状态的跨设备同步或迁移旧 RRP 持久化键。
