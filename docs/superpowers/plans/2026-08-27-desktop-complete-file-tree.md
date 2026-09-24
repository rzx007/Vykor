# Desktop 完整文件树实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让桌面端文件面板返回并展示全部未忽略的项目文件，同时继续依靠 `@pierre/trees` 的行虚拟化控制 DOM 渲染量。

**架构：** 主进程 `WorkspaceService` 继续负责完整磁盘扫描和排序，但不再在 5,000 项时提前结束；共享 IPC 结果只返回根路径与完整条目。渲染进程继续把完整路径准备成 `@pierre/trees` 输入，现有固定高度、首次可见行预算和 overscan 配置保持不变。

**技术栈：** Electron、TypeScript、React 19、Vitest、Node.js 文件系统、`@pierre/trees`。

---

## 文件结构

- 创建 `apps/desktop/src/main/features/workspace/workspace-service.test.ts`：使用真实临时目录覆盖完整扫描、忽略规则和排序契约。
- 修改 `apps/desktop/src/main/features/workspace/workspace-service.ts`：删除 5,000 项上限及截断状态，完整返回扫描结果。
- 修改 `apps/desktop/src/shared/workspace-types.ts`：从列表结果契约删除 `truncated`。
- 修改 `apps/desktop/src/renderer/src/components/desktop/tools/files-tool.tsx`：删除截断提示，保留现有虚拟树配置及用户已有格式修改。

### 任务 1：完整文件树扫描与界面契约

**文件：**

- 创建：`apps/desktop/src/main/features/workspace/workspace-service.test.ts`
- 修改：`apps/desktop/src/main/features/workspace/workspace-service.ts`
- 修改：`apps/desktop/src/shared/workspace-types.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/files-tool.tsx`

- [ ] **步骤 1：编写会因 5,000 项截断而失败的回归测试**

该测试要抓住的生产代码破坏是：扫描器在任意固定数量处提前返回，导致磁盘上实际存在的后续文件没有进入结果。使用真实临时目录和真实 `WorkspaceService`；仅 mock Electron 的剪贴板和 Shell，因为列表扫描不依赖它们，且 Vitest 的 Node 环境不能启动 Electron 渲染运行时。

```ts
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  clipboard: { writeText: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}))

import { workspaceService } from "./workspace-service"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe("WorkspaceService.listFiles", () => {
  it("returns files beyond the former 5,000-entry boundary", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "vykor-workspace-"))
    temporaryDirectories.push(rootPath)
    await Promise.all(
      Array.from({ length: 5_001 }, (_, index) =>
        writeFile(join(rootPath, `file-${String(index).padStart(4, "0")}.txt`), "")
      )
    )

    const result = await workspaceService.listFiles({ rootPath })

    expect(result.entries).toHaveLength(5_001)
    expect(result.entries.at(-1)?.path).toBe("file-5000.txt")
  })
})
```

- [ ] **步骤 2：运行回归测试并确认正确失败**

运行：

```bash
pnpm --filter @vykor/desktop test -- src/main/features/workspace/workspace-service.test.ts
```

预期：测试以数量断言失败；实际为 `5,000`，期望为 `5,001`。失败不能来自 Electron import、临时目录权限或测试超时。

- [ ] **步骤 3：补充保持既有扫描语义的表征测试**

这些测试保护本次改动不误删忽略和排序逻辑。它们覆盖已有行为，因此允许在生产修改前直接通过。

```ts
it("keeps ignored directories out of the complete listing", async () => {
  const rootPath = await createTemporaryDirectory()
  await mkdir(join(rootPath, "node_modules"))
  await writeFile(join(rootPath, "node_modules", "ignored.js"), "")
  await writeFile(join(rootPath, "visible.ts"), "")

  const result = await workspaceService.listFiles({ rootPath })

  expect(result.entries.map((entry) => entry.path)).toEqual(["visible.ts"])
})

it("sorts directories before files and names within each group", async () => {
  const rootPath = await createTemporaryDirectory()
  await mkdir(join(rootPath, "z-directory"))
  await mkdir(join(rootPath, "a-directory"))
  await writeFile(join(rootPath, "z-file.ts"), "")
  await writeFile(join(rootPath, "a-file.ts"), "")

  const result = await workspaceService.listFiles({ rootPath })

  expect(result.entries.map((entry) => entry.path)).toEqual([
    "a-directory/",
    "z-directory/",
    "a-file.ts",
    "z-file.ts",
  ])
})
```

测试辅助函数只放在测试文件：

```ts
async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "vykor-workspace-"))
  temporaryDirectories.push(path)
  return path
}
```

- [ ] **步骤 4：编写最少实现，解除上限并清理契约**

在 `workspace-service.ts` 中删除：

```ts
const maxEntries = 5_000
let truncated = false
```

删除 `visit()` 入口及 `for` 循环中的两段 `entries.length >= maxEntries` 提前返回逻辑。返回值改为：

```ts
return { rootPath, entries }
```

在 `workspace-types.ts` 中把结果类型改为：

```ts
export interface WorkspaceListFilesResult {
  rootPath: string
  entries: WorkspaceFileEntry[]
}
```

在 `files-tool.tsx` 中删除：

```tsx
{listing.truncated && (
  <p className="shrink-0 border-t border-border/45 px-3 py-2 text-[11px] text-ui-muted">
    文件较多，仅显示前 5000 项。
  </p>
)}
```

不要修改 `ProjectFileTree` 的 `preparedInput`、`initialVisibleRowCount: 36`、`overscan: 18` 或 `<FileTree style={{ height: "100%" }}>`；这些是现有虚拟化路径。

- [ ] **步骤 5：运行定向测试确认绿灯**

运行：

```bash
pnpm --filter @vykor/desktop test -- src/main/features/workspace/workspace-service.test.ts
```

预期：3 个测试全部通过，退出码为 0，且无未处理异常。

- [ ] **步骤 6：运行桌面端完整验证**

依次运行：

```bash
pnpm --filter @vykor/desktop test
pnpm --filter @vykor/desktop typecheck
pnpm --filter @vykor/desktop lint
git diff --check
```

预期：测试、Node/Web 类型检查和 ESLint 均以退出码 0 完成；`git diff --check` 不报告空白错误。若完整验证暴露工作区中其他未提交修改导致的既有失败，记录具体命令和错误，并另外运行只覆盖本任务文件的最窄验证来区分责任。

- [ ] **步骤 7：审查差异并提交实现**

先运行：

```bash
git diff -- apps/desktop/src/main/features/workspace/workspace-service.test.ts apps/desktop/src/main/features/workspace/workspace-service.ts apps/desktop/src/shared/workspace-types.ts apps/desktop/src/renderer/src/components/desktop/tools/files-tool.tsx
git status --short
```

确认目标文件 `files-tool.tsx` 中用户已有的 import 空行和 `targetLine` 缩进仍被保留，且提交范围不包含其他会话的文件。然后提交：

```bash
git add apps/desktop/src/main/features/workspace/workspace-service.test.ts apps/desktop/src/main/features/workspace/workspace-service.ts apps/desktop/src/shared/workspace-types.ts apps/desktop/src/renderer/src/components/desktop/tools/files-tool.tsx
git commit -m "fix(desktop): 展示完整项目文件树"
```
