# 集成终端 Shell 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 设置页「集成终端 Shell」成为本机唯一入口；之后所有项目新开的本地集成终端都用这个默认值。

**架构：** 默认 id 进 `userData/desktop-preferences.json` 的 `defaultTerminalShellId`，和通知、默认打开目标同一份文件。主进程扫描本机已装 Shell；`terminal.create` 在本地且调用方没带 `shell` 时，把 id 解析成可执行文件路径再交给 daemon。渲染进程不再传 `project.defaultShell`。侧边栏按项目填 Shell 的入口拿掉。

**技术栈：** Electron、React、现有 settings / terminal IPC、Vitest。

**规格：** `docs/superpowers/specs/2026-09-06-integrated-terminal-shell-design.md`

**不要做：** 运行环境、Agent 终端、Bash 工具、沙箱终端、自定义路径、fish / WSL / Windows Terminal、删项目表 `default_shell`、改 daemon `resolveDefaultShell`、给 PTY 塞 `--login` / `--cd=`。

**工作区注意：** 不要把 `assistant-message.tsx`、`main.css`、`workspace-path.*`、`docs/superpowers/*outside-cwd-file-preview*` 或其它无关改动加进这次提交。

---

## 文件结构

- 修改：`apps/desktop/src/shared/settings-types.ts`
  - `defaultTerminalShellId`、`UpdateDesktopDefaultTerminalShellInput`、`normalizeDefaultTerminalShellId`、snapshot 拼装。
- 修改：`apps/desktop/src/main/features/settings/desktop-preferences.ts`
  - 三字段一起读回；`null` / `system` / 空白规范化后省略，文件里不写 `null`。
- 修改：`apps/desktop/src/main/features/settings/settings-service.ts`、`ipc.ts`
  - `updateDefaultTerminalShell`。
- 修改：`apps/desktop/src/shared/ipc-channels.ts`、`desktop-api-contract.ts`、`preload/desktop-api.ts`、`shared/terminal-types.ts`
  - `settings:update-default-terminal-shell`、`terminal:list-shells`、`DesktopDetectedTerminalShell`。
- 创建：`apps/desktop/src/main/features/terminal/detect-shells.ts`
  - 内部 `{ id, label, command }` 检测、`toPublicTerminalShells`、`resolvePreferredTerminalShell`。
- 创建：`apps/desktop/src/main/features/terminal/apply-preferred-shell.ts`
  - `applyPreferredTerminalShell`：决定要不要往 create 入参补 `shell`。
- 修改：`apps/desktop/src/main/features/terminal/terminal-service.ts`、`ipc.ts`
  - create 时补路径；暴露 `list-shells`。
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/default-terminal-shell-control.tsx`
  - 设置页真实下拉。
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx`
  - 换上控件。
- 创建：`apps/desktop/src/renderer/src/components/desktop/tools/terminal/user-terminal-create-input.ts`
  - 用户新开终端的入参，不含 `shell`。
- 创建：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/project-menu-items.ts`
  - 项目菜单项（没有「设置默认 Shell」）。
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/terminal/terminal-tool.tsx`
  - 改用 `userTerminalCreateInput`。
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx`
  - 菜单改用 `projectMenuItems`；拿掉对话框和 `onSetDefaultShell`。
- 测试：见各任务。

---

### 任务 1：本机偏好和 snapshot 形状

**文件：**
- 修改：`apps/desktop/src/shared/settings-types.ts`
- 修改：`apps/desktop/src/main/features/settings/desktop-preferences.ts`
- 测试：`apps/desktop/src/main/features/settings/settings-service.test.ts`
- 测试：`apps/desktop/src/main/features/settings/desktop-preferences.test.ts`
- 测试：`apps/desktop/src/renderer/src/stores/desktop-session/notification-observer.test.ts`
- 测试：`apps/desktop/src/renderer/src/components/desktop/settings-page/default-opener-control.test.ts`

- [ ] **步骤 1：编写失败的 snapshot 测试**

把 `settings-service.test.ts` 里现有 `toEqual` 都加上 `defaultTerminalShellId: null`，并追加：

```ts
it("defaults defaultTerminalShellId to null", () => {
  expect(buildDesktopSettingsSnapshot({})).toEqual({
    workStyle: "practical",
    notificationMode: "when_unfocused",
    defaultOpenerId: null,
    defaultTerminalShellId: null,
  })
})

it("preserves a valid default terminal shell id", () => {
  expect(
    buildDesktopSettingsSnapshot({}, { defaultTerminalShellId: "  pwsh  " })
  ).toMatchObject({ defaultTerminalShellId: "pwsh" })
})

it("treats system and blank terminal shell ids as missing", () => {
  expect(
    buildDesktopSettingsSnapshot({}, { defaultTerminalShellId: "system" })
  ).toMatchObject({ defaultTerminalShellId: null })
  expect(
    buildDesktopSettingsSnapshot({}, { defaultTerminalShellId: "   " })
  ).toMatchObject({ defaultTerminalShellId: null })
})
```

同步改这些字面量，否则实现后类型检查或运行会红：

- `notification-observer.test.ts` 三处 snapshot：加上 `defaultTerminalShellId: null`
- `default-opener-control.test.ts` 的 `settingsSnapshot()`：加上 `defaultTerminalShellId: null`

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm --filter @vykor/desktop exec vitest run src/main/features/settings/settings-service.test.ts
```

预期：FAIL，snapshot 还没有 `defaultTerminalShellId`。

- [ ] **步骤 3：实现类型和 snapshot 拼装**

在 `settings-types.ts` 增加：

```ts
export interface DesktopSettingsSnapshot {
  workStyle: DesktopWorkStyle
  notificationMode: DesktopNotificationMode
  defaultOpenerId: string | null
  defaultTerminalShellId: string | null
}

export interface UpdateDesktopDefaultTerminalShellInput {
  defaultTerminalShellId: string | null
}

export function normalizeDefaultTerminalShellId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || trimmed === "system") return null
  return trimmed
}
```

`buildDesktopSettingsSnapshot` 的本机偏好参数加上 `defaultTerminalShellId`，返回值用 `normalizeDefaultTerminalShellId`。

- [ ] **步骤 4：编写失败的偏好读写测试**

在 `desktop-preferences.test.ts` 追加（沿用现有 `mkdtemp` + `vi.resetModules`）：

```ts
it("reads a valid default terminal shell id without dropping other fields", async () => {
  await writeFile(
    join(userDataPath, "desktop-preferences.json"),
    JSON.stringify({
      notificationMode: "always",
      defaultOpenerId: "vscode",
      defaultTerminalShellId: "git-bash",
    }),
    "utf8"
  )
  const { getDesktopPreferences } = await import("./desktop-preferences")
  expect(getDesktopPreferences()).toEqual({
    notificationMode: "always",
    defaultOpenerId: "vscode",
    defaultTerminalShellId: "git-bash",
  })
})

it("omits system and blank terminal shell ids from disk", async () => {
  const { patchDesktopPreferences, getDesktopPreferences, getDesktopPreferencesPath } =
    await import("./desktop-preferences")
  const { readFile } = await import("node:fs/promises")
  patchDesktopPreferences({ defaultTerminalShellId: "pwsh" })
  patchDesktopPreferences({ defaultTerminalShellId: "system" })
  expect(getDesktopPreferences()).toEqual({ notificationMode: "when_unfocused" })
  expect(JSON.parse(await readFile(getDesktopPreferencesPath(), "utf8"))).not.toHaveProperty(
    "defaultTerminalShellId"
  )
})

it("keeps opener and notification when clearing the terminal shell", async () => {
  const { patchDesktopPreferences, getDesktopPreferences } = await import("./desktop-preferences")
  patchDesktopPreferences({ defaultOpenerId: "cursor", defaultTerminalShellId: "pwsh" })
  patchDesktopPreferences({ defaultTerminalShellId: null })
  expect(getDesktopPreferences()).toEqual({
    notificationMode: "when_unfocused",
    defaultOpenerId: "cursor",
  })
})

it("keeps terminal shell when patching notification mode", async () => {
  const { patchDesktopPreferences, getDesktopPreferences } = await import("./desktop-preferences")
  patchDesktopPreferences({ defaultTerminalShellId: "pwsh" })
  patchDesktopPreferences({ notificationMode: "never" })
  expect(getDesktopPreferences()).toEqual({
    notificationMode: "never",
    defaultTerminalShellId: "pwsh",
  })
})
```

- [ ] **步骤 5：运行偏好测试验证失败**

```bash
pnpm --filter @vykor/desktop exec vitest run src/main/features/settings/desktop-preferences.test.ts
```

预期：FAIL，还没有 `defaultTerminalShellId`。

- [ ] **步骤 6：实现偏好读写**

`DesktopPreferences` 增加可选 `defaultTerminalShellId?: string`。`patch` 的入参允许 `defaultTerminalShellId?: string | null`（`null` 表示这次要清掉）。

`get` / `patch` 必须同时读回 `notificationMode`、`defaultOpenerId`、`defaultTerminalShellId`。`patch` 先合并再分别规范化，规范化后为空的字段**不要写进对象**，也不要写成 JSON `null`：

```ts
const next = { ...getDesktopPreferences(), ...patch }
const defaultOpenerId = normalizeDefaultOpenerId(next.defaultOpenerId)
const defaultTerminalShellId = normalizeDefaultTerminalShellId(next.defaultTerminalShellId)
const persisted: DesktopPreferences = {
  notificationMode: next.notificationMode,
  ...(defaultOpenerId ? { defaultOpenerId } : {}),
  ...(defaultTerminalShellId ? { defaultTerminalShellId } : {}),
}
writeFileSync(getDesktopPreferencesPath(), JSON.stringify(persisted, null, 2), "utf8")
```

`null` 并进 `next` 后，`normalizeDefaultTerminalShellId(null)` 得到 `null`，该项被省略。写盘失败继续让 `writeFileSync` 抛错。

- [ ] **步骤 7：运行测试验证通过**

```bash
pnpm --filter @vykor/desktop exec vitest run src/main/features/settings/settings-service.test.ts src/main/features/settings/desktop-preferences.test.ts src/renderer/src/stores/desktop-session/notification-observer.test.ts src/renderer/src/components/desktop/settings-page/default-opener-control.test.ts
```

预期：PASS。

- [ ] **步骤 8：Commit**

```bash
git add apps/desktop/src/shared/settings-types.ts apps/desktop/src/main/features/settings/desktop-preferences.ts apps/desktop/src/main/features/settings/settings-service.test.ts apps/desktop/src/main/features/settings/desktop-preferences.test.ts apps/desktop/src/renderer/src/stores/desktop-session/notification-observer.test.ts apps/desktop/src/renderer/src/components/desktop/settings-page/default-opener-control.test.ts
git commit -m "feat(desktop): persist default terminal shell id in desktop preferences"
```

---

### 任务 2：设置页写入 IPC

**文件：**
- 修改：`apps/desktop/src/main/features/settings/settings-service.ts`
- 修改：`apps/desktop/src/main/features/settings/ipc.ts`
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 修改：`apps/desktop/src/shared/desktop-api-contract.ts`
- 修改：`apps/desktop/src/preload/desktop-api.ts`

- [ ] **步骤 1：实现 `updateDefaultTerminalShell`**

对标 `updateDefaultOpener`。入参先 `normalizeDefaultTerminalShellId`。`null` / `system` / 空白都合法，表示清掉字段。然后 `patchDesktopPreferences({ defaultTerminalShellId })`（这里的值已经是 `string | null`），再 `snapshotWithPreferences`。写盘失败必须抛错。daemon 挂了仍返回本机三项，`workStyle` 回落 `practical`。

不要拒绝 `null`。打开目标那条「空串抛错」不适用于这项。

- [ ] **步骤 2：接通 IPC / 合约 / preload**

- `IpcChannels.settingsUpdateDefaultTerminalShell = "settings:update-default-terminal-shell"`
- `IpcInvokeMap`：`args: [input: UpdateDesktopDefaultTerminalShellInput]`，`result: DesktopSettingsSnapshot`
- `settingsIpcContribution` 增加 handler
- `desktop-api-contract` 的 `settings` 增加 `updateDefaultTerminalShell`
- `preload/desktop-api.ts` 同样挂上

渲染进程调用：`window.desktop.settings.updateDefaultTerminalShell({ defaultTerminalShellId: null })`

- [ ] **步骤 3：类型检查**

```bash
pnpm --filter @vykor/desktop run typecheck
```

预期：PASS。

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/main/features/settings/settings-service.ts apps/desktop/src/main/features/settings/ipc.ts apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/shared/desktop-api-contract.ts apps/desktop/src/preload/desktop-api.ts
git commit -m "feat(desktop): add default terminal shell settings IPC"
```

---

### 任务 3：检测本机 Shell 并解析 id

**文件：**
- 创建：`apps/desktop/src/shared/terminal-types.ts` 中的 `DesktopDetectedTerminalShell`（该文件已存在，只加类型）
- 创建：`apps/desktop/src/main/features/terminal/detect-shells.ts`
- 测试：`apps/desktop/src/main/features/terminal/detect-shells.test.ts`
- 修改：`apps/desktop/src/main/features/terminal/ipc.ts`、`ipc-channels.ts`、`desktop-api-contract.ts`、`preload/desktop-api.ts`

- [ ] **步骤 1：编写失败的检测 / 解析测试**

```ts
import { describe, expect, it } from "vitest"
import {
  listDetectedTerminalShells,
  resolvePreferredTerminalShell,
  toPublicTerminalShells,
} from "./detect-shells"

const windowsEnv = {
  Path: "C:\\Pwsh;C:\\Windows\\System32",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  SystemRoot: "C:\\Windows",
  ComSpec: "C:\\Windows\\System32\\cmd.exe",
}

it("lists only existing Windows shells and never returns git-bash.exe", () => {
  const exists = new Set([
    "C:\\Pwsh\\pwsh.exe",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "C:\\Windows\\System32\\cmd.exe",
    "C:\\Program Files\\Git\\git-bash.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe",
  ])
  const shells = listDetectedTerminalShells({
    platform: "win32",
    env: windowsEnv,
    fileExists: (path) => exists.has(path),
    joinPath: (...parts) => parts.join("\\"),
  })
  expect(shells.map((item) => item.id)).toEqual(["pwsh", "powershell", "cmd", "git-bash"])
  expect(shells.find((item) => item.id === "git-bash")?.command).toBe(
    "C:\\Program Files\\Git\\bin\\bash.exe"
  )
  expect(toPublicTerminalShells(shells).every((item) => !("command" in item))).toBe(true)
})

it("omits Git Bash when only the windowed launcher exists", () => {
  const exists = new Set([
    "C:\\Windows\\System32\\cmd.exe",
    "C:\\Program Files\\Git\\git-bash.exe",
  ])
  const shells = listDetectedTerminalShells({
    platform: "win32",
    env: windowsEnv,
    fileExists: (path) => exists.has(path),
    joinPath: (...parts) => parts.join("\\"),
  })
  expect(shells.map((item) => item.id)).toEqual(["cmd"])
})

it("lists macOS and Linux binaries that exist", () => {
  expect(
    listDetectedTerminalShells({
      platform: "darwin",
      env: {},
      fileExists: (path) => path === "/bin/zsh",
      joinPath: (...parts) => parts.join("/"),
    }).map((item) => item.id)
  ).toEqual(["zsh"])
  expect(
    listDetectedTerminalShells({
      platform: "linux",
      env: {},
      fileExists: (path) => path === "/bin/bash" || path === "/bin/sh",
      joinPath: (...parts) => parts.join("/"),
    }).map((item) => item.id)
  ).toEqual(["bash", "sh"])
})

it("resolves a known id to its command and falls back when missing", () => {
  const shells = [
    { id: "pwsh", label: "PowerShell 7", command: "C:\\Pwsh\\pwsh.exe" },
  ]
  expect(resolvePreferredTerminalShell("pwsh", shells)).toBe("C:\\Pwsh\\pwsh.exe")
  expect(resolvePreferredTerminalShell("git-bash", shells)).toBeUndefined()
  expect(resolvePreferredTerminalShell(null, shells)).toBeUndefined()
  expect(resolvePreferredTerminalShell("system", shells)).toBeUndefined()
})
```

Windows PATH 查找按目录拼接 `pwsh.exe`。`joinPath` 由测试注入，避免 CI 在 Linux 上把 Windows 路径拼错。

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm --filter @vykor/desktop exec vitest run src/main/features/terminal/detect-shells.test.ts
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现检测和解析**

内部类型不要进渲染进程合约：

```ts
export type DetectedTerminalShell = { id: string; label: string; command: string }

export function toPublicTerminalShells(
  shells: DetectedTerminalShell[]
): Array<{ id: string; label: string }> {
  return shells.map(({ id, label }) => ({ id, label }))
}

export function resolvePreferredTerminalShell(
  id: string | null | undefined,
  shells: DetectedTerminalShell[]
): string | undefined {
  const normalized = normalizeDefaultTerminalShellId(id)
  if (!normalized) return undefined
  return shells.find((item) => item.id === normalized)?.command
}
```

`listDetectedTerminalShells(ops)` 按 `ops.platform` 只收集 `fileExists` 为真的项：

| platform | id | label | command 怎么找 |
|---|---|---|---|
| win32 | `pwsh` | PowerShell 7 | PATH（`env.Path` / `env.PATH`，`;` 分隔）上的 `pwsh.exe` |
| win32 | `powershell` | Windows PowerShell | `join(SystemRoot, System32, WindowsPowerShell, v1.0, powershell.exe)`，否则 PATH 上的 `powershell.exe` |
| win32 | `cmd` | 命令提示符 | `env.ComSpec` / `env.COMSPEC` 且存在，否则 PATH 上的 `cmd.exe` |
| win32 | `git-bash` | Git Bash | 先找 PTY 用的 `Git\\bin\\bash.exe` 或 `Git\\usr\\bin\\bash.exe`（Program Files / x86）。**不要**把 `git-bash.exe` 当作 `command`。只有启动器、没有 `bash.exe` 时不列入 |
| darwin | `zsh` / `bash` | 同名 | `/bin/zsh`、`/bin/bash` |
| linux | `bash` / `sh` | 同名 | `/bin/bash`、`/bin/sh` |

不列 `system`，不加 `$SHELL`。无参数重载给主进程用：`listDetectedTerminalShells()` 默认 `process.platform`、`process.env`、`existsSync`、`path.join`。

- [ ] **步骤 4：接通 `terminal:list-shells`**

- 共享类型：`export type DesktopDetectedTerminalShell = { id: string; label: string }`
- `IpcChannels.terminalListShells = "terminal:list-shells"`，结果 `DesktopDetectedTerminalShell[]`
- handler：`toPublicTerminalShells(listDetectedTerminalShells())`
- `window.desktop.terminal.listShells()`

- [ ] **步骤 5：运行测试验证通过**

```bash
pnpm --filter @vykor/desktop exec vitest run src/main/features/terminal/detect-shells.test.ts
pnpm --filter @vykor/desktop run typecheck
```

预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add apps/desktop/src/main/features/terminal/detect-shells.ts apps/desktop/src/main/features/terminal/detect-shells.test.ts apps/desktop/src/main/features/terminal/ipc.ts apps/desktop/src/shared/terminal-types.ts apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/shared/desktop-api-contract.ts apps/desktop/src/preload/desktop-api.ts
git commit -m "feat(desktop): detect installed shells for the integrated terminal"
```

---

### 任务 4：创建终端时按偏好补路径

**文件：**
- 创建：`apps/desktop/src/main/features/terminal/apply-preferred-shell.ts`
- 测试：`apps/desktop/src/main/features/terminal/apply-preferred-shell.test.ts`
- 修改：`apps/desktop/src/main/features/terminal/terminal-service.ts`

- [ ] **步骤 1：编写失败的补全测试**

```ts
import { describe, expect, it } from "vitest"
import { applyPreferredTerminalShell } from "./apply-preferred-shell"

const base = {
  projectId: "p1",
  runtime: "local" as const,
  cols: 80,
  rows: 24,
}

it("fills shell for local terminals when the caller omitted it", () => {
  expect(applyPreferredTerminalShell(base, "C:\\Pwsh\\pwsh.exe").shell).toBe("C:\\Pwsh\\pwsh.exe")
})

it("does not override an explicit shell or non-local runtime", () => {
  expect(
    applyPreferredTerminalShell({ ...base, shell: "C:\\Custom\\bash.exe" }, "C:\\Pwsh\\pwsh.exe").shell
  ).toBe("C:\\Custom\\bash.exe")
  expect(applyPreferredTerminalShell({ ...base, runtime: "sandbox" }, "C:\\Pwsh\\pwsh.exe").shell).toBe(
    undefined
  )
})

it("omits shell when no preferred command is available", () => {
  expect(applyPreferredTerminalShell(base, undefined).shell).toBeUndefined()
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm --filter @vykor/desktop exec vitest run src/main/features/terminal/apply-preferred-shell.test.ts
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现补全并接到 `terminal.create`**

```ts
export function applyPreferredTerminalShell<T extends { runtime: string; shell?: string }>(
  input: T,
  preferredCommand: string | undefined
): T {
  if (input.shell?.trim()) return input
  if (input.runtime !== "local" || !preferredCommand) return input
  return { ...input, shell: preferredCommand }
}
```

`DesktopTerminalService.create` 在 `ensureSubscription` 之后、`client.createTerminal` 之前：

```ts
const preferred = resolvePreferredTerminalShell(
  getDesktopPreferences().defaultTerminalShellId ?? null,
  listDetectedTerminalShells()
)
const next = applyPreferredTerminalShell(input, preferred)
return await withDaemonRetry((client) => client.createTerminal(next))
```

只传路径，不要拼参数。

- [ ] **步骤 4：运行测试验证通过**

```bash
pnpm --filter @vykor/desktop exec vitest run src/main/features/terminal/apply-preferred-shell.test.ts src/main/features/terminal/detect-shells.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/main/features/terminal/apply-preferred-shell.ts apps/desktop/src/main/features/terminal/apply-preferred-shell.test.ts apps/desktop/src/main/features/terminal/terminal-service.ts
git commit -m "feat(desktop): apply preferred shell when creating local terminals"
```

---

### 任务 5：设置页真实下拉

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/resolve-selected-terminal-shell.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/default-terminal-shell-control.tsx`
- 测试：`apps/desktop/src/renderer/src/components/desktop/settings-page/resolve-selected-terminal-shell.test.ts`
- 测试：`apps/desktop/src/renderer/src/components/desktop/settings-page/default-terminal-shell-control.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx`

- [ ] **步骤 1：编写失败的选中项测试**

```ts
import { describe, expect, it } from "vitest"
import { resolveSelectedTerminalShellId } from "./resolve-selected-terminal-shell"

const shells = [
  { id: "pwsh", label: "PowerShell 7" },
  { id: "cmd", label: "命令提示符" },
]

it("uses the saved id when it is still installed", () => {
  expect(resolveSelectedTerminalShellId("pwsh", shells)).toBe("pwsh")
})

it("falls back to system when the saved id is gone or empty", () => {
  expect(resolveSelectedTerminalShellId("git-bash", shells)).toBe("system")
  expect(resolveSelectedTerminalShellId(null, shells)).toBe("system")
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/settings-page/resolve-selected-terminal-shell.test.ts
```

预期：FAIL，函数不存在。

- [ ] **步骤 3：实现选中项解析**

```ts
export const SYSTEM_TERMINAL_SHELL_ID = "system"

export function resolveSelectedTerminalShellId(
  savedId: string | null,
  shells: Array<{ id: string }>
): string {
  if (savedId && shells.some((item) => item.id === savedId)) return savedId
  return SYSTEM_TERMINAL_SHELL_ID
}
```

- [ ] **步骤 4：编写失败的控件测试**

对标 `default-opener-control.test.ts`：jsdom、`createRoot`、`act`。mock：

```ts
settings: { snapshot, updateDefaultTerminalShell }
terminal: { listShells }
```

断言：

1. 文案有「系统默认」和「PowerShell 7」，没有写死的单独「PowerShell」按钮（触发按钮在偏好读完前显示「正在读取…」，读完后显示当前项）
2. snapshot 为 `git-bash` 但列表里没有时，触发按钮显示「系统默认」
3. 点「PowerShell 7」调用 `updateDefaultTerminalShell({ defaultTerminalShellId: "pwsh" })`
4. 点「系统默认」调用 `updateDefaultTerminalShell({ defaultTerminalShellId: null })`
5. `listShells` 失败或返回 `[]` 时仍能看到「系统默认」，触发按钮不禁用到不能选系统默认（列表为空时 Select 仍启用，只有加载中 / 保存中禁用）
6. 保存抛错时，触发按钮回到改之前的文案，并出现红色说明

`aria-label` 用「集成终端 Shell」。

- [ ] **步骤 5：运行控件测试验证失败**

```bash
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/settings-page/default-terminal-shell-control.test.ts
```

预期：FAIL，控件不存在。

- [ ] **步骤 6：实现控件并替换占位**

```tsx
const resolvedId = preferenceReady
  ? resolveSelectedTerminalShellId(defaultTerminalShellId, shells)
  : ""

const update = (nextId: string): void => {
  const persisted = nextId === SYSTEM_TERMINAL_SHELL_ID ? null : nextId
  if (saving || persisted === defaultTerminalShellId) return
  const previous = defaultTerminalShellId
  setDefaultTerminalShellId(persisted)
  setSaving(true)
  setError(null)
  void window.desktop.settings
    .updateDefaultTerminalShell({ defaultTerminalShellId: persisted })
    .then((snapshot) => setDefaultTerminalShellId(snapshot.defaultTerminalShellId))
    .catch((saveError: unknown) => {
      setDefaultTerminalShellId(previous)
      setError(errorMessage(saveError))
    })
    .finally(() => setSaving(false))
}
```

打开时 `Promise.all([settings.snapshot(), terminal.listShells()])`。`Select` 的 `value` 用 `resolvedId`（未就绪为 `""`，不要用它当 `SelectItem`）。第一项 `SelectItem value="system"` 文案「系统默认」。触发按钮 `aria-label="集成终端 Shell"`：未就绪显示「正在读取…」，就绪后显示当前项 label。失败回滚，右侧 `errorMessage`。图标继续用 `TerminalSquare`。

`settings-content.tsx` 把写死的 `SettingSelect icon={<TerminalSquare />} label="PowerShell"` 换成 `<DefaultTerminalShellControl />`。

- [ ] **步骤 7：运行测试验证通过**

```bash
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/settings-page/resolve-selected-terminal-shell.test.ts src/renderer/src/components/desktop/settings-page/default-terminal-shell-control.test.ts src/renderer/src/components/desktop/settings-page/default-opener-control.test.ts
```

预期：PASS。

- [ ] **步骤 8：Commit**

```bash
git add apps/desktop/src/renderer/src/components/desktop/settings-page/resolve-selected-terminal-shell.ts apps/desktop/src/renderer/src/components/desktop/settings-page/resolve-selected-terminal-shell.test.ts apps/desktop/src/renderer/src/components/desktop/settings-page/default-terminal-shell-control.tsx apps/desktop/src/renderer/src/components/desktop/settings-page/default-terminal-shell-control.test.ts apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx
git commit -m "feat(desktop): wire integrated terminal shell setting"
```

---

### 任务 6：创建入参不再读项目 Shell，侧边栏拿掉入口

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/desktop/tools/terminal/user-terminal-create-input.ts`
- 测试：`apps/desktop/src/renderer/src/components/desktop/tools/terminal/user-terminal-create-input.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/terminal/terminal-tool.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/project-menu-items.ts`
- 测试：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/project-menu-items.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx`

- [ ] **步骤 1：编写失败的创建入参测试**

```ts
import { describe, expect, it } from "vitest"
import { userTerminalCreateInput } from "./user-terminal-create-input"

it("never forwards a project default shell", () => {
  const projectDefaultShell = "C:\\Windows\\System32\\cmd.exe"
  const input = userTerminalCreateInput({
    projectId: "p1",
    runtime: "local",
    name: "终端 1",
    cols: 80,
    rows: 24,
  })
  expect(input).toEqual({
    projectId: "p1",
    runtime: "local",
    name: "终端 1",
    cols: 80,
    rows: 24,
  })
  expect(input).not.toHaveProperty("shell")
  expect(projectDefaultShell).toBeTruthy()
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/tools/terminal/user-terminal-create-input.test.ts
```

预期：FAIL，函数不存在。

- [ ] **步骤 3：实现入参函数并改 `terminal-tool`**

```ts
import type { DesktopTerminalCreateInput } from "@shared/terminal-types"

export function userTerminalCreateInput(input: {
  projectId: string
  runtime: DesktopTerminalCreateInput["runtime"]
  name: string
  cols: number
  rows: number
}): DesktopTerminalCreateInput {
  return {
    projectId: input.projectId,
    runtime: input.runtime,
    name: input.name,
    cols: input.cols,
    rows: input.rows,
  }
}
```

`createTerminal` 里删掉 `project.defaultShell` 分支，改为：

```ts
const nextRecord = await window.desktop.terminal.create(
  userTerminalCreateInput({
    projectId: project.id,
    runtime: runtimeMode,
    name,
    cols: terminal.cols || 80,
    rows: terminal.rows || 24,
  })
)
```

不要挂载 `TerminalTool`。

- [ ] **步骤 4：编写失败的菜单测试**

```ts
import { describe, expect, it } from "vitest"
import { projectMenuItems } from "./project-menu-items"

it("does not offer a per-project default shell action", () => {
  const labels = projectMenuItems(false).map((item) => item.label)
  expect(labels).not.toContain("设置默认 Shell")
  expect(projectMenuItems(false).map((item) => item.id)).not.toContain("set-default-shell")
  expect(labels).toEqual([
    "置顶项目",
    "在资源管理器中打开",
    "重新绑定目录",
    "重命名项目",
    "从列表移除",
  ])
})
```

- [ ] **步骤 5：运行菜单测试验证失败**

```bash
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/layout/main-layout/project-menu-items.test.ts
```

预期：FAIL，模块不存在。

- [ ] **步骤 6：抽出菜单项并改 sidebar**

```ts
export function projectMenuItems(pinned: boolean): Array<{ id: string; label: string }> {
  return [
    { id: "pin", label: pinned ? "取消置顶项目" : "置顶项目" },
    { id: "reveal", label: "在资源管理器中打开" },
    { id: "rebind", label: "重新绑定目录" },
    { id: "rename", label: "重命名项目" },
    { id: "remove", label: "从列表移除" },
  ]
}
```

`ProjectRow` 下拉按这些 id 绑回现有点击逻辑。拿掉：

- 「设置默认 Shell」菜单项
- 默认 Shell 对话框
- `projectShell` / `shellProjectTarget` / `beginProjectShellSettings` / `submitProjectShell`
- `ProjectActions.onSetDefaultShell`

`setProjectDefaultShell` 的 IPC、store、项目表字段留着，只是界面不再调用。

- [ ] **步骤 7：运行相关测试并做完成前验证**

```bash
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/tools/terminal/user-terminal-create-input.test.ts src/renderer/src/components/desktop/layout/main-layout/project-menu-items.test.ts src/main/features/settings src/main/features/terminal src/renderer/src/components/desktop/settings-page
pnpm --filter @vykor/desktop run typecheck
```

预期：全部 PASS。

- [ ] **步骤 8：Commit**

```bash
git add apps/desktop/src/renderer/src/components/desktop/tools/terminal/user-terminal-create-input.ts apps/desktop/src/renderer/src/components/desktop/tools/terminal/user-terminal-create-input.test.ts apps/desktop/src/renderer/src/components/desktop/tools/terminal/terminal-tool.tsx apps/desktop/src/renderer/src/components/desktop/layout/main-layout/project-menu-items.ts apps/desktop/src/renderer/src/components/desktop/layout/main-layout/project-menu-items.test.ts apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx
git commit -m "feat(desktop): drop per-project default shell from new terminals"
```

---

## 规格覆盖自检

| 规格章节 | 任务 |
|---|---|
| 数据存哪 / 清字段 / 不写 `null` | 1 |
| snapshot 形状（含会立刻红的四个测试文件） | 1 |
| `updateDefaultTerminalShell` IPC | 2 |
| `terminal:list-shells` 对外无 `command` | 3 |
| Windows / macOS / Linux 检测表、Git Bash 用 `bash.exe` | 3 |
| `resolvePreferredTerminalShell` | 3 |
| 创建补全 / 不覆盖已有 `shell` / 非本地不补 | 4 |
| 设置页独立控件、哨兵 `system`、保存 `null` | 5 |
| `terminal-tool` 不再传 `project.defaultShell` | 6 |
| 侧边栏拿掉入口、IPC 保留 | 6 |
| 不改运行环境 / Agent / 沙箱 / `resolveDefaultShell` | 各任务「不要做」 |
