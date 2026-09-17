# Desktop 页面切换性能收敛实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让主窗口在对话页与设置页之间切换时保持会话监听，同时合并同一项目、同一范围的瞬时重复 Git 改动查询。

**架构：** 在根路由挂载一个不渲染界面的会话事件桥，主窗口生命周期内只维护一套现有 session listener，`/pet` 明确禁用。新增 renderer 内部的 Git 查询协调器，以规范化项目路径和 scope 为键合并在途请求、短暂复用成功结果；消息改动摘要与 Review 工具只改为调用该入口，仍各自管理展示状态。

**技术栈：** React 19、TanStack Router、Zustand、TypeScript、Vitest、jsdom、Electron renderer IPC

---

## 实施边界

本计划只允许完成设计文档中的优先项 1 和 5：会话监听生命周期上移、Git 查询去重。实施前从当前已批准规格所在提交创建专用 worktree；不要把当前工作区其他未提交改动带入实现分支。

不得顺带修改路由层级、保活对话 DOM、消息虚拟化、Markdown/代码高亮/Mermaid 渲染、Zustand selector、daemon 或 SSE 协议、Git 命令组成、文件系统监听、长期缓存和设置页其他 IPC。若最终仍有卡顿，只记录新的性能证据并另开任务。

## 文件与职责

- 创建：`apps/desktop/src/renderer/src/components/desktop/desktop-session-event-bridge.tsx`
  - 只负责 attach/detach 现有会话事件监听，并判断 `/pet` 是否禁用。
- 创建：`apps/desktop/src/renderer/src/components/desktop/desktop-session-event-bridge.test.tsx`
  - 锁定普通挂载、页面切换、卸载、StrictMode 和 `/pet` 行为。
- 修改：`apps/desktop/src/renderer/src/routes/__root.tsx`
  - 在不会随主页面/设置页切换而卸载的根路由挂载 bridge。
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx`
  - 删除原有 session listener effect，保留其他布局 effect。
- 创建：`apps/desktop/src/renderer/src/lib/git-changes-query.ts`
  - 提供唯一的 renderer Git changes 查询协调入口。
- 创建：`apps/desktop/src/renderer/src/lib/git-changes-query.test.ts`
  - 覆盖键隔离、并发合并、TTL、强制刷新与失败重试。
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message.tsx`
  - `ChangedFilesSummary` 改用共享查询入口；为了定向渲染测试导出该组件。
- 创建：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message.git-changes.test.tsx`
  - 验证多个摘要共用一次 IPC，且增删行数显示不变。
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/review-tool.tsx`
  - 初次加载使用共享入口，刷新按钮传 `force: true`。
- 创建：`apps/desktop/src/renderer/src/components/desktop/tools/review-tool.git-changes.test.tsx`
  - 验证初次加载、主动刷新绕过已完成缓存和错误展示。

### 任务 1：把会话监听提升到主窗口根生命周期

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/desktop/desktop-session-event-bridge.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/desktop-session-event-bridge.test.tsx`
- 修改：`apps/desktop/src/renderer/src/routes/__root.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx`

- [ ] **步骤 1：编写 bridge 的失败测试**

在测试中 mock `attachDesktopSessionEvents()`，用计数器表示当前有效监听数。测试同一个已启用 bridge 的 rerender 不重新 attach，禁用或卸载时 detach，StrictMode 稳定后只剩一个有效监听；同时验证路径判定。

```tsx
// @vitest-environment jsdom
import { StrictMode } from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const sessionEvents = vi.hoisted(() => ({
  active: 0,
  attach: vi.fn(() => {
    sessionEvents.active += 1
    return () => {
      sessionEvents.active -= 1
    }
  }),
}))

vi.mock("@renderer/stores/desktop-session", () => ({
  attachDesktopSessionEvents: sessionEvents.attach,
}))

import {
  DesktopSessionEventBridge,
  shouldAttachDesktopSessionEvents,
} from "./desktop-session-event-bridge"

describe("DesktopSessionEventBridge", () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    sessionEvents.active = 0
    sessionEvents.attach.mockClear()
    container = document.createElement("div")
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
  })

  it("keeps one listener set while enabled content rerenders", () => {
    act(() => root.render(<DesktopSessionEventBridge enabled />))
    act(() => root.render(<DesktopSessionEventBridge enabled />))
    expect(sessionEvents.attach).toHaveBeenCalledTimes(1)
    expect(sessionEvents.active).toBe(1)
  })

  it("cleans up when disabled", () => {
    act(() => root.render(<DesktopSessionEventBridge enabled />))
    act(() => root.render(<DesktopSessionEventBridge enabled={false} />))
    expect(sessionEvents.active).toBe(0)
  })

  it("leaves one effective listener set under StrictMode", () => {
    act(() => root.render(<StrictMode><DesktopSessionEventBridge enabled /></StrictMode>))
    expect(sessionEvents.active).toBe(1)
  })

  it("excludes only the pet window", () => {
    expect(shouldAttachDesktopSessionEvents("/pet")).toBe(false)
    expect(shouldAttachDesktopSessionEvents("/")).toBe(true)
    expect(shouldAttachDesktopSessionEvents("/settings/general")).toBe(true)
  })
})
```

- [ ] **步骤 2：运行定向测试，确认先失败**

运行：

```powershell
pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/desktop-session-event-bridge.test.tsx
```

预期：FAIL，提示无法找到 `./desktop-session-event-bridge`。

- [ ] **步骤 3：实现最小 bridge**

```tsx
import { useEffect } from "react"

import { attachDesktopSessionEvents } from "@renderer/stores/desktop-session"

export function shouldAttachDesktopSessionEvents(pathname: string): boolean {
  return pathname !== "/pet"
}

export function DesktopSessionEventBridge({ enabled }: { enabled: boolean }): null {
  useEffect(() => {
    if (!enabled) return
    return attachDesktopSessionEvents()
  }, [enabled])

  return null
}
```

在 `__root.tsx` 中通过 `useRouterState({ select: (state) => state.location.pathname })` 读取路径，在 `<Outlet />` 同级挂载：

```tsx
const pathname = useRouterState({ select: (state) => state.location.pathname })

<DesktopSessionEventBridge enabled={shouldAttachDesktopSessionEvents(pathname)} />
```

从 `main-layout.tsx` 删除 `attachDesktopSessionEvents` import 和只负责 attach/detach 的第一个 effect。不要删除 `useEffect` import，因为该文件的布局同步仍使用它。

- [ ] **步骤 4：运行测试和 renderer 类型检查**

运行：

```powershell
pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/desktop-session-event-bridge.test.tsx src/renderer/src/router.test.ts
pnpm --filter @openharness/desktop run typecheck:web
```

预期：两个测试文件 PASS；`typecheck:web` 退出码为 0。

- [ ] **步骤 5：提交独立变更**

```powershell
git add apps/desktop/src/renderer/src/components/desktop/desktop-session-event-bridge.tsx apps/desktop/src/renderer/src/components/desktop/desktop-session-event-bridge.test.tsx apps/desktop/src/renderer/src/routes/__root.tsx apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx
git commit -m "fix(desktop): keep session events across settings navigation"
```

### 任务 2：实现短周期 Git 查询协调器

**文件：**
- 创建：`apps/desktop/src/renderer/src/lib/git-changes-query.ts`
- 创建：`apps/desktop/src/renderer/src/lib/git-changes-query.test.ts`

- [ ] **步骤 1：编写查询规则的失败测试**

测试使用 deferred Promise 控制请求何时完成，并在每个用例后调用 `resetGitChangesQueryCacheForTests()`。至少包含以下断言：

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DesktopGitChangesInput } from "@shared/git-types"
import {
  queryGitChanges,
  resetGitChangesQueryCacheForTests,
} from "./git-changes-query"

const emptyResult = (rootPath: string) => ({
  rootPath,
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
})

describe("queryGitChanges", () => {
  afterEach(() => {
    resetGitChangesQueryCacheForTests()
    vi.useRealTimers()
  })

  it("shares an in-flight request for normalized root and scope", async () => {
    let resolveRequest!: (value: ReturnType<typeof emptyResult>) => void
    const changes = vi.fn(() => new Promise<ReturnType<typeof emptyResult>>((resolve) => {
      resolveRequest = resolve
    }))
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { git: { changes } },
    })

    const first = queryGitChanges({ rootPath: "D:\\repo\\", scope: "uncommitted" })
    const second = queryGitChanges({ rootPath: "d:/repo", scope: undefined })
    expect(changes).toHaveBeenCalledTimes(1)
    resolveRequest(emptyResult("D:/repo"))
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it("isolates different roots and scopes", async () => {
    const changes = vi.fn(({ rootPath }: DesktopGitChangesInput) =>
      Promise.resolve(emptyResult(rootPath))
    )
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { git: { changes } },
    })
    await Promise.all([
      queryGitChanges({ rootPath: "D:/one", scope: "uncommitted" }),
      queryGitChanges({ rootPath: "D:/two", scope: "uncommitted" }),
      queryGitChanges({ rootPath: "D:/one", scope: "staged" }),
    ])
    expect(changes).toHaveBeenCalledTimes(3)
  })

  it("reuses a fresh result, expires it, and lets force bypass it", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-17T00:00:00Z"))
    const changes = vi.fn(({ rootPath }: DesktopGitChangesInput) =>
      Promise.resolve(emptyResult(rootPath))
    )
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { git: { changes } },
    })
    const input = { rootPath: "D:/repo", scope: "uncommitted" as const }
    await queryGitChanges(input)
    await queryGitChanges(input)
    expect(changes).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1001)
    await queryGitChanges(input)
    await queryGitChanges(input, { force: true })
    expect(changes).toHaveBeenCalledTimes(3)
  })

  it("shares concurrent forced refreshes and does not cache failures", async () => {
    const failure = new Error("git failed")
    const changes = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(emptyResult("D:/repo"))
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { git: { changes } },
    })
    const input = { rootPath: "D:/repo", scope: "unstaged" as const }
    await expect(queryGitChanges(input)).rejects.toThrow("git failed")
    await expect(queryGitChanges(input)).resolves.toEqual(emptyResult("D:/repo"))

    resetGitChangesQueryCacheForTests()
    let resolveRequest!: (value: ReturnType<typeof emptyResult>) => void
    changes.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve }))
    const first = queryGitChanges(input, { force: true })
    const second = queryGitChanges(input, { force: true })
    expect(changes).toHaveBeenCalledTimes(3)
    resolveRequest(emptyResult("D:/repo"))
    await Promise.all([first, second])
  })
})
```

- [ ] **步骤 2：运行定向测试，确认先失败**

运行：

```powershell
pnpm --filter @openharness/desktop exec vitest run src/renderer/src/lib/git-changes-query.test.ts
```

预期：FAIL，提示无法找到 `./git-changes-query`。

- [ ] **步骤 3：实现协调器**

实现下列签名和规则。键中的 scope 必须把 `undefined` 规范化为 `uncommitted`；路径统一斜杠、删除尾部斜杠并转小写。优先返回在途 Promise，所以 `force: true` 也不会制造同键并发请求。成功时间取请求完成时刻；失败时删除该键，不能缓存异常。

```ts
import type {
  DesktopGitChangesInput,
  DesktopGitChangesResult,
  DesktopGitDiffScope,
} from "@shared/git-types"

const defaultMaxAgeMs = 1_000

type CacheEntry = {
  inFlight?: Promise<DesktopGitChangesResult>
  result?: DesktopGitChangesResult
  completedAt?: number
}

const entries = new Map<string, CacheEntry>()

export type GitChangesQueryOptions = {
  force?: boolean
  maxAgeMs?: number
}

function normalizedScope(scope: DesktopGitDiffScope | undefined): DesktopGitDiffScope {
  return scope ?? "uncommitted"
}

function normalizedRootPath(rootPath: string): string {
  return rootPath.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase()
}

function queryKey(input: DesktopGitChangesInput): string {
  return `${normalizedRootPath(input.rootPath)}\u0000${normalizedScope(input.scope)}`
}

export function queryGitChanges(
  input: DesktopGitChangesInput,
  options: GitChangesQueryOptions = {}
): Promise<DesktopGitChangesResult> {
  const key = queryKey(input)
  const current = entries.get(key)
  if (current?.inFlight) return current.inFlight

  const maxAgeMs = options.maxAgeMs ?? defaultMaxAgeMs
  if (
    !options.force &&
    current?.result &&
    current.completedAt !== undefined &&
    Date.now() - current.completedAt < maxAgeMs
  ) {
    return Promise.resolve(current.result)
  }

  const request = window.desktop.git.changes({
    ...input,
    scope: normalizedScope(input.scope),
  })
  const inFlight = request.then(
    (result) => {
      entries.set(key, { result, completedAt: Date.now() })
      return result
    },
    (error: unknown) => {
      entries.delete(key)
      throw error
    }
  )
  entries.set(key, { ...current, inFlight })
  return inFlight
}

export function resetGitChangesQueryCacheForTests(): void {
  entries.clear()
}
```

- [ ] **步骤 4：运行协调器测试和类型检查**

运行：

```powershell
pnpm --filter @openharness/desktop exec vitest run src/renderer/src/lib/git-changes-query.test.ts
pnpm --filter @openharness/desktop run typecheck:web
```

预期：测试 PASS；`typecheck:web` 退出码为 0。

- [ ] **步骤 5：提交独立变更**

```powershell
git add apps/desktop/src/renderer/src/lib/git-changes-query.ts apps/desktop/src/renderer/src/lib/git-changes-query.test.ts
git commit -m "feat(desktop): coordinate git changes queries"
```

### 任务 3：让文件改动摘要复用 Git 查询

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message.git-changes.test.tsx`

- [ ] **步骤 1：编写多个摘要的失败回归测试**

把 `ChangedFilesSummary` 改为 named export 仅用于定向测试。测试 mock store 中的项目路径，挂载两个相同项目的摘要；底层 `window.desktop.git.changes()` 返回 `src/a.ts` 的统计，等待两个 `setTimeout(0)` effect 完成后，断言只发生一次 IPC，且两个摘要都显示 `+4` 与 `-2`。

```tsx
// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { expect, it, vi } from "vitest"

vi.mock("@renderer/stores/desktop-session", () => ({
  useDesktopSessionStore: (selector: (state: unknown) => unknown) =>
    selector({ selectedProject: { path: "D:/repo" } }),
}))

import { resetGitChangesQueryCacheForTests } from "@renderer/lib/git-changes-query"
import { ChangedFilesSummary } from "./assistant-message"

it("shares one git request across changed-file summaries", async () => {
  const changes = vi.fn().mockResolvedValue({
    rootPath: "D:/repo",
    files: [{
      path: "src/a.ts",
      status: "modified",
      additions: 4,
      deletions: 2,
      binary: false,
    }],
    totalAdditions: 4,
    totalDeletions: 2,
  })
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { git: { changes } },
  })
  const container = document.createElement("div")
  const root: Root = createRoot(container)
  const props = {
    files: [{ path: "src/a.ts", additions: 0, deletions: 0, hasStats: false }],
    canOpenReview: true,
    onOpenFile: vi.fn(),
    onOpenReview: vi.fn(),
  }

  await act(async () => {
    root.render(<><ChangedFilesSummary {...props} /><ChangedFilesSummary {...props} /></>)
    await new Promise((resolve) => window.setTimeout(resolve, 10))
  })

  expect(changes).toHaveBeenCalledTimes(1)
  expect(container.textContent?.match(/\+4/g)).toHaveLength(2)
  expect(container.textContent?.match(/-2/g)).toHaveLength(2)
  act(() => root.unmount())
  resetGitChangesQueryCacheForTests()
})
```

若模块加载需要已有 UI provider，只 mock 该 provider 的最小返回值；不要为了测试改变产品组件结构。

- [ ] **步骤 2：运行回归测试，确认重复 IPC**

运行：

```powershell
pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/message/assistant-message.git-changes.test.tsx
```

预期：测试在实现接入前 FAIL，`changes` 实际调用 2 次。

- [ ] **步骤 3：接入共享查询入口**

在 `assistant-message.tsx` 导入 `queryGitChanges`，将唯一的直接调用替换为：

```ts
void queryGitChanges({
  rootPath: selectedProjectPath,
  scope: "uncommitted",
})
  .then((result) => {
    if (cancelled) return
    const stats: Record<string, ChangedFileStats> = {}
    for (const file of result.files) {
      if (file.additions === null && file.deletions === null) continue
      stats[normalizeReviewPath(file.path)] = {
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
      }
    }
    setGitStatsByPath(stats)
  })
  .catch(() => {
    if (cancelled) return
    setGitStatsByPath({})
  })
```

除增加 named export 外，不移动或重写 `ChangedFilesSummary`，不触碰消息解析和 Markdown 渲染。

- [ ] **步骤 4：运行摘要测试和已有消息模型测试**

运行：

```powershell
pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/message/assistant-message.git-changes.test.tsx src/renderer/src/components/desktop/conversation-page/message/message-render-model.test.ts
pnpm --filter @openharness/desktop run typecheck:web
```

预期：两个测试文件 PASS；类型检查退出码为 0。

- [ ] **步骤 5：提交独立变更**

```powershell
git add apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message.tsx apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message.git-changes.test.tsx
git commit -m "fix(desktop): deduplicate message git summaries"
```

### 任务 4：让 Review 工具共享查询并保留强制刷新

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/review-tool.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/tools/review-tool.git-changes.test.tsx`

- [ ] **步骤 1：编写主动刷新失败测试**

mock `queryGitChanges`、appearance provider 和 session store，返回空文件结果以避免加载 diff。首次 effect 应调用一次普通查询；点击 `aria-label="刷新改动"` 后必须再次调用，并且第二次 options 为 `{ force: true }`。再让刷新拒绝 `new Error("refresh failed")`，断言页面显示该错误。

```tsx
// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ queryGitChanges: vi.fn() }))
vi.mock("@renderer/lib/git-changes-query", () => ({
  queryGitChanges: mocks.queryGitChanges,
}))
vi.mock("@renderer/components/appearance/appearance-provider", () => ({
  useAppearance: () => ({ resolvedTheme: "light" }),
}))
vi.mock("@renderer/stores/desktop-session", () => ({
  useDesktopSessionStore: (selector: (state: unknown) => unknown) => selector({
    selectedProject: { path: "D:/repo" },
    sessionView: null,
  }),
}))

import { ReviewTool } from "./review-tool"

it("forces a fresh query from the refresh button and keeps errors visible", async () => {
  mocks.queryGitChanges.mockResolvedValue({
    rootPath: "D:/repo", files: [], totalAdditions: 0, totalDeletions: 0,
  })
  const container = document.createElement("div")
  const root: Root = createRoot(container)可以只带你跑，但是不要边跑边测，优先完成所有的编码任务，然后统一测试。
  await act(async () => {
    root.render(<ReviewTool />)
    await new Promise((resolve) => window.setTimeout(resolve, 10))
  })
  expect(mocks.queryGitChanges).toHaveBeenNthCalledWith(1, {
    rootPath: "D:/repo",
    scope: "uncommitted",
  }, { force: false })

  mocks.queryGitChanges.mockRejectedValueOnce(new Error("refresh failed"))
  const refresh = container.querySelector<HTMLButtonElement>('[aria-label="刷新改动"]')
  await act(async () => {
    refresh?.click()
    await Promise.resolve()
  })
  expect(mocks.queryGitChanges).toHaveBeenLastCalledWith({
    rootPath: "D:/repo",
    scope: "uncommitted",
  }, { force: true })
  expect(container.textContent).toContain("refresh failed")
  act(() => root.unmount())
})
```

- [ ] **步骤 2：运行回归测试，确认先失败**

运行：

```powershell
pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/tools/review-tool.git-changes.test.tsx
```

预期：FAIL，因为组件仍直接调用 `window.desktop.git.changes()`，mock 的协调器没有收到调用。

- [ ] **步骤 3：给 loadChanges 增加强制刷新参数并接入协调器**

保持现有过滤、active path、loading 和 error 逻辑，只改变查询入口与刷新参数：

```ts
const loadChanges = useCallback(async ({ force = false }: { force?: boolean } = {}): Promise<void> => {
  if (!selectedProjectPath) {
    setChanges(null)
    setLoadState("idle")
    return
  }

  setLoadState("loading")
  setError(null)
  try {
    const result = await queryGitChanges(
      {
        rootPath: selectedProjectPath,
        scope: gitScopeForRange(reviewRange),
      },
      { force }
    )
    const visibleResult =
      reviewRange === "last-turn"
        ? filterChangesByPaths(result, lastTurnFilePaths, selectedProjectPath)
        : result
    setChanges(visibleResult)
    setActivePath((current) =>
      current && visibleResult.files.some((file) => file.path === current)
        ? current
        : (visibleResult.files[0]?.path ?? null)
    )
    setLoadState("ready")
  } catch (loadError) {
    setError(errorMessage(loadError))
    setLoadState("error")
  }
}, [lastTurnFilePaths, reviewRange, selectedProjectPath])
```

自动加载和 open request 继续调用 `loadChanges()`；只有刷新按钮改为：

```tsx
onClick={() => void loadChanges({ force: true })}
```

- [ ] **步骤 4：运行 Review 测试、协调器测试和类型检查**

运行：

```powershell
pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/tools/review-tool.git-changes.test.tsx src/renderer/src/lib/git-changes-query.test.ts
pnpm --filter @openharness/desktop run typecheck:web
```

预期：两个测试文件 PASS；类型检查退出码为 0。

- [ ] **步骤 5：提交独立变更**

```powershell
git add apps/desktop/src/renderer/src/components/desktop/tools/review-tool.tsx apps/desktop/src/renderer/src/components/desktop/tools/review-tool.git-changes.test.tsx
git commit -m "fix(desktop): preserve review refresh semantics"
```

### 任务 5：定向回归与范围审计

**文件：**
- 检查：本计划“文件与职责”列出的全部文件
- 对照：`docs/superpowers/specs/2026-09-17-desktop-navigation-performance-design.md`

- [ ] **步骤 1：运行本次新增和直接相关的测试**

```powershell
pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/desktop-session-event-bridge.test.tsx src/renderer/src/lib/git-changes-query.test.ts src/renderer/src/components/desktop/conversation-page/message/assistant-message.git-changes.test.tsx src/renderer/src/components/desktop/conversation-page/message/message-render-model.test.ts src/renderer/src/components/desktop/tools/review-tool.git-changes.test.tsx src/renderer/src/router.test.ts
```

预期：全部 PASS，无未处理 Promise rejection 和 React `act` 警告。

- [ ] **步骤 2：运行 Desktop renderer 类型检查与 lint**

```powershell
pnpm --filter @openharness/desktop run typecheck:web
pnpm --filter @openharness/desktop exec eslint src/renderer/src/components/desktop/desktop-session-event-bridge.tsx src/renderer/src/components/desktop/desktop-session-event-bridge.test.tsx src/renderer/src/lib/git-changes-query.ts src/renderer/src/lib/git-changes-query.test.ts src/renderer/src/components/desktop/conversation-page/message/assistant-message.tsx src/renderer/src/components/desktop/conversation-page/message/assistant-message.git-changes.test.tsx src/renderer/src/components/desktop/tools/review-tool.tsx src/renderer/src/components/desktop/tools/review-tool.git-changes.test.tsx src/renderer/src/routes/__root.tsx src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx
```

预期：两条命令退出码均为 0。

- [ ] **步骤 3：确认直接 Git IPC 只有协调器持有**

```powershell
rg -n "window\.desktop\.git\.changes" apps/desktop/src/renderer/src
```

预期：产品代码只命中 `lib/git-changes-query.ts`；测试中的 mock 或断言可以命中。若发现新产品调用方，改为使用协调器，但不要扩展到其他 Git API。

- [ ] **步骤 4：审计实际改动没有越界**

```powershell
git diff --name-only 35367e96..HEAD
git diff --stat 35367e96..HEAD
```

预期：除本计划文档外，只出现“文件与职责”列出的 Desktop renderer 文件；不得出现 main process Git service、daemon、协议、消息渲染器或路由结构文件。`__root.tsx` 只增加 bridge，`main-layout.tsx` 只移除旧订阅 effect。

- [ ] **步骤 5：进行一次人工冒烟验证并记录结果**

启动现有 Desktop 开发模式，使用一个已有长对话完成以下检查：

1. 对话页进入任一设置子页，再返回对话页，消息和会话状态仍在。
2. 设置页停留期间产生的会话更新，返回后可见。
3. 打开 Review 后点击“刷新改动”，能读取最新 Git 状态。
4. 单独打开 `/pet` 窗口时，不出现 session 订阅相关调用或报错。

如果仍感到明显卡顿，只采集时间线或计数证据，不在本实现中追加优化。
