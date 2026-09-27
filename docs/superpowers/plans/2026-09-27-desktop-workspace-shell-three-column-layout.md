# Desktop 工作区三列布局实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Electron 桌面端主布局三列（sidebar / conversation / utility）既能拖拽改宽、又能带动画地展开收起，并且重启后首帧就是持久化宽度、不跳动。

**Architecture:** 保留现有 `react-resizable-panels` v4 三列结构，不做自定义侧栏列。修法只有两点：(1) 删掉会覆盖首帧的 `useDefaultLayout`，sidebar 宽度改用像素 `defaultSize`（同步读 localStorage）+ `onLayoutChanged` 持久化；(2) 显式开合时在 `Group` 上打 `data-panel-animating` 属性，用一条 CSS 规则过渡 `flex-grow`，240ms 后移除。

**Tech Stack:** React 19、TypeScript、`react-resizable-panels@4.12.2`、Tailwind v4（`assets/main.css`）、Vitest（jsdom 按文件注解）。

**设计与依据：** [../specs/2026-09-27-desktop-workspace-shell-three-column-layout-design.md](../specs/2026-09-27-desktop-workspace-shell-three-column-layout-design.md)

## Global Constraints

- 不引入新依赖；不升级 `react-resizable-panels`。
- 只改主布局：`main-layout.tsx`、`utility-panel/use-utility-panel-controller.ts`、`assets/main.css`、新增两个模块。不改 `sidebar.tsx`、`title-bar.tsx`、`settings-layout.tsx`、`panel-resize-handle.tsx`。
- sidebar 宽度：默认 `288px`、最小 `266px`、最大 `420px`；持久化键 `vykor.desktop.workspace-sidebar-width-px`，存原始十进制字符串。
- 动画：`flex-grow 200ms ease-out`；清理定时器 `240ms`；只在显式开合期间启用。
- 新增渲染层测试文件必须首行写 `// @vitest-environment jsdom`。
- 所有测试与类型检查命令（在仓库根目录运行）：
  - 单个测试：`pnpm --filter @vykor/desktop exec vitest run <测试文件路径>`
  - 全部渲染层测试：`pnpm --filter @vykor/desktop exec vitest run`
  - 类型检查：`pnpm --filter @vykor/desktop typecheck`
  - 文档链接：`node scripts/check-docs.mjs`
- 提交信息用英文 Conventional Commits（与仓库现状一致）。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar-width.ts`（新增） | sidebar 宽度常量、读写 localStorage、夹取、持久化判定 |
| `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar-width.test.ts`（新增） | 上者单测 |
| `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/panel-toggle-transition.ts`（新增） | 在 Group 元素上启用/移除 `data-panel-animating` |
| `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/panel-toggle-transition.test.ts`（新增） | 上者单测 |
| `apps/desktop/src/renderer/src/assets/main.css`（修改） | `@layer utilities` 增一条 `[data-panel-animating] > [data-panel]` 规则 |
| `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx`（修改） | sidebar 像素默认值 + 持久化 + 动画；utility 单一持久化来源 + 动画接线 |
| `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/use-utility-panel-controller.ts`（修改） | 选项改造、开合包过渡、冷启动恢复、切 scope 取消过渡 |

---

## 开始前：提交设计文档

- [ ] 提交本轮 spec / plan / review 文档

```bash
git add docs/superpowers/specs/2026-09-27-desktop-workspace-shell-three-column-layout-design.md docs/superpowers/plans/2026-09-27-desktop-workspace-shell-three-column-layout.md docs/superpowers/reviews/2026-09-27-desktop-workspace-shell-three-column-layout-design-review.md
git commit -m "docs(desktop): specify and plan three-column layout"
```

---

## Task 1: sidebar 宽度存储模块

**Files:**
- Create: `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar-width.ts`
- Test: `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar-width.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces（后续 Task 4 依赖）：
  - `SIDEBAR_DEFAULT_WIDTH_PX = 288`、`SIDEBAR_MIN_WIDTH_PX = 266`、`SIDEBAR_MAX_WIDTH_PX = 420`
  - `clampSidebarWidthPx(width: number): number`
  - `readStoredSidebarWidthPx(): number | null`
  - `persistSidebarWidthPx(width: number): void`
  - `resolveSidebarDefaultWidthPx(): number`
  - `shouldPersistSidebarWidth(meta: { isUserInteraction: boolean }, inPixels: number): boolean`

- [ ] **Step 1: 写失败测试**

创建 `sidebar-width.test.ts`：

```ts
// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest"

import {
  SIDEBAR_DEFAULT_WIDTH_PX,
  SIDEBAR_MAX_WIDTH_PX,
  SIDEBAR_MIN_WIDTH_PX,
  clampSidebarWidthPx,
  persistSidebarWidthPx,
  readStoredSidebarWidthPx,
  resolveSidebarDefaultWidthPx,
  shouldPersistSidebarWidth,
} from "./sidebar-width"

const STORAGE_KEY = "vykor.desktop.workspace-sidebar-width-px"

beforeEach(() => {
  window.localStorage.clear()
})

describe("clampSidebarWidthPx", () => {
  it("clamps below the minimum", () => {
    expect(clampSidebarWidthPx(100)).toBe(SIDEBAR_MIN_WIDTH_PX)
  })

  it("clamps above the maximum", () => {
    expect(clampSidebarWidthPx(9999)).toBe(SIDEBAR_MAX_WIDTH_PX)
  })

  it("rounds to an integer pixel", () => {
    expect(clampSidebarWidthPx(320.6)).toBe(321)
  })

  it("falls back to the default for non-finite input", () => {
    expect(clampSidebarWidthPx(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH_PX)
  })
})

describe("readStoredSidebarWidthPx", () => {
  it("returns null when nothing is stored", () => {
    expect(readStoredSidebarWidthPx()).toBeNull()
  })

  it("reads and clamps a stored pixel value", () => {
    window.localStorage.setItem(STORAGE_KEY, "312")
    expect(readStoredSidebarWidthPx()).toBe(312)
  })

  it("ignores invalid values", () => {
    window.localStorage.setItem(STORAGE_KEY, "not-a-number")
    expect(readStoredSidebarWidthPx()).toBeNull()
    window.localStorage.setItem(STORAGE_KEY, "-5")
    expect(readStoredSidebarWidthPx()).toBeNull()
  })
})

describe("persistSidebarWidthPx", () => {
  it("writes a raw decimal string", () => {
    persistSidebarWidthPx(312.4)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("312")
  })
})

describe("resolveSidebarDefaultWidthPx", () => {
  it("uses the stored value when present", () => {
    window.localStorage.setItem(STORAGE_KEY, "300")
    expect(resolveSidebarDefaultWidthPx()).toBe(300)
  })

  it("falls back to the default", () => {
    expect(resolveSidebarDefaultWidthPx()).toBe(SIDEBAR_DEFAULT_WIDTH_PX)
  })
})

describe("shouldPersistSidebarWidth", () => {
  it("persists only for user interactions with a positive width", () => {
    expect(shouldPersistSidebarWidth({ isUserInteraction: true }, 312)).toBe(true)
    expect(shouldPersistSidebarWidth({ isUserInteraction: false }, 312)).toBe(false)
    expect(shouldPersistSidebarWidth({ isUserInteraction: true }, 0)).toBe(false)
    expect(shouldPersistSidebarWidth({ isUserInteraction: true }, Number.NaN)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/layout/main-layout/sidebar-width.test.ts`
Expected: FAIL，报 `Failed to resolve import "./sidebar-width"`。

- [ ] **Step 3: 写最小实现**

创建 `sidebar-width.ts`：

```ts
export const SIDEBAR_DEFAULT_WIDTH_PX = 288
export const SIDEBAR_MIN_WIDTH_PX = 266
export const SIDEBAR_MAX_WIDTH_PX = 420

const SIDEBAR_WIDTH_STORAGE_KEY = "vykor.desktop.workspace-sidebar-width-px"

export function clampSidebarWidthPx(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH_PX
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH_PX, Math.max(SIDEBAR_MIN_WIDTH_PX, width)))
}

export function readStoredSidebarWidthPx(): number | null {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    if (!raw) return null
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) return null
    return clampSidebarWidthPx(parsed)
  } catch {
    return null
  }
}

export function persistSidebarWidthPx(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidthPx(width)))
  } catch {
    // Sidebar width is best-effort UI state and must never interrupt the desktop app.
  }
}

export function resolveSidebarDefaultWidthPx(): number {
  return readStoredSidebarWidthPx() ?? SIDEBAR_DEFAULT_WIDTH_PX
}

export function shouldPersistSidebarWidth(
  meta: { isUserInteraction: boolean },
  inPixels: number
): boolean {
  return meta.isUserInteraction && Number.isFinite(inPixels) && inPixels > 1
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/layout/main-layout/sidebar-width.test.ts`
Expected: PASS（11 个用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar-width.ts apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar-width.test.ts
git commit -m "feat(desktop): add sidebar width store"
```

---

## Task 2: 面板开合过渡辅助

**Files:**
- Create: `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/panel-toggle-transition.ts`
- Test: `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/panel-toggle-transition.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces（Task 3、Task 4 依赖）：`beginPanelToggleTransition(groupElement: HTMLElement | null): () => void`。给它一个 `Group` 的 DOM 元素，它加上 `data-panel-animating="true"`，并在 240ms 后移除；返回的函数可立即移除（幂等）。

- [ ] **Step 1: 写失败测试**

创建 `panel-toggle-transition.test.ts`：

```ts
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"

import { beginPanelToggleTransition } from "./panel-toggle-transition"

afterEach(() => {
  vi.useRealTimers()
})

describe("beginPanelToggleTransition", () => {
  it("sets the animating attribute and removes it after the transition window", () => {
    vi.useFakeTimers()
    const group = document.createElement("div")

    beginPanelToggleTransition(group)

    expect(group.getAttribute("data-panel-animating")).toBe("true")
    vi.advanceTimersByTime(240)
    expect(group.hasAttribute("data-panel-animating")).toBe(false)
  })

  it("cancel removes the attribute immediately and is idempotent", () => {
    vi.useFakeTimers()
    const group = document.createElement("div")

    const cancel = beginPanelToggleTransition(group)
    cancel()

    expect(group.hasAttribute("data-panel-animating")).toBe(false)
    expect(() => cancel()).not.toThrow()
  })

  it("is a no-op for a missing element", () => {
    expect(() => beginPanelToggleTransition(null)()).not.toThrow()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/layout/main-layout/panel-toggle-transition.test.ts`
Expected: FAIL，报 `Failed to resolve import "./panel-toggle-transition"`。

- [ ] **Step 3: 写最小实现**

创建 `panel-toggle-transition.ts`：

```ts
const PANEL_ANIMATING_ATTRIBUTE = "data-panel-animating"
const PANEL_TOGGLE_TRANSITION_MS = 240

export function beginPanelToggleTransition(groupElement: HTMLElement | null): () => void {
  if (!groupElement) {
    return () => {}
  }

  const element = groupElement
  element.setAttribute(PANEL_ANIMATING_ATTRIBUTE, "true")

  let timer: number | null = window.setTimeout(() => {
    timer = null
    element.removeAttribute(PANEL_ANIMATING_ATTRIBUTE)
  }, PANEL_TOGGLE_TRANSITION_MS)

  return () => {
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
    element.removeAttribute(PANEL_ANIMATING_ATTRIBUTE)
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/layout/main-layout/panel-toggle-transition.test.ts`
Expected: PASS（3 个用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/renderer/src/components/desktop/layout/main-layout/panel-toggle-transition.ts apps/desktop/src/renderer/src/components/desktop/layout/main-layout/panel-toggle-transition.test.ts
git commit -m "feat(desktop): add panel toggle transition helper"
```

---

## Task 3: sidebar 像素默认值、持久化与开合动画

**Files:**
- Modify: `apps/desktop/src/renderer/src/assets/main.css`（`@layer utilities`，约 `:352-354`）
- Modify: `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx`（imports、常量 `:30-37`、refs `:63-67`、RAF effect `:103-114`、`toggleSidebar` `:116-128`、`renderPage` `:200-250`）
- Test: 复用 `main-layout-project-operation-error.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `sidebar-width.ts`；Task 2 的 `panel-toggle-transition.ts`。
- Produces（Task 4 依赖）：`sidebarTransitionCancelRef: RefObject<(() => void) | null>`、`outerGroupElementRef: RefObject<HTMLDivElement | null>`。

- [ ] **Step 1: 加 CSS 规则**

在 `apps/desktop/src/renderer/src/assets/main.css` 的 `@layer utilities {` 内、`.workspace-top-shadow { ... }` 之后插入：

```css
  [data-panel-animating] > [data-panel] {
    transition: flex-grow 200ms ease-out;
  }
```

- [ ] **Step 2: 更新 main-layout 的 import 与常量**

`main-layout.tsx` 顶部 `react-resizable-panels` 的 import 增加 `type LayoutChangedMeta`（本轮保留 `useDefaultLayout`，Task 4 再删）：

```ts
import {
  Group,
  Panel,
  type Layout,
  type LayoutChangedMeta,
  useDefaultLayout,
  useGroupRef,
  usePanelRef,
} from "react-resizable-panels"
```

在 import 区末尾增加：

```ts
import { beginPanelToggleTransition } from "./panel-toggle-transition"
import {
  SIDEBAR_MAX_WIDTH_PX,
  SIDEBAR_MIN_WIDTH_PX,
  persistSidebarWidthPx,
  resolveSidebarDefaultWidthPx,
  shouldPersistSidebarWidth,
} from "./sidebar-width"
```

删除这两个常量（其余不变）：

```ts
const sidebarDefaultWidth = 288
const sidebarMinimumWidth = 266
```

同时删除 `outerLayout` 定义（外层 Group 改用 `handleOuterLayoutChanged`，它不再被使用；`workspaceLayout` 本轮保留，Task 4 再删）：

```ts
  const outerLayout = useDefaultLayout({
    id: "desktop-shell-layout",
    panelIds: ["sidebar", "workspace"],
  })
```

- [ ] **Step 3: 增加 refs 与首帧默认宽度**

在 `MainLayout()` 内、`const contentRef = useRef<HTMLDivElement>(null)` 之后增加：

```ts
  const outerGroupElementRef = useRef<HTMLDivElement | null>(null)
  const sidebarTransitionCancelRef = useRef<(() => void) | null>(null)
  const [sidebarDefaultSizePx] = useState(resolveSidebarDefaultWidthPx)
```

- [ ] **Step 4: 用挂载清理替换 RAF 补正 effect**

把现有这段：

```ts
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const sidebarSize = sidebarPanelRef.current?.getSize()
      if (!sidebarSize) return
      contentRef.current?.style.setProperty("--sidebar-width", `${sidebarSize.inPixels}px`)
      setSidebarOpen((current) => {
        const nextOpen = sidebarSize.inPixels > 1
        return current === nextOpen ? current : nextOpen
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [sidebarPanelRef])
```

替换成：

```ts
  useEffect(
    () => () => {
      sidebarTransitionCancelRef.current?.()
      sidebarTransitionCancelRef.current = null
    },
    []
  )
```

- [ ] **Step 5: 新增持久化回调，改写 toggleSidebar**

把现有 `toggleSidebar`：

```ts
  const toggleSidebar = useCallback((): void => {
    const panel = sidebarPanelRef.current
    if (!panel) {
      setSidebarOpen((current) => !current)
      return
    }

    if (panel.isCollapsed()) {
      panel.expand()
    } else {
      panel.collapse()
    }
  }, [sidebarPanelRef])
```

替换成：

```ts
  const handleOuterLayoutChanged = useCallback(
    (_layout: Layout, meta: LayoutChangedMeta): void => {
      const size = sidebarPanelRef.current?.getSize()
      if (!size || !shouldPersistSidebarWidth(meta, size.inPixels)) return
      persistSidebarWidthPx(size.inPixels)
    },
    [sidebarPanelRef]
  )

  const toggleSidebar = useCallback((): void => {
    const panel = sidebarPanelRef.current
    if (!panel) {
      setSidebarOpen((current) => !current)
      return
    }

    sidebarTransitionCancelRef.current?.()
    sidebarTransitionCancelRef.current = beginPanelToggleTransition(outerGroupElementRef.current)
    if (panel.isCollapsed()) {
      panel.expand()
    } else {
      panel.collapse()
    }
  }, [sidebarPanelRef])
```

- [ ] **Step 6: 改写外层 Group / sidebar Panel**

`renderPage` 里的外层 `Group`：

```tsx
      <Group
        id="desktop-shell"
        orientation="horizontal"
        className="h-full min-h-0"
        resizeTargetMinimumSize={resizeTargetMinimumSize}
        defaultLayout={outerLayout.defaultLayout}
        onLayoutChanged={outerLayout.onLayoutChanged}
      >
```

替换成：

```tsx
      <Group
        id="desktop-shell"
        orientation="horizontal"
        className="h-full min-h-0"
        elementRef={outerGroupElementRef}
        resizeTargetMinimumSize={resizeTargetMinimumSize}
        onLayoutChanged={handleOuterLayoutChanged}
      >
```

sidebar `Panel`：

```tsx
        <Panel
          id="sidebar"
          panelRef={sidebarPanelRef}
          defaultSize={sidebarDefaultWidth}
          minSize={sidebarMinimumWidth}
          maxSize={420}
          collapsedSize={0}
          collapsible
          groupResizeBehavior="preserve-pixel-size"
          className="h-full min-h-0 overflow-hidden"
          onResize={(size) => {
            contentRef.current?.style.setProperty("--sidebar-width", `${size.inPixels}px`)
            const nextOpen = size.inPixels > 1
            setSidebarOpen((current) => (current === nextOpen ? current : nextOpen))
          }}
        >
```

替换成：

```tsx
        <Panel
          id="sidebar"
          panelRef={sidebarPanelRef}
          defaultSize={sidebarDefaultSizePx}
          minSize={SIDEBAR_MIN_WIDTH_PX}
          maxSize={SIDEBAR_MAX_WIDTH_PX}
          collapsedSize={0}
          collapsible
          groupResizeBehavior="preserve-pixel-size"
          className="h-full min-h-0 overflow-hidden"
          onResize={(size) => {
            contentRef.current?.style.setProperty("--sidebar-width", `${size.inPixels}px`)
            const nextOpen = size.inPixels > 1
            setSidebarOpen((current) => (current === nextOpen ? current : nextOpen))
          }}
        >
```

说明：本轮不要动 `renderConversationWorkspace` 与 controller 调用（`workspaceLayout` 与 `sidebarOpen` 仍被它们使用）。

- [ ] **Step 7: 运行类型检查与现有测试**

Run: `pnpm --filter @vykor/desktop typecheck`
Expected: PASS（`useDefaultLayout` 仍被 `workspaceLayout` 使用，import 不报未使用）。

Run: `pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/layout/main-layout/main-layout-project-operation-error.test.ts`
Expected: PASS（mock 的 `Group/Panel` 不转发 `elementRef`，过渡 helper 收到 `null` 走 no-op，不影响断言）。

- [ ] **Step 8: 提交**

```bash
git add apps/desktop/src/renderer/src/assets/main.css apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx
git commit -m "feat(desktop): persist and animate the sidebar width in pixels"
```

---

## Task 4: utility 单一持久化来源与开合动画

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx`（controller 调用 `:70-101`；`renderConversationWorkspace` `:252-319`）
- Modify: `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/use-utility-panel-controller.ts`
- Test: 复用 `main-layout-project-operation-error.test.ts`（controller 已被整体 mock）

**Interfaces:**
- Consumes: Task 1、Task 2；Task 3 的 `sidebarTransitionCancelRef`/`outerGroupElementRef`。
- Produces: `useUtilityPanelController` 新选项 `{ groupElementRef, onCollapseSidebar }`，删除 `{ sidebarPanelRef, sidebarOpen, onWorkspaceLayoutChanged }`。

- [ ] **Step 1: 改 main-layout 的 controller 调用与 inner Group**

删除 `workspaceLayout`：

```ts
  const workspaceLayout = useDefaultLayout({
    id: "desktop-workspace-layout",
    panelIds: ["conversation", "utility"],
  })
  const workspaceDefaultLayout = isOpenWorkspaceLayout(workspaceLayout.defaultLayout)
    ? workspaceLayout.defaultLayout
    : defaultWorkspaceLayout
```

并从 `react-resizable-panels` 的 import 中删除 `useDefaultLayout`（此时已无任何使用），删除本文件里不再被引用的 `isOpenWorkspaceLayout` 函数。

在 refs 区增加：

```ts
  const innerGroupElementRef = useRef<HTMLDivElement | null>(null)
```

**在 controller 调用之前**（`collapseSidebar` 要作为参数传进去，不能放到后面的 `toggleSidebar` 附近，否则 TDZ 报错）增加：

```ts
  const collapseSidebar = useCallback((): void => {
    sidebarTransitionCancelRef.current?.()
    sidebarTransitionCancelRef.current = beginPanelToggleTransition(outerGroupElementRef.current)
    sidebarPanelRef.current?.collapse()
  }, [sidebarPanelRef])
```

把 controller 调用：

```ts
  const utilityPanel = useUtilityPanelController({
    activeSessionId,
    selectedProjectId,
    sessionIds,
    sidebarOpen,
    defaultLayout: workspaceDefaultLayout,
    collapsedLayout: collapsedWorkspaceLayout,
    sidebarPanelRef,
    conversationPanelRef,
    utilityPanelRef,
    workspaceGroupRef,
    onWorkspaceLayoutChanged: workspaceLayout.onLayoutChanged,
  })
```

替换成：

```ts
  const utilityPanel = useUtilityPanelController({
    activeSessionId,
    selectedProjectId,
    sessionIds,
    defaultLayout: defaultWorkspaceLayout,
    collapsedLayout: collapsedWorkspaceLayout,
    conversationPanelRef,
    utilityPanelRef,
    workspaceGroupRef,
    groupElementRef: innerGroupElementRef,
    onCollapseSidebar: collapseSidebar,
  })
```

`renderConversationWorkspace` 的内层 `Group` 增加 `elementRef`：

```tsx
    <Group
      id="desktop-workspace"
      groupRef={workspaceGroupRef}
      elementRef={innerGroupElementRef}
      orientation="horizontal"
      className="h-full min-h-0 w-full"
      resizeTargetMinimumSize={resizeTargetMinimumSize}
      defaultLayout={
        utilityMaximized
          ? { conversation: 0, utility: 100 }
          : panelOpen
            ? visiblePanelLayout
            : collapsedWorkspaceLayout
      }
      onLayoutChanged={utilityPanel.handleLayoutChanged}
    >
```

utility `Panel` 改成常量 `minSize`，并在收起时 `disabled`：

```tsx
        minSize={utilityMinimumWidth}
        disabled={!panelOpen}
```

（删掉原来的 `minSize={panelOpen || utilityMaximized ? utilityMinimumWidth : 0}`；`maxSize={utilityMaximized ? "100%" : "70%"}` 与 conversation 的 `minSize={utilityMaximized ? 0 : conversationMinimumWidth}` 保持不变。`disabled` 只在收起时置真，避免从折叠边缘把面板拖出。）

- [ ] **Step 2: 改 controller 选项类型与 import**

`use-utility-panel-controller.ts` 顶部：

```ts
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import type {
  GroupImperativeHandle,
  Layout,
  LayoutChangedMeta,
  PanelImperativeHandle,
} from "react-resizable-panels"
```

改为：

```ts
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import type {
  GroupImperativeHandle,
  Layout,
  PanelImperativeHandle,
} from "react-resizable-panels"

import { beginPanelToggleTransition } from "../panel-toggle-transition"
```

`UseUtilityPanelControllerOptions`：

```ts
type UseUtilityPanelControllerOptions = {
  activeSessionId: string | null
  selectedProjectId: string | null
  sessionIds: string[]
  sidebarOpen: boolean
  defaultLayout: Layout
  collapsedLayout: Layout
  sidebarPanelRef: RefObject<PanelImperativeHandle | null>
  conversationPanelRef: RefObject<PanelImperativeHandle | null>
  utilityPanelRef: RefObject<PanelImperativeHandle | null>
  workspaceGroupRef: RefObject<GroupImperativeHandle | null>
  onWorkspaceLayoutChanged: (layout: Layout, meta: LayoutChangedMeta) => void
}
```

改为：

```ts
type UseUtilityPanelControllerOptions = {
  activeSessionId: string | null
  selectedProjectId: string | null
  sessionIds: string[]
  defaultLayout: Layout
  collapsedLayout: Layout
  conversationPanelRef: RefObject<PanelImperativeHandle | null>
  utilityPanelRef: RefObject<PanelImperativeHandle | null>
  workspaceGroupRef: RefObject<GroupImperativeHandle | null>
  groupElementRef: RefObject<HTMLDivElement | null>
  onCollapseSidebar: () => void
}
```

- [ ] **Step 3: 改解构、加过渡 ref 与工具函数**

函数签名解构：

```ts
export function useUtilityPanelController({
  activeSessionId,
  selectedProjectId,
  sessionIds,
  sidebarOpen,
  defaultLayout,
  collapsedLayout,
  sidebarPanelRef,
  conversationPanelRef,
  utilityPanelRef,
  workspaceGroupRef,
  onWorkspaceLayoutChanged,
}: UseUtilityPanelControllerOptions): UtilityPanelController {
```

改为：

```ts
export function useUtilityPanelController({
  activeSessionId,
  selectedProjectId,
  sessionIds,
  defaultLayout,
  collapsedLayout,
  conversationPanelRef,
  utilityPanelRef,
  workspaceGroupRef,
  groupElementRef,
  onCollapseSidebar,
}: UseUtilityPanelControllerOptions): UtilityPanelController {
```

在状态声明之后（`const [reviewRequest, setReviewRequest] = ...` 之后）增加：

```ts
  const toggleTransitionCancelRef = useRef<(() => void) | null>(null)

  const runAnimatedLayoutChange = useCallback(
    (apply: () => void): void => {
      toggleTransitionCancelRef.current?.()
      toggleTransitionCancelRef.current = beginPanelToggleTransition(groupElementRef.current)
      apply()
    },
    [groupElementRef]
  )

  useEffect(
    () => () => {
      toggleTransitionCancelRef.current?.()
      toggleTransitionCancelRef.current = null
    },
    []
  )
```

- [ ] **Step 4: 切 scope 时取消过渡**

在 scope 切换的 `useLayoutEffect` 里，`if (activeScopeIdRef.current === scopeId) return` 之后立刻插入：

```ts
    toggleTransitionCancelRef.current?.()
    toggleTransitionCancelRef.current = null
```

（位置在 `const previousScopeId = activeScopeIdRef.current` 之前。）

- [ ] **Step 5: restore / collapse 包过渡、修正冷启动恢复**

`restore`：

```ts
  const restore = useCallback((): void => {
    if (window.innerWidth < 1180) sidebarPanelRef.current?.collapse()
    const group = workspaceGroupRef.current
    const panel = utilityPanelRef.current
    const nextLayout = lastOpenLayoutRef.current ?? defaultLayout
    if (panel?.isCollapsed()) {
      panel.expand()
      window.requestAnimationFrame(() => group?.setLayout(nextLayout))
    }
    persistActiveView({ open: true })
    setOpen(true)
  }, [defaultLayout, persistActiveView, sidebarPanelRef, utilityPanelRef, workspaceGroupRef])
```

改为：

```ts
  const restore = useCallback((): void => {
    if (window.innerWidth < 1180) onCollapseSidebar()
    const group = workspaceGroupRef.current
    const panel = utilityPanelRef.current
    const nextLayout = lastOpenLayoutRef.current ?? defaultLayout
    runAnimatedLayoutChange(() => {
      if (panel?.isCollapsed()) {
        panel.expand()
        group?.setLayout(nextLayout)
      }
    })
    persistActiveView({ open: true })
    setOpen(true)
  }, [
    defaultLayout,
    onCollapseSidebar,
    persistActiveView,
    runAnimatedLayoutChange,
    utilityPanelRef,
    workspaceGroupRef,
  ])
```

`collapse`：

```ts
    previousLayoutRef.current = null
    persistActiveView({ open: false, maximized: false })
    setMaximized(false)
    setOpen(false)
    utilityPanelRef.current?.collapse()
  }, [persistActiveView, utilityPanelRef, workspaceGroupRef])
```

改为：

```ts
    previousLayoutRef.current = null
    persistActiveView({ open: false, maximized: false })
    setMaximized(false)
    setOpen(false)
    runAnimatedLayoutChange(() => {
      utilityPanelRef.current?.collapse()
    })
  }, [persistActiveView, runAnimatedLayoutChange, utilityPanelRef, workspaceGroupRef])
```

- [ ] **Step 6: 最大化 effect 包过渡并去掉 sidebarOpen 依赖**

把：

```ts
  useEffect(() => {
    const group = workspaceGroupRef.current
    if (!group) return

    window.requestAnimationFrame(() => {
      if (maximized) {
        conversationPanelRef.current?.collapse()
        group.setLayout({ conversation: 0, utility: 100 })
        return
      }

      conversationPanelRef.current?.expand()
      const previousLayout = previousLayoutRef.current
      if (previousLayout) {
        group.setLayout(previousLayout)
        previousLayoutRef.current = null
      }
    })
  }, [conversationPanelRef, maximized, sidebarOpen, workspaceGroupRef])
```

改为：

```ts
  useEffect(() => {
    const group = workspaceGroupRef.current
    if (!group) return

    runAnimatedLayoutChange(() => {
      window.requestAnimationFrame(() => {
        if (maximized) {
          conversationPanelRef.current?.collapse()
          group.setLayout({ conversation: 0, utility: 100 })
          return
        }

        conversationPanelRef.current?.expand()
        const previousLayout = previousLayoutRef.current
        if (previousLayout) {
          group.setLayout(previousLayout)
          previousLayoutRef.current = null
        }
      })
    })
  }, [conversationPanelRef, maximized, runAnimatedLayoutChange, workspaceGroupRef])
```

- [ ] **Step 7: handleLayoutChanged 去掉 meta 与转发**

```ts
  const handleLayoutChanged = useCallback(
    (nextLayout: Layout, meta: LayoutChangedMeta): void => {
      if (maximized || !isOpenLayout(nextLayout)) return
      lastOpenLayoutRef.current = nextLayout
      setLayout(nextLayout)
      persistActiveView({ layout: nextLayout })
      onWorkspaceLayoutChanged(nextLayout, meta)
    },
    [maximized, onWorkspaceLayoutChanged, persistActiveView]
  )
```

改为：

```ts
  const handleLayoutChanged = useCallback(
    (nextLayout: Layout): void => {
      if (maximized || !isOpenLayout(nextLayout)) return
      lastOpenLayoutRef.current = nextLayout
      setLayout(nextLayout)
      persistActiveView({ layout: nextLayout })
    },
    [maximized, persistActiveView]
  )
```

同时把 `UtilityPanelController` 类型里 `handleLayoutChanged: (layout: Layout, meta: LayoutChangedMeta) => void` 改为 `handleLayoutChanged: (layout: Layout) => void`。

- [ ] **Step 8: 类型检查与测试**

Run: `pnpm --filter @vykor/desktop typecheck`
Expected: PASS。

Run: `pnpm --filter @vykor/desktop exec vitest run`
Expected: PASS（`main-layout-project-operation-error.test.ts` 仍通过；controller 被 mock）。

- [ ] **Step 9: 提交**

```bash
git add apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/use-utility-panel-controller.ts
git commit -m "feat(desktop): animate utility panel and unify its layout persistence"
```

---

## Task 5: 全量验证与人工验收

**Files:**
- 无代码改动（除非验证发现问题）。

- [ ] **Step 1: 全量自动化验证**

Run: `pnpm --filter @vykor/desktop typecheck`
Run: `pnpm --filter @vykor/desktop exec vitest run`
Run: `node scripts/check-docs.mjs`
Expected: 全部 PASS。

- [ ] **Step 2: 打包版人工验收**

Run: `pnpm --filter @vykor/desktop build:unpack` 后启动产物（不要只跑 dev，`StrictMode` 会影响观感）。
逐条核对设计文档"验收" 1–11：

1. 清空 `vykor.desktop.*` 后冷启动：三列一次成型、无跳动。
2. 拖 sidebar、utility 到新宽度后重启：恢复用户宽度。
3. 收起 utility 后重启，首次展开落到持久化宽度（不是 320px）。
4. 最大化 utility 后重启仍是最大化；退出最大化恢复原分栏。
5. `$mod+b`/按钮/菜单开合 sidebar：200ms 过渡，中途重复触发不错乱。
6. `$mod+j` 开合 utility：过渡平滑。
7. 开合动画中切会话：切换后布局直接到位、不带动画。
8. 拖拽 sidebar 跟手无滞后；松手后稳定并持久化。
9. 窗口原生缩放：无过渡动画、无抖动。
10. sidebar/utility 收起时不可从边缘拖出；sidebar 分隔线键盘方向键可改宽并持久化。
11. 窄窗口自动收起 sidebar 行为不回归。

- [ ] **Step 3: 记录结果**

把人工验收结果补写到设计文档状态行或审核记录（如仍有未过项，先修再重新验证）。

- [ ] **Step 4: 提交（如有文档/修复改动）**

```bash
git add -A
git commit -m "docs(desktop): record three-column layout verification"
```
