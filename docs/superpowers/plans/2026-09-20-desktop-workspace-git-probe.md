# 项目外会话 git 探测统一与审阅可用性 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让「不在项目里」但工作目录是 git 仓库的会话也能使用审阅工具与 diff 统计，同时把「目录是不是 git 仓库」的判断收敛到唯一的只读 IPC 出口 `git:isRepository`。

**架构：** 主进程新增只读探测（复用 `git-service` 现有的 `resolveDirectory` + `runGit`）。渲染进程新增 `workspace-git-probe`（TTL 缓存，复用导出的 `normalizedRootPath`）与 `useActiveWorkspaceIsGit` hook：项目会话直接取 `selectedProjectGit`，项目外会话探测会话 cwd。审阅与 diff 统计的路径来源从 `state.selectedProject` 统一改为 `selectActiveWorkspaceProject`。

**技术栈：** TypeScript、Electron IPC、React 19、Zustand、Vitest、pnpm。

**规格：** `docs/superpowers/specs/2026-09-20-desktop-workspace-git-probe-design.md`

## 全局约束

- 新增 IPC 通道名必须是 `"git:is-repository"`，常量名 `gitIsRepository`。
- 共享类型名必须是 `DesktopGitIsRepositoryInput` 与 `DesktopGitIsRepositoryResult`。
- `DesktopGitIsRepositoryResult` 精确为 `{ isRepository: boolean; rootPath: string | null }`。
- 新增 hook 名必须是 `useActiveWorkspaceIsGit`，返回值类型 `boolean | null`（`null` = 尚未判定）。
- 探测缓存 TTL 必须取 `1000`（与 `git-changes-query.ts` 的 `defaultMaxAgeMs` 一致）。
- 缓存键必须复用 `git-changes-query.ts` 导出的 `normalizedRootPath`，不得复制实现。
- 探测输入必须是工作区路径（项目外会话即 `session.cwd`），返回的 `rootPath` 绝不作为 `git.changes` 的 `rootPath`。
- `git:isRepository` 对目录不存在、非目录、非仓库、git 不可用一律返回 `isRepository: false`，**不抛异常**。
- 探测失败（IPC 抛错）返回 `false` 且**不写缓存**。
- 不得修改 `helpers.ts` 的 `resolveSessionWorkspace`、`new-conversation-start.tsx`、`session-operations.ts`、`review-tool.tsx` 的范围选项集合与默认值、`packages/*`。
- 不得调用 `client.projects.inspect` 或任何会写 `project` 表的路径。

---

### 任务 1：主进程只读探测与 IPC 通道

**文件：**
- 修改：`apps/desktop/src/shared/git-types.ts`
- 修改：`apps/desktop/src/shared/ipc-channels.ts`（常量区 `:234-235` 附近、`IpcInvokeMap` `:652-655` 之后）
- 修改：`apps/desktop/src/shared/desktop-api-contract.ts`（`git` 对象 `:194-197`）
- 修改：`apps/desktop/src/preload/desktop-api.ts`（`git` 对象 `:84-89`）
- 修改：`apps/desktop/src/main/features/git/git-service.ts`
- 修改：`apps/desktop/src/main/features/git/ipc.ts`
- 创建：`apps/desktop/src/main/features/git/git-service.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `apps/desktop/src/main/features/git/git-service.test.ts`：

```ts
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { gitService } from "./git-service"

const execFileAsync = promisify(execFile)

let repoRoot: string
let plainDir: string

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "oh-git-probe-"))
  repoRoot = join(base, "repo")
  plainDir = join(base, "plain")
  const { mkdir } = await import("node:fs/promises")
  await mkdir(repoRoot, { recursive: true })
  await mkdir(plainDir, { recursive: true })
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repoRoot })
  await writeFile(join(plainDir, "readme.txt"), "not a repo", "utf8")
})

afterAll(async () => {
  if (repoRoot) await rm(join(repoRoot, ".."), { recursive: true, force: true })
})

describe("gitService.isRepository", () => {
  it("reports true and the repository root for a git working tree", async () => {
    await expect(gitService.isRepository({ path: repoRoot })).resolves.toEqual({
      isRepository: true,
      rootPath: expect.any(String),
    })
  })

  it("reports true from a subdirectory inside the repository", async () => {
    const { mkdir } = await import("node:fs/promises")
    const nested = join(repoRoot, "packages", "app")
    await mkdir(nested, { recursive: true })

    const result = await gitService.isRepository({ path: nested })

    expect(result.isRepository).toBe(true)
    expect(result.rootPath?.replace(/\\/g, "/").toLowerCase()).toBe(
      repoRoot.replace(/\\/g, "/").toLowerCase()
    )
  })

  it("reports false without throwing for a directory that is not a repository", async () => {
    await expect(gitService.isRepository({ path: plainDir })).resolves.toEqual({
      isRepository: false,
      rootPath: null,
    })
  })

  it("reports false without throwing for a missing directory", async () => {
    await expect(gitService.isRepository({ path: join(plainDir, "missing") })).resolves.toEqual({
      isRepository: false,
      rootPath: null,
    })
  })

  it("reports false without throwing for an empty path", async () => {
    await expect(gitService.isRepository({ path: "   " })).resolves.toEqual({
      isRepository: false,
      rootPath: null,
    })
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/desktop exec vitest run src/main/features/git/git-service.test.ts`
预期：FAIL，报错 `gitService.isRepository is not a function`。

- [ ] **步骤 3：新增共享类型**

在 `apps/desktop/src/shared/git-types.ts` 末尾追加：

```ts
export interface DesktopGitIsRepositoryInput {
  path: string
}

export interface DesktopGitIsRepositoryResult {
  isRepository: boolean
  rootPath: string | null
}
```

- [ ] **步骤 4：注册 IPC 通道常量与映射**

在 `apps/desktop/src/shared/ipc-channels.ts` 的 `gitFileDiff: "git:file-diff",` 下一行加：

```ts
  gitIsRepository: "git:is-repository",
```

在 `IpcChannels` 类型导入区（`:80-83` 附近）加入 `DesktopGitIsRepositoryInput`、`DesktopGitIsRepositoryResult`，并在 `[IpcChannels.gitFileDiff]` 条目后加：

```ts
  [IpcChannels.gitIsRepository]: {
    args: [input: DesktopGitIsRepositoryInput]
    result: DesktopGitIsRepositoryResult
  }
```

- [ ] **步骤 5：暴露到 contract 与 preload**

在 `apps/desktop/src/shared/desktop-api-contract.ts` 的 `git` 对象里加：

```ts
    isRepository: (input: DesktopGitIsRepositoryInput) => Promise<DesktopGitIsRepositoryResult>
```

（同时在文件顶部的类型导入里加入这两个名字。）

在 `apps/desktop/src/preload/desktop-api.ts` 的 `git` 对象里加：

```ts
    isRepository: (input: IpcInvokeMap[typeof IpcChannels.gitIsRepository]["args"][0]) =>
      invoke(IpcChannels.gitIsRepository, input),
```

- [ ] **步骤 6：实现探测**

在 `apps/desktop/src/main/features/git/git-service.ts` 的 `GitService` 类里，`changes` 方法之前加入：

```ts
  async isRepository(input: DesktopGitIsRepositoryInput): Promise<DesktopGitIsRepositoryResult> {
    try {
      const path = await resolveDirectory(input.path)
      const stdout = await runGit(path, ["rev-parse", "--show-toplevel"])
      const rootPath = stdout.trim()
      return rootPath
        ? { isRepository: true, rootPath }
        : { isRepository: false, rootPath: null }
    } catch {
      return { isRepository: false, rootPath: null }
    }
  }
```

在文件顶部的类型导入清单里加入 `DesktopGitIsRepositoryInput`、`DesktopGitIsRepositoryResult`。

- [ ] **步骤 7：注册 IPC handler**

在 `apps/desktop/src/main/features/git/ipc.ts` 的 `gitFileDiff` 条目后加：

```ts
      {
        channel: IpcChannels.gitIsRepository,
        handler: (_event, input) => gitService.isRepository(input as DesktopGitIsRepositoryInput),
      },
```

并在类型导入行加入 `DesktopGitIsRepositoryInput`。

- [ ] **步骤 8：运行测试验证通过**

运行：`pnpm --filter @openharness/desktop exec vitest run src/main/features/git/git-service.test.ts`
预期：PASS，5 个用例全绿。

- [ ] **步骤 9：类型检查**

运行：`pnpm --filter @openharness/desktop run typecheck`
预期：通过。

- [ ] **步骤 10：Commit**

```bash
git add apps/desktop/src/shared/git-types.ts apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/shared/desktop-api-contract.ts apps/desktop/src/preload/desktop-api.ts apps/desktop/src/main/features/git/git-service.ts apps/desktop/src/main/features/git/ipc.ts apps/desktop/src/main/features/git/git-service.test.ts
git commit -m "feat(desktop): add read-only git repository probe over IPC"
```

---

### 任务 2：渲染进程探测缓存

**文件：**
- 修改：`apps/desktop/src/renderer/src/lib/git-changes-query.ts`（导出 `normalizedRootPath`）
- 创建：`apps/desktop/src/renderer/src/lib/workspace-git-probe.ts`
- 创建：`apps/desktop/src/renderer/src/lib/workspace-git-probe.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `apps/desktop/src/renderer/src/lib/workspace-git-probe.test.ts`：

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  probeWorkspaceGit,
  resetWorkspaceGitProbeCacheForTests,
} from "./workspace-git-probe"

function installProbe(isRepository: boolean | (() => Promise<never>)) {
  const probe = vi.fn(async () => {
    if (typeof isRepository === "function") return await isRepository()
    return { isRepository, rootPath: isRepository ? "D:/repo" : null }
  })
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: { git: { isRepository: probe } },
  })
  return probe
}

describe("probeWorkspaceGit", () => {
  afterEach(() => {
    resetWorkspaceGitProbeCacheForTests()
    vi.useRealTimers()
  })

  it("calls the IPC probe once and reuses the cached result within the TTL", async () => {
    const probe = installProbe(true)

    await expect(probeWorkspaceGit("D:\\Repo\\")).resolves.toBe(true)
    await expect(probeWorkspaceGit("D:/repo")).resolves.toBe(true)

    expect(probe).toHaveBeenCalledTimes(1)
  })

  it("re-probes after the TTL expires", async () => {
    vi.useFakeTimers()
    const probe = installProbe(true)

    await probeWorkspaceGit("D:/repo")
    vi.advanceTimersByTime(1_001)
    await probeWorkspaceGit("D:/repo")

    expect(probe).toHaveBeenCalledTimes(2)
  })

  it("caches each path independently", async () => {
    const probe = installProbe(true)

    await probeWorkspaceGit("/work/One")
    await probeWorkspaceGit("/work/Two")

    expect(probe).toHaveBeenCalledTimes(2)
  })

  it("returns false and does not cache when the IPC probe rejects", async () => {
    const probe = installProbe(() => Promise.reject(new Error("ipc down")))

    await expect(probeWorkspaceGit("D:/repo")).resolves.toBe(false)
    await expect(probeWorkspaceGit("D:/repo")).resolves.toBe(false)

    expect(probe).toHaveBeenCalledTimes(2)
  })

  it("returns false without probing for an empty path", async () => {
    const probe = installProbe(true)

    await expect(probeWorkspaceGit("   ")).resolves.toBe(false)
    expect(probe).not.toHaveBeenCalled()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/desktop exec vitest run src/renderer/src/lib/workspace-git-probe.test.ts`
预期：FAIL，报错无法解析模块 `./workspace-git-probe`。

- [ ] **步骤 3：导出 `normalizedRootPath`**

在 `apps/desktop/src/renderer/src/lib/git-changes-query.ts` 中把 `function normalizedRootPath` 改为 `export function normalizedRootPath`，其余不动。

- [ ] **步骤 4：实现探测缓存**

创建 `apps/desktop/src/renderer/src/lib/workspace-git-probe.ts`：

```ts
import { normalizedRootPath } from "./git-changes-query"

const defaultMaxAgeMs = 1_000

type ProbeEntry = {
  inFlight?: Promise<boolean>
  result?: boolean
  completedAt?: number
}

const entries = new Map<string, ProbeEntry>()

export async function probeWorkspaceGit(path: string): Promise<boolean> {
  if (!path.trim()) return false

  const key = normalizedRootPath(path)
  const current = entries.get(key)
  if (current?.inFlight) return current.inFlight

  if (
    current?.result !== undefined &&
    current.completedAt !== undefined &&
    Date.now() - current.completedAt < defaultMaxAgeMs
  ) {
    return current.result
  }

  const request = window.desktop.git
    .isRepository({ path })
    .then((response) => {
      const result = response.isRepository
      entries.set(key, { result, completedAt: Date.now() })
      return result
    })
    .catch(() => {
      entries.delete(key)
      return false
    })
    .finally(() => {
      const settled = entries.get(key)
      if (settled?.inFlight === request) {
        entries.set(key, {
          ...(settled.result !== undefined ? { result: settled.result } : {}),
          ...(settled.completedAt !== undefined ? { completedAt: settled.completedAt } : {}),
        })
      }
    })

  entries.set(key, { ...current, inFlight: request })
  return request
}

export function resetWorkspaceGitProbeCacheForTests(): void {
  entries.clear()
}
```

注意：`.catch` 分支返回 `false` 且已 `delete` 缓存键，因此失败不会被缓存（测试用两次调用来断言）。`.finally` 负责清掉 `inFlight`，避免成功的 Promise 永久占据去重槽。

- [ ] **步骤 5：运行测试验证通过**

运行：`pnpm --filter @openharness/desktop exec vitest run src/renderer/src/lib/workspace-git-probe.test.ts`
预期：PASS，5 个用例全绿。

- [ ] **步骤 6：回归 `git-changes-query`**

运行：`pnpm --filter @openharness/desktop exec vitest run src/renderer/src/lib/git-changes-query.test.ts`
预期：PASS（确认导出改动没破坏原行为）。

- [ ] **步骤 7：Commit**

```bash
git add apps/desktop/src/renderer/src/lib/git-changes-query.ts apps/desktop/src/renderer/src/lib/workspace-git-probe.ts apps/desktop/src/renderer/src/lib/workspace-git-probe.test.ts
git commit -m "feat(desktop): cache workspace git probe with TTL"
```

---

### 任务 3：`useActiveWorkspaceIsGit` hook

**文件：**
- 创建：`apps/desktop/src/renderer/src/hooks/use-active-workspace-is-git.ts`
- 创建：`apps/desktop/src/renderer/src/hooks/use-active-workspace-is-git.test.ts`

注意：`apps/desktop/src/renderer/src/hooks/` 目录当前不存在，步骤 4 会创建。hook 测试需要渲染 React，参照仓库现有做法：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout-project-operation-error.test.ts` 用的是 `react-dom/client` + `act`。先读它，照搬同一套渲染辅助。

- [ ] **步骤 1：阅读现有 hook/组件测试的渲染方式**

读取 `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout-project-operation-error.test.ts`，记下它如何创建容器、如何 `createRoot`、如何包裹 `act`。后续测试沿用同一模式。

- [ ] **步骤 2：编写失败的测试**

创建 `apps/desktop/src/renderer/src/hooks/use-active-workspace-is-git.test.ts`。内容需覆盖：项目会话直接取 `selectedProjectGit` 且不调用 `git:isRepository`；项目外会话探测为真返回 `true`；探测为假返回 `false`；无工作区返回 `false`。骨架如下（渲染辅助按步骤 1 的模式补全）：

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { resetWorkspaceGitProbeCacheForTests } from "@renderer/lib/workspace-git-probe"
import { useActiveWorkspaceIsGit } from "./use-active-workspace-is-git"

// renderHook 辅助：按 main-layout-project-operation-error.test.ts 的 createRoot + act 模式实现，
// 返回当前 hook 返回值。
function renderIsGit(): { current: boolean | null; unmount: () => void } {
  // ...createRoot + act 渲染一个只调用 useActiveWorkspaceIsGit() 的探针组件
}

describe("useActiveWorkspaceIsGit", () => {
  beforeEach(() => {
    resetWorkspaceGitProbeCacheForTests()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    resetWorkspaceGitProbeCacheForTests()
  })

  it("uses selectedProjectGit for a project session without probing", async () => {
    const isRepository = vi.fn()
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { git: { isRepository } },
    })
    useDesktopSessionStore.setState({
      selectedProject: { id: "p1", name: "repo", path: "D:/repo", lastOpenedAt: 1, available: true },
      selectedProjectGit: true,
      activeSessionId: null,
    })

    const { current } = renderIsGit()
    await act(async () => {})

    expect(current).toBe(true)
    expect(isRepository).not.toHaveBeenCalled()
  })

  it("probes the session cwd for an outside-project session", async () => {
    const isRepository = vi.fn(async () => ({ isRepository: true, rootPath: "D:/xm" }))
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { git: { isRepository } },
    })
    useDesktopSessionStore.setState({
      selectedProject: null,
      selectedProjectGit: false,
      activeSessionId: "s1",
      sessionView: {
        // ...最小 view，session.workspaceMode === "outside_project"，session.cwd === "D:/xm"
      } as never,
    })

    const { current } = renderIsGit()
    await act(async () => {})

    expect(current).toBe(true)
    expect(isRepository).toHaveBeenCalledWith({ path: "D:/xm" })
  })

  it("returns false when the probe reports a non-repository", async () => {
    // 同上的项目外会话，但 isRepository 返回 false，断言 current === false
  })

  it("returns false when there is no active workspace", async () => {
    useDesktopSessionStore.setState({ selectedProject: null, activeSessionId: null })
    const { current } = renderIsGit()
    await act(async () => {})
    expect(current).toBe(false)
  })
})
```

`sessionView` 的最小结构参照 `apps/desktop/src/renderer/src/stores/desktop-session/store-test-fixtures.ts` 的 `emptySessionView`，但把 `session.cwd` 设为 `"D:/xm"`、`session.workspaceMode` 设为 `"outside_project"`。**注意**：`workspaceMode` 是 `DesktopSessionRecord` 的**顶层可选字段**（`apps/desktop/src/shared/session-types.ts:60`），不是放在 `metadata` 里；`selectActiveWorkspaceProject`（`selectors.ts:150`）和 `resolveSessionWorkspace`（`helpers.ts:72`）读的都是这个顶层字段。

- [ ] **步骤 3：运行测试验证失败**

运行：`pnpm --filter @openharness/desktop exec vitest run src/renderer/src/hooks/use-active-workspace-is-git.test.ts`
预期：FAIL，报错无法解析模块 `./use-active-workspace-is-git`。

- [ ] **步骤 4：实现 hook**

创建 `apps/desktop/src/renderer/src/hooks/use-active-workspace-is-git.ts`：

```ts
import { useEffect, useState } from "react"

import { probeWorkspaceGit } from "@renderer/lib/workspace-git-probe"
import {
  selectActiveWorkspaceProject,
  useDesktopSessionStore,
} from "@renderer/stores/desktop-session"

/**
 * 当前右侧面板/对话使用的目录是不是 git 仓库。
 *
 * - 项目会话：直接取 store 的 selectedProjectGit（分支选择器语义），不额外探测。
 * - 项目外会话：对工作区路径（会话 cwd）做只读探测，结果带 TTL 缓存。
 *
 * 返回 null 表示尚未判定，调用方应只在 === true 时启用审阅。
 */
export function useActiveWorkspaceIsGit(): boolean | null {
  const workspaceProject = useDesktopSessionStore(selectActiveWorkspaceProject)
  const selectedProjectGit = useDesktopSessionStore((state) => state.selectedProjectGit)
  const isProjectSession = useDesktopSessionStore((state) => state.selectedProject !== null)
  const workspacePath = workspaceProject?.path ?? null
  const [probed, setProbed] = useState<boolean | null>(null)

  useEffect(() => {
    if (isProjectSession || !workspacePath) {
      setProbed(null)
      return
    }
    let cancelled = false
    void probeWorkspaceGit(workspacePath).then((value) => {
      if (!cancelled) setProbed(value)
    })
    return () => {
      cancelled = true
    }
  }, [isProjectSession, workspacePath])

  if (isProjectSession) return selectedProjectGit
  if (!workspacePath) return false
  return probed
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`pnpm --filter @openharness/desktop exec vitest run src/renderer/src/hooks/use-active-workspace-is-git.test.ts`
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-active-workspace-is-git.ts apps/desktop/src/renderer/src/hooks/use-active-workspace-is-git.test.ts
git commit -m "feat(desktop): add useActiveWorkspaceIsGit hook"
```

---

### 任务 4：审阅与 diff 统计的路径来源统一

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/review-tool.tsx`（`:88`、`:90`、`:201-210`）
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message.tsx`（`:400`）
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/review-tool.git-changes.test.tsx`

- [ ] **步骤 1：编写失败的测试**

在 `apps/desktop/src/renderer/src/components/desktop/tools/review-tool.git-changes.test.tsx` 中追加一个用例：`state.selectedProject` 为 `null`，但 `selectActiveWorkspaceProject` 能返回合成 workspace（即存在 `activeSessionId` 且该会话 `workspaceMode === "outside_project"`、`cwd` 为 `"D:/repo"`）时，`ReviewTool` 不再渲染「选择一个项目后可以查看文件 diff。」空态，并且 `queryGitChanges` 以 `{ rootPath: "D:/repo", scope: ... }` 被调用。

先读现有文件（尤其 `:16` 周围的 store 注入与 `:44-57` 的断言），沿用同一套 mock：

```tsx
it("loads changes for an outside-project session instead of showing the empty state", async () => {
  // 注入 selectedProject: null + 项目外 activeSession（cwd "D:/repo"）
  // 渲染 <ReviewTool />
  // 断言：不出现“选择一个项目后可以查看文件 diff。”
  // 断言：queryGitChanges 以 rootPath "D:/repo" 被调用
})
```

预期先 FAIL：当前 `review-tool.tsx:201` 会因为 `state.selectedProject === null` 进入空态。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/tools/review-tool.git-changes.test.tsx`
预期：FAIL，新用例命中空态。

- [ ] **步骤 3：把 `review-tool` 的路径来源改成工作区项目**

在 `apps/desktop/src/renderer/src/components/desktop/tools/review-tool.tsx`：

把

```ts
  const selectedProject = useDesktopSessionStore((state) => state.selectedProject)
  ...
  const selectedProjectPath = selectedProject?.path
```

改为

```ts
  const selectedProject = useDesktopSessionStore(selectActiveWorkspaceProject)
  ...
  const selectedProjectPath = selectedProject?.path
```

（保留变量名 `selectedProject` 以避免大范围改动；关键变化是数据来源。）

在文件顶部导入 `selectActiveWorkspaceProject`；若 `useDesktopSessionStore` 从 `@renderer/stores/desktop-session` 导入，可一并加入该名字。

把空态判断

```ts
  if (!selectedProject) {
```

改为

```ts
  if (!selectedProjectPath) {
```

并把该空态的 `description` 从 `"选择一个项目后可以查看文件 diff。"` 改为 `"当前工作目录不可用。"`。

- [ ] **步骤 4：把 `assistant-message` 的 diff 统计路径来源改成工作区项目**

在 `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message.tsx` 的 `ChangedFilesSummary` 里，把

```ts
  const selectedProjectPath = useDesktopSessionStore((state) => state.selectedProject?.path)
```

改为

```ts
  const workspaceProject = useDesktopSessionStore(selectActiveWorkspaceProject)
  const selectedProjectPath = workspaceProject?.path
```

并在该文件顶部从 `@renderer/stores/desktop-session` 导入 `selectActiveWorkspaceProject`（沿用该文件现有的 store 导入风格）。

- [ ] **步骤 5：运行相关测试验证通过**

运行：`pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/tools/review-tool.git-changes.test.tsx src/renderer/src/components/desktop/conversation-page/message/assistant-message.git-changes.test.tsx`
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add apps/desktop/src/renderer/src/components/desktop/tools/review-tool.tsx apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message.tsx apps/desktop/src/renderer/src/components/desktop/tools/review-tool.git-changes.test.tsx
git commit -m "fix(desktop): source review paths from the active workspace project"
```

---

### 任务 5：审阅入口接入 `useActiveWorkspaceIsGit`

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/utility-panel.tsx`（`:108`、`:110`、`:121`、`:170`、`:189`、`:639`）
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx`（`:56`、`:281`）
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout-project-operation-error.test.ts`（`:170` 附近的 fixture）

- [ ] **步骤 1：编写失败的测试**

在 `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/` 下**新建** `utility-panel-review-access.test.tsx`（该目录现有测试只有 `file-open-request.test.ts` 与 `utility-panel-state.test.ts`，没有渲染 `UtilityPanel` 的测试；渲染辅助照搬 `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout-project-operation-error.test.ts:100-120` 的 `createRoot` + `act` + `IS_REACT_ACT_ENVIRONMENT` 模式）。追加两个用例：

- 项目外会话 + `git:isRepository` 返回 `true` → `utilityToolOrder` 里出现 `review`，且 `reviewOpenRequest` 能打开 review 标签页。
- 项目外会话 + `git:isRepository` 返回 `false` → review 不在工具列表；若已有 review 标签页则被移除。

需要 mock `window.desktop.git.isRepository`。断言方式参照该目录现有测试对 `utilityToolMeta.review.label` / `toolTabId("review")` 的用法。渲染 `UtilityPanel` 需要提供它的一整套 props（`scopeId`、`open`、`maximized`、`onToggleMaximized`、`onClose`、`fileOpenRequest`、`reviewOpenRequest`、`terminalOpenRequest`、`toolOpenRequest`、`onOpenFile`、`onOpenReview`、`onOpenTerminal`），照 `main-layout.tsx:302-316` 的调用形状填默认值。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/desktop exec vitest run <上一步对应的测试文件路径>`
预期：FAIL——当前审阅入口只由 `state.selectedProjectGit` 决定，项目外会话恒为 `false`。

- [ ] **步骤 3：在 `utility-panel` 换用 hook**

在 `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/utility-panel.tsx`：

把

```ts
  const selectedProjectGit = useDesktopSessionStore((state) => state.selectedProjectGit)
```

改为

```ts
  const activeWorkspaceIsGit = useActiveWorkspaceIsGit()
```

然后把该文件里其余 5 处 `selectedProjectGit` 的**读值**替换为 `activeWorkspaceIsGit`，并保持判断语义（注意 hook 返回 `boolean | null`，所有启用判断都要用 `=== true`）：

- `:110` `availableTools` 的三元条件 → `activeWorkspaceIsGit === true`
- `:121` `visibleTabs` 过滤 → `(activeWorkspaceIsGit === true || tab.tool !== "review")`
- `:170` `if (!selectedProjectGit) return` → `if (activeWorkspaceIsGit !== true) return`
- `:189` `if (selectedProjectGit) return` → `if (activeWorkspaceIsGit === true) return`
- `:199` 依赖数组里的 `selectedProjectGit` → `activeWorkspaceIsGit`
- `:639` `canOpenReview={selectedProjectGit}` → `canOpenReview={activeWorkspaceIsGit === true}`

在文件顶部加入 `import { useActiveWorkspaceIsGit } from "@renderer/hooks/use-active-workspace-is-git"`。

- [ ] **步骤 4：在 `main-layout` 换用 hook**

在 `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx`：

删除

```ts
  const selectedProjectGit = useDesktopSessionStore((state) => state.selectedProjectGit)
```

改为在组件内调用

```ts
  const activeWorkspaceIsGit = useActiveWorkspaceIsGit()
```

把 `:281` 的

```tsx
          canOpenReview={selectedProjectGit}
```

改为

```tsx
          canOpenReview={activeWorkspaceIsGit === true}
```

并加入同样的 hook 导入。

`requestOpenReview`（`:152-159`）保持调用 `refreshSelectedProjectGit({ force: true })` 以维持分支信息新鲜度，但其 `.then((git) => { if (git) openReview(path) })` 的门槛改为使用新值：由于 `openReview` 本身在目标面板内还有 gate，这里简化为直接 `openReview(path)` 即可——**修改为**：

```ts
  const requestOpenReview = useCallback(
    (path?: string): void => {
      void refreshSelectedProjectGit({ force: true })
      openReview(path)
    },
    [openReview, refreshSelectedProjectGit]
  )
```

- [ ] **步骤 5：更新测试 fixture**

`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout-project-operation-error.test.ts:170` 附近依赖 `selectedProjectGit` 的注入需要同步：该测试现在要通过 hook 拿值，因此应改为注入能让 hook 返回预期值的 store 状态（项目会话时设置 `selectedProjectGit`；项目外会话时 mock `window.desktop.git.isRepository`）。逐条检查该文件里所有 `selectedProjectGit` 用法并更新。

- [ ] **步骤 6：运行相关测试验证通过**

运行：`pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/layout`
预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/utility-panel.tsx apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout-project-operation-error.test.ts
git commit -m "feat(desktop): gate the review tool on the active workspace git probe"
```

---

### 任务 6：全量验证与文档对齐

**文件：**
- 可能修改：`apps/desktop/src/renderer/src/stores/desktop-session/selectors.ts`（顶部注释，说明 `selectedProjectGit` 与 `useActiveWorkspaceIsGit` 的分工）

- [ ] **步骤 1：在 `selectors.ts` 补分工注释**

在 `apps/desktop/src/renderer/src/stores/desktop-session/selectors.ts` 的 `selectActiveWorkspaceProject` 上方注释块里追加一句说明：

```
 * 注意：`state.selectedProjectGit` 只用于分支选择器（项目会话语义）；
 * 「这目录是不是 git 仓库」请用 `useActiveWorkspaceIsGit`，它对本函数返回的
 * 项目外 workspace 也会做只读探测。
```

- [ ] **步骤 2：跑桌面端类型检查**

运行：`pnpm --filter @openharness/desktop run typecheck`
预期：通过。

- [ ] **步骤 3：跑桌面端测试**

运行：`pnpm --filter @openharness/desktop exec vitest run`
预期：全绿。若出现与本次无关的既有失败，逐个确认是否由本次改动引入。

- [ ] **步骤 4：跑改动文件的 lint**

运行：`pnpm --filter @openharness/desktop exec eslint --no-cache src/main/features/git/git-service.ts src/main/features/git/ipc.ts src/preload/desktop-api.ts src/shared/git-types.ts src/shared/ipc-channels.ts src/shared/desktop-api-contract.ts src/renderer/src/lib/git-changes-query.ts src/renderer/src/lib/workspace-git-probe.ts src/renderer/src/lib/workspace-git-probe.test.ts src/renderer/src/hooks/use-active-workspace-is-git.ts src/renderer/src/hooks/use-active-workspace-is-git.test.ts src/renderer/src/components/desktop/tools/review-tool.tsx src/renderer/src/components/desktop/conversation-page/message/assistant-message.tsx src/renderer/src/components/desktop/layout/main-layout/utility-panel/utility-panel.tsx src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx`
预期：0 error。行尾风格（CRLF）警告可用 `--fix` 处理。

- [ ] **步骤 5：手动验证真实场景**

用桌面端 dev 打开那个项目外会话（cwd 是 git 仓库）：

```bash
pnpm --filter @openharness/desktop dev
```

确认：右侧出现「审阅」入口；打开后默认范围是「上一轮」；能切到「未提交」；消息里「已编辑 N 个文件」卡片显示 `+/−`。再打开一个 cwd 不是 git 仓库的项目外会话，确认审阅入口不出现。

- [ ] **步骤 6：Commit**

```bash
git add apps/desktop/src/renderer/src/stores/desktop-session/selectors.ts
git commit -m "docs(desktop): note the split between selectedProjectGit and the workspace probe"
```

---

## 自检记录

- **规格覆盖度**：规格的「数据模型」→任务 1；「运行流程·主进程」→任务 1；「运行流程·渲染进程」→任务 3；「组件与职责」表的 6 个单元分别落在任务 1（git-service、ipc）、任务 2（缓存）、任务 3（hook）、任务 4（review-tool、assistant-message）、任务 5（utility-panel、main-layout）；「错误处理」表→任务 1 步骤 6 与任务 2 步骤 4；「测试」1-6 条→任务 1 步骤 1、任务 2 步骤 1、任务 3 步骤 2、任务 5 步骤 1、任务 4 步骤 1 与步骤 5。
- **占位符扫描**：任务 3 步骤 2 与任务 5 步骤 1 含"按现有模式补全"的渲染辅助说明，原因是仓库现有测试已确立该模式且不宜重复粘贴整段样板；每处都指定了要参照的具体文件与行号，并给出完整的行为断言。其余步骤均为可直接执行的具体内容。
- **类型一致性**：`DesktopGitIsRepositoryInput` / `DesktopGitIsRepositoryResult` / `useActiveWorkspaceIsGit` / `probeWorkspaceGit` / `resetWorkspaceGitProbeCacheForTests` / `normalizedRootPath` 在各任务间命名一致；hook 返回 `boolean | null`，所有消费点在任务 5 中统一用 `=== true` / `!== true` 判断。
