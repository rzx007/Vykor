# 默认文件打开目标实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 设置页「默认文件打开目标」成为本机唯一写入点；回到对话后，右上角和文件树用同一份默认打开方式与同一套图标。

**架构：** 默认值进 Electron `userData/desktop-preferences.json` 的 `defaultOpenerId`，和通知模式同一份文件。设置页独占写入；右上角 / 文件树只打开。`settings.snapshot()` 先读本机偏好，daemon 只补工作风格，挂了也不丢本机字段。解析函数抽出共用：命中已保存 id，否则 Cursor → VS Code → 第一项。

**技术栈：** Electron、React、现有 settings IPC、`listOpeners()` / `OpenerIcon`、Vitest。

**规格：** `docs/superpowers/specs/2026-09-06-default-file-open-target-design.md`

**不要做：** 运行环境、集成终端 Shell、迁移旧 localStorage、窗口内事件同步、改 opener 检测。

**工作区注意：** 实现前先单独 commit 修订后的规格。不要把 `docs/superpowers/*outside-cwd-file-preview*` 或其它无关改动加进这次提交。

---

## 文件结构

- 修改：`apps/desktop/src/shared/settings-types.ts`
  - `defaultOpenerId`、`UpdateDesktopDefaultOpenerInput`、`normalizeDefaultOpenerId`、snapshot 拼装。
- 修改：`apps/desktop/src/main/features/settings/desktop-preferences.ts`
  - 两字段一起读回；写失败抛错；文件里没有 opener 时不要写 `null`。
- 修改：`apps/desktop/src/main/features/settings/settings-service.ts`
  - `updateDefaultOpener`；snapshot / 本机更新在 daemon 挂了时仍返回本机字段。
- 修改：`apps/desktop/src/main/features/settings/ipc.ts`、`apps/desktop/src/shared/ipc-channels.ts`、`apps/desktop/src/shared/desktop-api-contract.ts`、`apps/desktop/src/preload/desktop-api.ts`
  - 暴露 `settings:update-default-opener`。
- 创建：`apps/desktop/src/renderer/src/components/desktop/open-with/resolve-selected-opener.ts`
  - 从 hook 抽出的共用解析。
- 修改：`apps/desktop/src/renderer/src/components/desktop/open-with/use-workspace-openers.ts`
  - 读 snapshot 的 `defaultOpenerId`；去掉 persist / localStorage。
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/settings-error-message.ts`
  - 从 `settings-content.tsx` 挪出已有的 IPC 错误文案清洗。
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/default-opener-control.tsx`
  - 设置页真实下拉。
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx`
  - 换上 `DefaultOpenerControl`。
- 修改：`apps/desktop/src/renderer/src/components/desktop/open-with/open-with-split-button.tsx`
  - `launchWorkspaceOpener` 不再 persist。
- 修改：`apps/desktop/src/renderer/src/components/desktop/open-with/open-with-submenu.tsx`
  - 当前默认项高亮。
- 测试：
  - `apps/desktop/src/main/features/settings/desktop-preferences.test.ts`
  - `apps/desktop/src/main/features/settings/settings-service.test.ts`
  - `apps/desktop/src/renderer/src/stores/desktop-session/notification-observer.test.ts`
  - 创建 `apps/desktop/src/renderer/src/components/desktop/open-with/resolve-selected-opener.test.ts`
  - 创建 `apps/desktop/src/renderer/src/components/desktop/open-with/use-workspace-openers.test.ts`
  - 创建 `apps/desktop/src/renderer/src/components/desktop/settings-page/default-opener-control.test.ts`

---

### 任务 1：本机偏好和 snapshot 形状

**文件：**
- 修改：`apps/desktop/src/shared/settings-types.ts`
- 修改：`apps/desktop/src/main/features/settings/desktop-preferences.ts`
- 测试：`apps/desktop/src/main/features/settings/settings-service.test.ts`
- 测试：`apps/desktop/src/main/features/settings/desktop-preferences.test.ts`
- 测试：`apps/desktop/src/renderer/src/stores/desktop-session/notification-observer.test.ts`

- [ ] **步骤 1：先单独 commit 修订规格**

```bash
git add docs/superpowers/specs/2026-09-06-default-file-open-target-design.md
git commit -m "docs: tighten default file open target spec after review"
```

不要 add 其它文件。

- [ ] **步骤 2：编写失败的 snapshot 测试**

把 `settings-service.test.ts` 里现有 `toEqual` 改成包含 `defaultOpenerId: null`，并追加：

```ts
it("defaults defaultOpenerId to null", () => {
  expect(buildDesktopSettingsSnapshot({})).toEqual({
    workStyle: "practical",
    notificationMode: "when_unfocused",
    defaultOpenerId: null,
  })
})

it("preserves a valid default opener id", () => {
  expect(
    buildDesktopSettingsSnapshot({}, { defaultOpenerId: "  vscode  " })
  ).toMatchObject({ defaultOpenerId: "vscode" })
})

it("rejects blank default opener ids", () => {
  expect(buildDesktopSettingsSnapshot({}, { defaultOpenerId: "   " })).toMatchObject({
    defaultOpenerId: null,
  })
})
```

现有三条 `toEqual`（practical / efficient / chatty）也必须带上 `defaultOpenerId: null`，否则实现后会红。

同步改 `notification-observer.test.ts` 三处 snapshot 字面量，加上 `defaultOpenerId: null`，避免类型检查挂掉。这一步只改 mock，不改 observer 行为。

- [ ] **步骤 3：运行测试验证失败**

```bash
pnpm --filter @vykor/desktop exec vitest run src/main/features/settings/settings-service.test.ts
```

预期：FAIL，snapshot 还没有 `defaultOpenerId`。

- [ ] **步骤 4：实现类型和 snapshot 拼装**

在 `settings-types.ts` 增加：

```ts
export interface DesktopSettingsSnapshot {
  workStyle: DesktopWorkStyle
  notificationMode: DesktopNotificationMode
  defaultOpenerId: string | null
}

export interface UpdateDesktopDefaultOpenerInput {
  defaultOpenerId: string
}

export function normalizeDefaultOpenerId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function buildDesktopSettingsSnapshot(
  settings: Record<string, unknown>,
  preferences: Partial<{ notificationMode: unknown; defaultOpenerId: unknown }> = {},
): DesktopSettingsSnapshot {
  return {
    workStyle: isDesktopWorkStyle(settings.workStyle) ? settings.workStyle : "practical",
    notificationMode: isDesktopNotificationMode(preferences.notificationMode)
      ? preferences.notificationMode
      : "when_unfocused",
    defaultOpenerId: normalizeDefaultOpenerId(preferences.defaultOpenerId),
  }
}
```

- [ ] **步骤 5：运行 snapshot 测试验证通过**

```bash
pnpm --filter @vykor/desktop exec vitest run src/main/features/settings/settings-service.test.ts src/renderer/src/stores/desktop-session/notification-observer.test.ts
```

预期：PASS。

- [ ] **步骤 6：编写失败的本机偏好测试**

在 `desktop-preferences.test.ts` 追加（现有 `toEqual({ notificationMode })` 保持「没有 defaultOpenerId 字段」）：

```ts
it("reads a valid default opener id without dropping notification mode", async () => {
  await writeFile(
    join(userDataPath, "desktop-preferences.json"),
    JSON.stringify({ notificationMode: "always", defaultOpenerId: "vscode" }),
    "utf8",
  )
  const { getDesktopPreferences } = await import("./desktop-preferences")
  expect(getDesktopPreferences()).toEqual({
    notificationMode: "always",
    defaultOpenerId: "vscode",
  })
})

it("treats blank default opener ids as missing", async () => {
  await writeFile(
    join(userDataPath, "desktop-preferences.json"),
    JSON.stringify({ notificationMode: "never", defaultOpenerId: "   " }),
    "utf8",
  )
  const { getDesktopPreferences } = await import("./desktop-preferences")
  expect(getDesktopPreferences()).toEqual({ notificationMode: "never" })
})

it("keeps defaultOpenerId when patching notification mode", async () => {
  const { patchDesktopPreferences, getDesktopPreferences } = await import("./desktop-preferences")
  patchDesktopPreferences({ defaultOpenerId: "cursor" })
  patchDesktopPreferences({ notificationMode: "always" })
  expect(getDesktopPreferences()).toEqual({
    notificationMode: "always",
    defaultOpenerId: "cursor",
  })
})

it("keeps notification mode when patching defaultOpenerId", async () => {
  const { patchDesktopPreferences, getDesktopPreferences } = await import("./desktop-preferences")
  patchDesktopPreferences({ notificationMode: "never" })
  patchDesktopPreferences({ defaultOpenerId: "vscode" })
  expect(getDesktopPreferences()).toEqual({
    notificationMode: "never",
    defaultOpenerId: "vscode",
  })
})

it("throws when the preferences file cannot be written", async () => {
  const { mkdir } = await import("node:fs/promises")
  await mkdir(join(userDataPath, "desktop-preferences.json"))
  const { patchDesktopPreferences } = await import("./desktop-preferences")
  expect(() => patchDesktopPreferences({ defaultOpenerId: "vscode" })).toThrow()
})
```

- [ ] **步骤 7：运行偏好测试验证失败**

```bash
pnpm --filter @vykor/desktop exec vitest run src/main/features/settings/desktop-preferences.test.ts
```

预期：FAIL，读回没有 `defaultOpenerId`，写失败也不抛。

- [ ] **步骤 8：实现偏好读写**

`DesktopPreferences` 增加可选 `defaultOpenerId?: string`。`getDesktopPreferences` 用 `normalizeDefaultOpenerId`：有值就放进对象，没有就省略字段。`defaults` 仍只有 `notificationMode`。

`patchDesktopPreferences`：`const next = { ...getDesktopPreferences(), ...patch }`，写盘失败必须 `throw`（不要只 `console.warn` 后返回 `next`）。序列化 `next` 时，没有 opener 就不要带 `defaultOpenerId: null`。

- [ ] **步骤 9：运行偏好测试验证通过**

```bash
pnpm --filter @vykor/desktop exec vitest run src/main/features/settings/desktop-preferences.test.ts
```

预期：PASS。

- [ ] **步骤 10：Commit**

```bash
git add apps/desktop/src/shared/settings-types.ts apps/desktop/src/main/features/settings/desktop-preferences.ts apps/desktop/src/main/features/settings/desktop-preferences.test.ts apps/desktop/src/main/features/settings/settings-service.test.ts apps/desktop/src/renderer/src/stores/desktop-session/notification-observer.test.ts
git commit -m "feat(desktop): persist default opener id in desktop preferences"
```

---

### 任务 2：settings 服务和 IPC

**文件：**
- 修改：`apps/desktop/src/main/features/settings/settings-service.ts`
- 修改：`apps/desktop/src/main/features/settings/ipc.ts`
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 修改：`apps/desktop/src/shared/desktop-api-contract.ts`
- 修改：`apps/desktop/src/preload/desktop-api.ts`

- [ ] **步骤 1：实现 daemon 失败仍返回本机字段**

在 `settings-service.ts` 增加：

```ts
async function snapshotWithPreferences(
  preferences: ReturnType<typeof getDesktopPreferences>,
): Promise<DesktopSettingsSnapshot> {
  try {
    return await withDaemonRetry(async (client) =>
      buildDesktopSettingsSnapshot(await client.getSettings(), preferences),
    )
  } catch {
    return buildDesktopSettingsSnapshot({}, preferences)
  }
}
```

`snapshot()` 改为：`return snapshotWithPreferences(getDesktopPreferences())`。

`updateNotificationMode` 在 `patchDesktopPreferences` 成功后改走 `snapshotWithPreferences(preferences)`，不要再让 daemon 挂掉把已经写成功的通知模式说成失败。

- [ ] **步骤 2：实现 `updateDefaultOpener`**

```ts
async updateDefaultOpener(
  input: UpdateDesktopDefaultOpenerInput,
): Promise<DesktopSettingsSnapshot> {
  const defaultOpenerId = normalizeDefaultOpenerId(input.defaultOpenerId)
  if (!defaultOpenerId) {
    throw new Error("打开方式不能为空。")
  }
  const preferences = patchDesktopPreferences({ defaultOpenerId })
  return snapshotWithPreferences(preferences)
}
```

不要在这里检查应用是否已安装。打开时仍由 `opener-service` 按 id 查表。

- [ ] **步骤 3：接通 IPC**

`IpcChannels` 增加 `settingsUpdateDefaultOpener: "settings:update-default-opener"`。

`IpcInvokeMap`：

```ts
[IpcChannels.settingsUpdateDefaultOpener]: {
  args: [input: UpdateDesktopDefaultOpenerInput]
  result: DesktopSettingsSnapshot
}
```

`ipc.ts` 增加 handler：`desktopSettingsService.updateDefaultOpener(input)`。

`desktop-api-contract.ts` 和 `preload/desktop-api.ts` 的 `settings` 增加：

```ts
updateDefaultOpener: (input: UpdateDesktopDefaultOpenerInput) => Promise<DesktopSettingsSnapshot>
```

preload 实现：`invoke(IpcChannels.settingsUpdateDefaultOpener, input)`。

- [ ] **步骤 4：类型检查**

```bash
pnpm --filter @vykor/desktop typecheck
```

预期：PASS。若还有其它 snapshot 字面量缺 `defaultOpenerId`，按同样方式补 `null`，不要改那些测试的行为断言。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/main/features/settings/settings-service.ts apps/desktop/src/main/features/settings/ipc.ts apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/shared/desktop-api-contract.ts apps/desktop/src/preload/desktop-api.ts
git commit -m "feat(desktop): add default opener settings IPC"
```

---

### 任务 3：共用解析，右上角只打开

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/desktop/open-with/resolve-selected-opener.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/open-with/resolve-selected-opener.test.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/open-with/use-workspace-openers.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/open-with/use-workspace-openers.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/open-with/open-with-split-button.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/open-with/index.ts`

- [ ] **步骤 1：编写失败的解析测试**

创建 `resolve-selected-opener.test.ts`：

```ts
import { describe, expect, it } from "vitest"
import type { WorkspaceOpener } from "@shared/workspace-types"
import { resolveSelectedOpener } from "./resolve-selected-opener"

const openers = [
  opener("explorer", "folder"),
  opener("vscode", "editor"),
  opener("cursor", "editor"),
] satisfies WorkspaceOpener[]

function opener(id: string, kind: WorkspaceOpener["kind"]): WorkspaceOpener {
  return { id, label: id, kind, iconDataUrl: null }
}

describe("resolveSelectedOpener", () => {
  it("returns null when the list is empty", () => {
    expect(resolveSelectedOpener([], "vscode")).toBeNull()
  })

  it("uses the saved id when it is still installed", () => {
    expect(resolveSelectedOpener(openers, "vscode")?.id).toBe("vscode")
  })

  it("falls back to cursor then vscode then the first opener", () => {
    expect(resolveSelectedOpener(openers, "gone")?.id).toBe("cursor")
    expect(resolveSelectedOpener(openers.filter((item) => item.id !== "cursor"), null)?.id).toBe(
      "vscode",
    )
    expect(
      resolveSelectedOpener(
        openers.filter((item) => item.id !== "cursor" && item.id !== "vscode"),
        "gone",
      )?.id,
    ).toBe("explorer")
  })
})
```

- [ ] **步骤 2：运行解析测试验证失败**

```bash
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/open-with/resolve-selected-opener.test.ts
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：抽出解析函数**

创建 `resolve-selected-opener.ts`，逻辑与现在 hook 里的私有函数相同：

```ts
import type { WorkspaceOpener } from "@shared/workspace-types"

export function resolveSelectedOpener(
  openers: WorkspaceOpener[],
  selectedId: string | null,
): WorkspaceOpener | null {
  if (openers.length === 0) return null
  return (
    openers.find((opener) => opener.id === selectedId) ??
    openers.find((opener) => opener.id === "cursor") ??
    openers.find((opener) => opener.id === "vscode") ??
    openers[0] ??
    null
  )
}
```

从 `index.ts` 再导出它，供设置页使用。

- [ ] **步骤 4：运行解析测试验证通过**

```bash
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/open-with/resolve-selected-opener.test.ts
```

预期：PASS。

- [ ] **步骤 5：编写失败的写入方向测试**

创建 `use-workspace-openers.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest"
import { launchWorkspaceOpener } from "./use-workspace-openers"

describe("launchWorkspaceOpener", () => {
  const openWith = vi.fn(async () => undefined)
  const updateDefaultOpener = vi.fn(async () => undefined)

  beforeEach(() => {
    openWith.mockClear()
    updateDefaultOpener.mockClear()
    localStorage.clear()
    vi.stubGlobal("window", {
      desktop: {
        workspace: { openWith },
        settings: { updateDefaultOpener },
      },
    })
  })

  it("opens without writing the default opener or localStorage", async () => {
    await launchWorkspaceOpener({ openerId: "vscode", path: "E:/code/app" })
    expect(openWith).toHaveBeenCalledWith({
      openerId: "vscode",
      path: "E:/code/app",
      rootPath: undefined,
    })
    expect(updateDefaultOpener).not.toHaveBeenCalled()
    expect(localStorage.getItem("vykor.desktop.open-with.v1")).toBeNull()
  })
})
```

文件顶部加 `// @vitest-environment jsdom`（和其它 renderer 测试一样）。

- [ ] **步骤 6：运行写入方向测试验证失败**

```bash
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/open-with/use-workspace-openers.test.ts
```

预期：在改掉 `persist` 之前，若测试里仍传 `persist: true` 会写 localStorage。此测试不传 `persist`，当前实现已经不写；下一步是删掉 `persist` 参数本身，并让 hook 改读 snapshot。

- [ ] **步骤 7：改 hook，去掉 persist / localStorage**

`useWorkspaceOpeners`：

- 删掉 `persistedOpenerKey`、`vykor:open-with-changed`、`readPersistedOpenerId`、`writePersistedOpenerId`。
- `selectedId` 初始为 `null`，另加 `preferenceReady` 初始 `false`。
- 挂载时 `window.desktop.settings.snapshot()`，把 `defaultOpenerId` 写入 state；失败则当成 `null`。无论成败都把 `preferenceReady` 设为 `true`。
- `selected = preferenceReady ? resolveSelectedOpener(openers, selectedId) : null`。偏好没读完不要先画 Cursor / VS Code。
- `ready` 仍表示 `listOpeners()` 结束（成功或失败）。

`launchWorkspaceOpener` 去掉 `persist`，只调用 `window.desktop.workspace.openWith`。

`open-with-split-button.tsx` 里的调用改成：

```ts
await launchWorkspaceOpener({ openerId, path: folderPath })
```

不要再传 `persist: true`。

- [ ] **步骤 8：运行打开方式测试验证通过**

```bash
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/open-with/resolve-selected-opener.test.ts src/renderer/src/components/desktop/open-with/use-workspace-openers.test.ts
```

预期：PASS。

- [ ] **步骤 9：Commit**

```bash
git add apps/desktop/src/renderer/src/components/desktop/open-with
git commit -m "feat(desktop): read default opener from settings instead of last used"
```

---

### 任务 4：设置页下拉

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/default-opener-control.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/default-opener-control.test.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/settings-error-message.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx`

- [ ] **步骤 1：编写失败的设置页测试**

创建 `default-opener-control.test.ts`，环境 `jsdom`，参照 `attachment-storage-settings.test.ts` 的 `createRoot` + `act`：

```ts
const openers = [
  { id: "cursor", label: "Cursor", kind: "editor" as const, iconDataUrl: "data:image/png;base64,aaa" },
  { id: "vscode", label: "VS Code", kind: "editor" as const, iconDataUrl: null },
]

it("renders detected openers instead of a hardcoded VS Code button", async () => {
  snapshot.mockResolvedValue({
    workStyle: "practical",
    notificationMode: "when_unfocused",
    defaultOpenerId: "cursor",
  })
  listOpeners.mockResolvedValue(openers)
  await renderControl()
  expect(container.textContent).toContain("Cursor")
  expect(container.querySelector('button[aria-label="默认文件打开目标"]')?.textContent).not.toBe(
    "VS Code",
  )
  expect(container.querySelector('img[src="data:image/png;base64,aaa"]')).not.toBeNull()
})

it("uses the resolved opener when the saved id is gone", async () => {
  snapshot.mockResolvedValue({
    workStyle: "practical",
    notificationMode: "when_unfocused",
    defaultOpenerId: "gone",
  })
  listOpeners.mockResolvedValue(openers)
  await renderControl()
  expect(container.textContent).toContain("Cursor")
})

it("disables the control when no openers are installed", async () => {
  listOpeners.mockResolvedValue([])
  await renderControl()
  expect(container.textContent).toContain("未找到可用的打开方式")
  expect(
    container.querySelector('button[aria-label="默认文件打开目标"]'),
  ).toHaveProperty("disabled", true)
})

it("saves from the settings page only", async () => {
  await renderControl()
  await act(async () => {
    container.querySelector('button[aria-label="默认文件打开目标"]')?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    )
  })
  await act(async () => {
    Array.from(document.querySelectorAll("[role='option']"))
      .find((node) => node.textContent?.includes("VS Code"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
  expect(updateDefaultOpener).toHaveBeenCalledWith({ defaultOpenerId: "vscode" })
})
```

`window.desktop.settings.snapshot` / `updateDefaultOpener`、`window.desktop.workspace.listOpeners` 全部 mock。如果当前 Select 实现的 option 不在 `document` 上，改用组件库测试里已有的打开方式（先 `pointerdown` trigger，再点 item），断言不变。

- [ ] **步骤 2：运行设置页测试验证失败**

```bash
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/settings-page/default-opener-control.test.ts
```

预期：FAIL，控件还不存在。

- [ ] **步骤 3：实现 `DefaultOpenerControl`**

交互对齐 `WorkStyleControl` / `NotificationModeControl`：

- 并行读 `settings.snapshot()` 和 `workspace.listOpeners()`。
- `resolved = resolveSelectedOpener(openers, defaultOpenerId)`。
- Select 的 `value`、触发按钮文案 / `OpenerIcon` 都用 `resolved`，不要用可能已失效的原始 id。
- 每一项也用 `OpenerIcon`。
- 选一项调用 `settings.updateDefaultOpener({ defaultOpenerId })`，失败回滚并在右侧 `role="alert"` 显示错误。把 `settings-content.tsx` 里现有的 `errorMessage` 挪到同目录 `settings-error-message.ts`，设置页三个控件共用，不要新造文案体系。
- 列表为空：禁用，触发按钮显示「未找到可用的打开方式」。
- 加载中 / 保存中禁用。
- `aria-label="默认文件打开目标"`。

`settings-content.tsx` 把写死的 `SettingSelect icon={<Code2 />} label="VS Code"` 换成 `<DefaultOpenerControl />`。运行环境和集成终端 Shell 保持占位。

- [ ] **步骤 4：运行设置页测试验证通过**

```bash
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/settings-page/default-opener-control.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/components/desktop/settings-page/default-opener-control.tsx apps/desktop/src/renderer/src/components/desktop/settings-page/default-opener-control.test.ts apps/desktop/src/renderer/src/components/desktop/settings-page/settings-error-message.ts apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx
git commit -m "feat(desktop): wire default file open target setting"
```

---

### 任务 5：文件树高亮和收尾验证

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/desktop/open-with/open-with-submenu.tsx`

- [ ] **步骤 1：给文件树当前默认项加高亮**

`useWorkspaceOpeners()` 改拿 `selected`。菜单项 class 与右上角一致：

```ts
className={cn(
  "flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
  opener.id === selected?.id && "bg-muted/70",
)}
```

`pickOpener` 继续只调用 `launchWorkspaceOpener({ openerId, path, rootPath })`，不写默认。

- [ ] **步骤 2：跑相关测试和类型检查**

```bash
pnpm --filter @vykor/desktop exec vitest run src/main/features/settings/settings-service.test.ts src/main/features/settings/desktop-preferences.test.ts src/renderer/src/stores/desktop-session/notification-observer.test.ts src/renderer/src/components/desktop/open-with/resolve-selected-opener.test.ts src/renderer/src/components/desktop/open-with/use-workspace-openers.test.ts src/renderer/src/components/desktop/settings-page/default-opener-control.test.ts
pnpm --filter @vykor/desktop typecheck
pnpm --filter @vykor/desktop lint
```

预期：全部 PASS。lint 只报这次改动的文件。

- [ ] **步骤 3：手工确认（实现者本机）**

1. 设置页下拉列出本机应用，图标和右上角一致。
2. 选一个默认，回到对话，右上角是这个应用。
3. 右上角另选一个只打开，再进设置页，默认仍是步骤 2 选的那个。
4. 「运行环境」「集成终端 Shell」仍是占位。

- [ ] **步骤 4：Commit**

```bash
git add apps/desktop/src/renderer/src/components/desktop/open-with/open-with-submenu.tsx
git commit -m "feat(desktop): highlight default opener in the files menu"
```

---

## 规格覆盖

| 规格要求 | 任务 |
|---|---|
| 本机 `defaultOpenerId`，合法值 trim，文件不写 null | 1 |
| 改通知 / 改打开方式互不覆盖；写失败抛错 | 1 |
| snapshot 增加字段；旧 mock 补齐 | 1 |
| `updateDefaultOpener` IPC；不校验是否已安装 | 2 |
| daemon 挂了仍能读本机字段 | 2 |
| 共用 `resolveSelectedOpener` | 3 |
| 右上角 / launch 不写默认、不写 localStorage | 3 |
| 偏好没读完不闪回退图标 | 3 |
| 设置页真实下拉、OpenerIcon、value 用解析后 id | 4 |
| 空列表禁用 | 4 |
| 文件树高亮 | 5 |
| 不做运行环境 / Shell / 事件同步 / localStorage 迁移 | 全程不写 |
