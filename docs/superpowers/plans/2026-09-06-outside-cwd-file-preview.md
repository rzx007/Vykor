# 项目外绝对路径文件预览实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 点对话里的「已编辑文件」或文件链接时，个人 skill、`USER.md` 和项目外工作区文件能在右侧 Files 预览；项目内文件（含 `/src/foo.ts`）行为不变。

**架构：** 渲染进程只用一份不依赖 `node:path` 的函数决定走 Review 还是预览。主进程 `classifyWorkspacePath` 做两轮分类（绝对路径按允许根匹配，否则回退项目相对路径）；`readFile` 在落盘前再 `realpath`。标签身份等读取成功后再写。允许根由 `WorkspaceService.configureAllowedRoots` 注入，分类函数不读 `app` / `process.cwd()`。

**技术栈：** Electron 主进程 / 渲染进程、TypeScript、Vitest、Node `path.win32` / `path.posix`、`fs.promises.realpath`。不新增路径库，不把 `@vykor/core` 加进 desktop production 依赖。

**规格：** `docs/superpowers/specs/2026-09-06-outside-cwd-file-preview-design.md`

---

## 文件结构

- 创建 `apps/desktop/src/shared/workspace-open-path.ts`：渲染进程可引用的纯函数，判断「能不能收成当前项目相对路径」。
- 创建 `apps/desktop/src/shared/workspace-open-path.test.ts`：分流规则测试（盘符 / UNC / `\\?\` / `/src/foo.ts`）。
- 创建 `apps/desktop/src/main/features/workspace/workspace-path.ts`：主进程分类、允许范围匹配、`realpath` 后再校验。
- 创建 `apps/desktop/src/main/features/workspace/workspace-path.test.ts`：注入 `win32` / `posix` 和三个根，覆盖盘符错配、根重叠、凭据文件。
- 修改 `apps/desktop/src/shared/workspace-types.ts`：`WorkspaceReadFileResult` 增加 `scope` / `relativePath` / `rootLabel`。
- 修改 `apps/desktop/src/main/features/workspace/workspace-service.ts`：注入允许根，`readFile` / `revealPath` / `copyPath` 走分类 + `realpath`。
- 修改 `apps/desktop/src/main/features/workspace/workspace-service.test.ts`：真实临时目录测 extra-root 读取和 symlink 拒绝。
- 修改 `apps/desktop/src/main/features/workspace/opener-service.ts`：复用分类；`rootPath` 缺失时拒绝。
- 修改 `apps/desktop/src/main/features/session/session-service.ts`：启动时把 `configDir` 和 `documents` 路径注入 workspace 服务。
- 修改 `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message.tsx`：卡片点击按分流函数走 Review 或预览。
- 修改 `apps/desktop/src/renderer/src/components/desktop/tools/review-tool.tsx`：只接受能收成项目相对路径的 `openRequest`。
- 修改 `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/utility-panel.tsx`：打开 Files 时不再用剥过的相对路径占位。
- 修改 `apps/desktop/src/renderer/src/components/desktop/tools/files-tool.tsx`：原始路径交给 `readFile`，面包屑和跳行用返回值。
- 修改 `apps/desktop/src/renderer/src/components/desktop/tools/file-viewer.tsx`：项目外 HTML 不提供「在浏览器中打开」。

锁定的类型（后续任务必须用这些名字）：

```ts
type WorkspaceFileScope = "project" | "extra-root"

type WorkspaceReadFileResult = {
  path: string
  name: string
  language: string
  size: number
  binary: boolean
  content: string | null
  scope: WorkspaceFileScope
  relativePath: string
  rootLabel: string
}

type WorkspacePathClassification = {
  kind: WorkspaceFileScope
  rootPath: string
  relativePath: string
  tabPath: string
  rootLabel: string
}

type WorkspaceAllowedRoots = {
  projectRoot: string
  configDir: string
  skillsDir: string
  userProfilePath: string
  outsideProjectRoot: string
}
```

`toProjectRelativePath(path, projectPath)` 返回 `string | null`：能收成当前项目相对路径则返回相对路径，否则 `null`。

---

### 任务 1：渲染进程分流纯函数

**文件：**

- 创建：`apps/desktop/src/shared/workspace-open-path.ts`
- 测试：`apps/desktop/src/shared/workspace-open-path.test.ts`

- [ ] **步骤 1：编写失败的分流测试**

```ts
import { describe, expect, it } from "vitest"

import { toProjectRelativePath } from "./workspace-open-path"

const project = "E:/code/vykor"

describe("toProjectRelativePath", () => {
  it("keeps project-relative paths including a leading slash", () => {
    expect(toProjectRelativePath("src/foo.ts", project)).toBe("src/foo.ts")
    expect(toProjectRelativePath("/src/foo.ts", project)).toBe("src/foo.ts")
    expect(toProjectRelativePath("./src/foo.ts", project)).toBe("src/foo.ts")
    expect(toProjectRelativePath("src/foo.ts:12", project)).toBe("src/foo.ts")
  })

  it("strips a Windows project prefix", () => {
    expect(toProjectRelativePath("E:\\code\\vykor\\src\\foo.ts", project)).toBe("src/foo.ts")
    expect(toProjectRelativePath("\\\\?\\E:\\code\\vykor\\src\\foo.ts", project)).toBe(
      "src/foo.ts"
    )
  })

  it("returns null for Windows paths outside the project", () => {
    expect(
      toProjectRelativePath(
        "C:\\Users\\ruanz\\.vykor\\skills\\show-me\\SKILL.md",
        project
      )
    ).toBeNull()
  })

  it("does not treat a POSIX home path as a project-relative path", () => {
    expect(
      toProjectRelativePath("/Users/ruanz/.vykor/skills/show-me/SKILL.md", project)
    ).toBe("Users/ruanz/.vykor/skills/show-me/SKILL.md")
  })
})
```

最后一条是故意的：渲染进程**不能**把开头 `/` 当绝对路径。`/Users/...` 会被剥成看起来像项目相对路径；卡片因此仍可能进 Review，但 Review 对不上 git 文件，主进程预览才会真正打开 skill。卡片点击规则是「能收成项目相对路径且有 git → Review」，所以 `/Users/...` 在有 git 时会先进 Review、对不上再空着——规格要求盘符 / UNC 才直接走预览。`/Users/...` 走 Review 空列表可接受；Windows 盘符路径必须 `null` 从而走预览。

- [ ] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @vykor/desktop test -- src/shared/workspace-open-path.test.ts
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现最少代码**

`toProjectRelativePath` 规则：

1. 去掉空白和 `:行` / `:行:列`。
2. `\` 换成 `/`，去掉末尾 `/`。
3. 若匹配 `^[a-zA-Z]:/`、`^//` 或 `^//?/`（含 `\\?\` 规范化后）：有 `projectPath` 且小写前缀是 `project/` 则切开返回相对路径，否则 `null`。
4. 其它情况去掉开头 `./` 和 `/` 后返回。不引用 `node:path`。

- [ ] **步骤 4：运行测试确认通过**

```bash
pnpm --filter @vykor/desktop test -- src/shared/workspace-open-path.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/shared/workspace-open-path.ts apps/desktop/src/shared/workspace-open-path.test.ts
git commit -m "feat(desktop): add project-relative path routing helper"
```

---

### 任务 2：主进程路径分类

**文件：**

- 创建：`apps/desktop/src/main/features/workspace/workspace-path.ts`
- 测试：`apps/desktop/src/main/features/workspace/workspace-path.test.ts`

- [ ] **步骤 1：编写失败的分类测试**

用注入的 `win32` / `posix` 和固定根，不要读 `process.cwd()`。

```ts
import { posix, win32 } from "node:path"
import { describe, expect, it } from "vitest"

import { classifyWorkspacePath } from "./workspace-path"

const windowsRoots = {
  projectRoot: "E:\\code\\vykor",
  configDir: "C:\\Users\\ruanz\\.vykor",
  skillsDir: "C:\\Users\\ruanz\\.vykor\\skills",
  userProfilePath: "C:\\Users\\ruanz\\.vykor\\USER.md",
  outsideProjectRoot: "C:\\Users\\ruanz\\Documents\\Vykor",
}

const posixRoots = {
  projectRoot: "/repo",
  configDir: "/Users/ruanz/.vykor",
  skillsDir: "/Users/ruanz/.vykor/skills",
  userProfilePath: "/Users/ruanz/.vykor/USER.md",
  outsideProjectRoot: "/Users/ruanz/Documents/Vykor",
}

describe("classifyWorkspacePath", () => {
  it("classifies project-relative and in-project Windows absolute paths", () => {
    expect(classifyWorkspacePath("src/a.ts", windowsRoots, { win32, posix })?.kind).toBe("project")
    expect(
      classifyWorkspacePath("E:\\code\\vykor\\src\\a.ts", windowsRoots, { win32, posix })
        ?.relativePath
    ).toBe("src/a.ts")
  })

  it("classifies personal skills and USER.md as extra-root", () => {
    const skill = classifyWorkspacePath(
      "C:\\Users\\ruanz\\.vykor\\skills\\show-me\\SKILL.md",
      windowsRoots,
      { win32, posix }
    )
    expect(skill).toMatchObject({
      kind: "extra-root",
      relativePath: "skills/show-me/SKILL.md",
      rootLabel: "个人配置",
    })
    expect(
      classifyWorkspacePath("C:\\Users\\ruanz\\.vykor\\USER.md", windowsRoots, {
        win32,
        posix,
      })?.kind
    ).toBe("extra-root")
    expect(
      classifyWorkspacePath(
        "C:\\Users\\ruanz\\.vykor\\credentials.json",
        windowsRoots,
        { win32, posix }
      )
    ).toBeNull()
  })

  it("maps POSIX skill paths using each root drive, not the process drive", () => {
    const result = classifyWorkspacePath(
      "/Users/ruanz/.vykor/skills/show-me/SKILL.md",
      windowsRoots,
      { win32, posix }
    )
    expect(result?.kind).toBe("extra-root")
    expect(result?.tabPath.replace(/\\/g, "/")).toContain(
      "C:/Users/ruanz/.vykor/skills/show-me/SKILL.md"
    )
  })

  it("falls back /src/foo.ts to a project-relative path", () => {
    expect(classifyWorkspacePath("/src/foo.ts", windowsRoots, { win32, posix })).toMatchObject({
      kind: "project",
      relativePath: "src/foo.ts",
    })
  })

  it("does not classify /etc/passwd as extra-root", () => {
    expect(classifyWorkspacePath("/etc/passwd", posixRoots, { win32, posix })?.kind).not.toBe(
      "extra-root"
    )
    expect(classifyWorkspacePath("/etc/passwd", posixRoots, { win32, posix })).toMatchObject({
      kind: "project",
      relativePath: "etc/passwd",
    })
  })

  it("prefers the current project when it sits inside an extra root", () => {
    const sessionRoots = {
      ...windowsRoots,
      projectRoot: "C:\\Users\\ruanz\\Documents\\Vykor\\2026-09-06\\x1",
    }
    expect(
      classifyWorkspacePath(
        "C:\\Users\\ruanz\\Documents\\Vykor\\2026-09-06\\x1\\src\\a.ts",
        sessionRoots,
        { win32, posix }
      )
    ).toMatchObject({ kind: "project", relativePath: "src/a.ts", rootLabel: expect.anything() })
    expect(
      classifyWorkspacePath(
        "C:\\Users\\ruanz\\Documents\\Vykor\\2026-09-06\\x2\\note.md",
        sessionRoots,
        { win32, posix }
      )?.kind
    ).toBe("extra-root")
  })
})
```

`credentials.json` 用例：分类结果必须是 `null` 或第二轮项目相对（`kind: "project"` 且相对路径是不存在的项目内文件）。**不能**是 `extra-root`。实现时第一轮只放行 `skillsDir` 与 `userProfilePath`，对不上再走第二轮；若第二轮会变成项目内 `C:/Users/...` 这种奇怪相对路径，第一轮对 Windows 绝对路径且不在允许范围应直接 `null`，不要再剥盘符当相对路径。

补充约定（写进 `workspace-path.ts` 注释并测）：

- Windows 盘符 / UNC 绝对路径第一轮未命中允许范围 → 返回 `null`（不要当项目相对路径）。
- POSIX `/Users/...` 在 Windows 上先按每个根的盘符映射；仍未命中再走第二轮剥 `/`。
- `/src/foo.ts` 第一轮映射成 `E:\src\foo.ts` 未命中后，第二轮得到 `src/foo.ts`。

- [ ] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @vykor/desktop test -- src/main/features/workspace/workspace-path.test.ts
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现 `classifyWorkspacePath`**

放在 `workspace-path.ts`：

1. 去掉行号。收集候选：`win32.isAbsolute` → `win32.resolve` 自身（先去掉 `\\?\`）；`posix.isAbsolute(正斜杠形式)` → POSIX 规范化；对每个允许根（`projectRoot` / `skillsDir` / `userProfilePath` 的目录 / `outsideProjectRoot`）用 `win32.resolve(win32.parse(root).root, posixPath)` 再收一条。
2. 对每个候选，按顺序匹配：当前项目 → `skillsDir`（文件）或 `userProfilePath`（精确）→ `outsideProjectRoot`。`isPathInside` 用 `relative`，规则与 `outside-project-workspace.ts` 相同。
3. 命中项目：`kind: "project"`，`tabPath` / `relativePath` 为相对项目的 `/` 路径，`rootLabel` 可为空字符串或项目占位（渲染进程面包屑用项目名，不读这个字段的项目值）。
4. 命中 skill：`relativePath` 相对 `configDir`（`skills/...`），`rootLabel` 为 `个人配置`，`tabPath` 为规范化绝对路径（`/`）。
5. 命中 `USER.md`：`relativePath` 为 `USER.md`，`rootLabel` 为 `个人配置`。
6. 命中项目外工作区：`relativePath` 相对 `outsideProjectRoot`，`rootLabel` 为 `项目外工作区`。
7. 未命中：若原始路径是 Windows 盘符 / UNC → `null`；否则剥 `./` 和 `/`，再按项目相对路径 `resolve` 一次，成功则 `project`。

同时导出 `isPathInside(candidate, root, pathApi)` 和 `stripLocationSuffix(path)`，供 `readFile` 复用。

- [ ] **步骤 4：运行测试确认通过**

```bash
pnpm --filter @vykor/desktop test -- src/main/features/workspace/workspace-path.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/main/features/workspace/workspace-path.ts apps/desktop/src/main/features/workspace/workspace-path.test.ts
git commit -m "feat(desktop): classify extra-root workspace preview paths"
```

---

### 任务 3：读文件走分类并挡住 symlink

**文件：**

- 修改：`apps/desktop/src/shared/workspace-types.ts`
- 修改：`apps/desktop/src/main/features/workspace/workspace-service.ts`
- 修改：`apps/desktop/src/main/features/workspace/workspace-service.test.ts`
- 修改：`apps/desktop/src/main/features/session/session-service.ts`（注入允许根）

- [ ] **步骤 1：扩展类型，并写会失败的 `readFile` 测试**

`WorkspaceReadFileResult` 增加必填字段：`scope`、`relativePath`、`rootLabel`。`file-viewer.test.ts` 里的 `fileTab` 辅助函数补上 `scope: "project"`、`relativePath: path`、`rootLabel: ""`，否则类型检查失败——这属于本任务，一起改。

在 `workspace-service.test.ts` 增加（保留现有 `listFiles` 测试）：

```ts
import { lstat, mkdir, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

it("reads a personal skill from an extra root", async () => {
  const project = await createTemporaryDirectory()
  const configDir = await createTemporaryDirectory()
  const documentsPath = await createTemporaryDirectory()
  const skillPath = join(configDir, "skills", "show-me", "SKILL.md")
  await mkdir(join(configDir, "skills", "show-me"), { recursive: true })
  await writeFile(skillPath, "# skill\n")
  workspaceService.configureAllowedRoots({ configDir, documentsPath })

  const result = await workspaceService.readFile({
    rootPath: project,
    path: skillPath,
  })

  expect(result).toMatchObject({
    scope: "extra-root",
    relativePath: "skills/show-me/SKILL.md",
    rootLabel: "个人配置",
    content: "# skill\n",
  })
})

it("does not follow a symlink that escapes the allowed root", async () => {
  const project = await createTemporaryDirectory()
  const configDir = await createTemporaryDirectory()
  const documentsPath = await createTemporaryDirectory()
  const outside = await createTemporaryDirectory()
  const target = join(outside, "secret.txt")
  await writeFile(target, "secret")
  const link = join(configDir, "skills", "leak.md")
  await mkdir(join(configDir, "skills"), { recursive: true })
  try {
    await symlink(target, link)
  } catch {
    return
  }
  workspaceService.configureAllowedRoots({ configDir, documentsPath })

  await expect(
    workspaceService.readFile({ rootPath: project, path: link })
  ).rejects.toThrow("文件必须位于当前项目目录内。")
})

it("does not read credentials.json from the config directory", async () => {
  const project = await createTemporaryDirectory()
  const configDir = await createTemporaryDirectory()
  await writeFile(join(configDir, "credentials.json"), "{\"token\":\"x\"}")
  workspaceService.configureAllowedRoots({
    configDir,
    documentsPath: await createTemporaryDirectory(),
  })

  await expect(
    workspaceService.readFile({
      rootPath: project,
      path: join(configDir, "credentials.json"),
    })
  ).rejects.toThrow()
})
```

Windows 上若 `symlink` 需要权限，测试捕获后 `return` 跳过，不能算失败。Linux / macOS CI 必须执行拒绝断言。

- [ ] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @vykor/desktop test -- src/main/features/workspace/workspace-service.test.ts
```

预期：FAIL，`configureAllowedRoots` 不存在，或 `readFile` 仍抛「必须位于当前项目目录内」。

- [ ] **步骤 3：实现读取与注入**

`WorkspaceService` 增加：

```ts
configureAllowedRoots(input: { configDir: string; documentsPath: string }): void
```

内部保存 `configDir` / `documentsPath`。`readFile` / `revealPath` / `copyPath`：

1. 用保存的值加上 `input.rootPath` 组装 `WorkspaceAllowedRoots`（`skillsDir = join(configDir, "skills")`，`userProfilePath = join(configDir, "USER.md")`，`outsideProjectRoot = buildOutsideProjectRoot(documentsPath)`）。未 configure 时：`configDir = process.env.VYKOR_CONFIG_DIR ?? join(homedir(), ".vykor")`，`documentsPath` 为空字符串则 `outsideProjectRoot` 为空、不参与匹配。
2. `classifyWorkspacePath`；`null` 则抛现有「文件必须位于当前项目目录内。」
3. 拼出绝对路径后 `realpath`。失败（文件不存在）抛现有预览错误。成功后再 `isPathInside` 一次；逃出则拒绝。
4. 继续现有 `stat` / 大小 / 二进制 / 解码。返回的 `path` 用 `tabPath`，并带上 `scope` / `relativePath` / `rootLabel`。

在 `session-service.ts` 的 bootstrap 开头（已有 `app.getPath("documents")` 的那个方法）调用：

```ts
workspaceService.configureAllowedRoots({
  configDir: process.env.VYKOR_CONFIG_DIR ?? join(homedir(), ".vykor"),
  documentsPath: app.getPath("documents"),
})
```

- [ ] **步骤 4：运行测试确认通过**

```bash
pnpm --filter @vykor/desktop test -- src/main/features/workspace/workspace-service.test.ts src/renderer/src/components/desktop/tools/file-viewer.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/shared/workspace-types.ts apps/desktop/src/main/features/workspace/workspace-service.ts apps/desktop/src/main/features/workspace/workspace-service.test.ts apps/desktop/src/main/features/session/session-service.ts apps/desktop/src/renderer/src/components/desktop/tools/file-viewer.test.ts
git commit -m "feat(desktop): preview allowed extra-root files in workspace read"
```

---

### 任务 4：openWith / reveal 必须走分类

**文件：**

- 修改：`apps/desktop/src/main/features/workspace/opener-service.ts`
- 测试：`apps/desktop/src/main/features/workspace/opener-service.test.ts`（新建，只测 `resolveOpenTarget` 若继续私有则改为导出 `resolveWorkspaceOpenTarget`）

- [ ] **步骤 1：写失败测试**

把 `resolveOpenTarget` 抽到 `workspace-path.ts` 为 `resolveWorkspaceOpenTarget(path, rootPath, roots)` 并导出，便于单测：

```ts
it("rejects openWith when rootPath is missing", async () => {
  await expect(
    resolveWorkspaceOpenTarget("C:\\Windows\\notepad.exe", undefined, roots)
  ).rejects.toThrow()
})

it("allows a skill path when rootPath is the current project", async () => {
  const target = await resolveWorkspaceOpenTarget(skillPath, projectRoot, roots)
  expect(target.path).toBe(await realpath(skillPath))
})
```

- [ ] **步骤 2：运行确认失败**

```bash
pnpm --filter @vykor/desktop test -- src/main/features/workspace/opener-service.test.ts
```

- [ ] **步骤 3：删掉 `opener-service.ts` 里的 `resolveInsideRoot`，改为调用 `resolveWorkspaceOpenTarget`。`rootPath` 缺失直接抛「项目路径不能为空。」**

- [ ] **步骤 4：运行确认通过**

- [ ] **步骤 5：Commit**

```bash
git commit -m "fix(desktop): keep workspace openers inside allowed roots"
```

---

### 任务 5：卡片点击与 Review 分流

**文件：**

- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/review-tool.tsx`
- 测试：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message-open-path.test.ts`（新建，测抽出的 `routeChangedFileClick`）
- 测试：`apps/desktop/src/shared/workspace-open-path.test.ts`（若路由函数放 shared，就写在这里，不要再新建文件）

把点击规则抽成：

```ts
export function routeChangedFileClick(
  path: string,
  projectPath: string | undefined,
  canOpenReview: boolean
): "review" | "preview" {
  if (canOpenReview && toProjectRelativePath(path, projectPath)) return "review"
  return "preview"
}
```

放进 `workspace-open-path.ts`。

- [ ] **步骤 1：加测试**

```ts
it("opens review for /src/foo.ts when git is available", () => {
  expect(routeChangedFileClick("/src/foo.ts", "E:/code/vykor", true)).toBe("review")
})

it("opens preview for an extra-root Windows skill path", () => {
  expect(
    routeChangedFileClick(
      "C:\\Users\\ruanz\\.vykor\\skills\\show-me\\SKILL.md",
      "E:/code/vykor",
      true
    )
  ).toBe("preview")
})
```

- [ ] **步骤 2：运行确认失败（函数不存在）**

- [ ] **步骤 3：实现函数。卡片 `onClick` 改为 `routeChangedFileClick(...) === "review" ? onOpenReview(file.path) : onOpenFile(file.path)`。`review-tool.tsx` 的 `openRequest`：用 `toProjectRelativePath`；`null` 则忽略，不 `setActivePath`、不拉 diff。删掉这两处本地 `toProjectRelativePath`。`assistant-message.tsx` 里给 git stats 用的那份改成 shared 版本：返回 `null` 时用原路径做 key（对不上 git，没有 +/-，符合规格）。**

- [ ] **步骤 4：运行**

```bash
pnpm --filter @vykor/desktop test -- src/shared/workspace-open-path.test.ts
```

- [ ] **步骤 5：Commit**

```bash
git commit -m "feat(desktop): route extra-root edited files to preview"
```

---

### 任务 6：右侧面板打开、面包屑、标签缓存

**文件：**

- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/utility-panel.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/files-tool.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/file-viewer.tsx`
- 测试：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/file-open-request.test.ts`（抽出 `prepareFileOpenRequest`）

- [ ] **步骤 1：写失败测试**

抽出：

```ts
export function prepareFileOpenRequest(
  rawPath: string,
  projectPath: string | undefined
): { openPath: string; placeholderPath: string | null } {
  return { openPath: rawPath.trim(), placeholderPath: null }
}
```

测试：项目外 Windows 绝对路径的 `placeholderPath` 为 `null`；项目相对路径也可以 `null`（标签等 `readFile` 成功后再建）。`shouldOfferHtmlBrowserOpen` 增加对 `scope` 的包装测试：`preview.scope === "extra-root"` 时文件查看器不展示按钮——在 `file-viewer-model.ts` 增加：

```ts
export function canOpenHtmlInBrowser(scope: WorkspaceFileScope | undefined): boolean {
  return scope !== "extra-root"
}
```

```ts
expect(canOpenHtmlInBrowser("extra-root")).toBe(false)
expect(canOpenHtmlInBrowser("project")).toBe(true)
expect(canOpenHtmlInBrowser(undefined)).toBe(true)
```

旧标签没有 `scope` 当 `project`。

- [ ] **步骤 2：运行确认失败**

- [ ] **步骤 3：改打开链路**

`utility-panel.tsx` 处理 `fileOpenRequest`：

1. 打开 Files 工具页（没有 files 标签就加一个工具标签）。
2. **不要**调用 `toRelativeWorkspacePath` 生成 `fileTabId` / `setActiveFilePath`。
3. 把 `fileOpenRequest.path` 原样传给 `FilesTool`。
4. 删除或停用 `toRelativeWorkspacePath`。

`files-tool.tsx`：

1. `openRequest` 用原始 `path` 调 `readFile`。
2. 成功后 `onActivePathChange(result.path)`，`onFileOpened` 带上 `scope` / `relativePath` / `rootLabel`。
3. `FileBreadcrumb` 吃当前 tab 的 `preview`：`scope === "extra-root"` 时左侧 `rootLabel`，后面 `relativePath`；否则项目名 + 项目相对路径。
4. 跳行：`openRequest.id` 已处理后，用 `result.path === activePath` 对齐 `targetLine`，不要拿原始绝对路径和 `activePath` 比。
5. `persistFileTabs` 只保存 `preview.scope !== "extra-root"` 的标签；`activePath` 属于 extra-root 时不写进缓存。

`file-viewer.tsx`：`showLargeHtmlAction` 增加 `canOpenHtmlInBrowser(activeTab.preview.scope)`。

- [ ] **步骤 4：运行相关测试和类型检查**

```bash
pnpm --filter @vykor/desktop test -- src/shared/workspace-open-path.test.ts src/main/features/workspace/workspace-path.test.ts src/main/features/workspace/workspace-service.test.ts src/renderer/src/components/desktop/tools/file-viewer-model.test.ts src/renderer/src/components/desktop/tools/file-viewer.test.ts
pnpm --filter @vykor/desktop typecheck
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git commit -m "feat(desktop): open extra-root files in the files panel"
```

---

## 自检

| 规格条目 | 任务 |
|---|---|
| 允许根：项目 / skills / USER.md / Vykor | 2、3 |
| 项目优先、会话 x1 vs x2 | 2 |
| Windows POSIX 路径按根盘符映射 | 2 |
| `/src/foo.ts` 仍进 Review | 1、5 |
| 盘符项目外走预览 | 1、5、6 |
| 分类不 exists，读失败再报错 | 2、3 |
| `realpath` 防 symlink | 3 |
| 不读 credentials | 2、3 |
| `openWith` 缺 rootPath 拒绝 | 4 |
| `utility-panel` 不占位假相对路径 | 6 |
| 面包屑 / 不持久化 / 无 HTML 外开 | 6 |
| `/etc/passwd` 回退项目相对 | 2 |

无 TODO / 待定。类型名与任务 1–6 一致。

---

## 手动验收（实现后）

1. 在当前项目会话让 Agent 创建一个个人 skill，点「已编辑文件」：右侧预览，面包屑「个人配置 / skills / ...」，文件树不选中，没有 Review。
2. 点项目内 `src` 文件：有 git 仍进 Review。
3. 关掉 extra-root 标签后切换会话再回来：不会自动恢复该标签。
4. 点 `credentials.json` 或系统路径：报错，看不到内容。
