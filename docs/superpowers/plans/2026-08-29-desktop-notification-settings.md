# 桌面通知设置实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在桌面端设置页增加通知模式，并让桌面客户端按“从不 / 仅失去焦点时 / 始终”决定是否发送系统通知。

**架构：** core 和 daemon 只继续提供会话/计划任务状态，不保存桌面通知偏好，也不提供 `DesktopNotificationMode` 这类桌面行为类型。通知模式类型、校验、UI 文案、触发判断和持久化全部放在 `apps/desktop`；桌面主进程把偏好保存到 Electron `userData` 下的独立 JSON 文件，渲染层根据状态变化调用已有 `window.desktop.tray.notify()`。

**技术栈：** Electron、React、Zustand、Vitest、现有 IPC settings/service 模式。

---

## 文件结构

- 修改：`apps/desktop/src/shared/settings-types.ts`
  - 定义 desktop-only 的通知模式类型与校验函数。
- 创建：`apps/desktop/src/main/features/settings/desktop-preferences.ts`
  - 读写 Electron `app.getPath("userData")/desktop-preferences.json`。
  - 当前只包含 `notificationMode`，非法或缺失时回落到 `when_unfocused`。
- 修改：`apps/desktop/src/main/features/settings/settings-service.ts`
  - `snapshot()` 合并 daemon settings 中已有的 `workStyle` 和 desktop preferences 中的 `notificationMode`。
  - 新增 `updateNotificationMode()`，只 patch desktop preferences 文件，不调用 daemon `patchSettings()`。
- 修改：`apps/desktop/src/main/features/settings/ipc.ts`
  - 暴露 `settings:update-notification-mode` IPC。
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
  - 增加 IPC channel、invoke map 和输入类型。
- 修改：`apps/desktop/src/shared/desktop-api-contract.ts`
  - 给 preload 暴露新的 settings API。
- 修改：`apps/desktop/src/preload/desktop-api.ts`
  - 实现 `window.desktop.settings.updateNotificationMode()`。
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx`
  - 在“常规”设置中增加通知下拉框。
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/notification-observer.ts`
  - 比较旧/新 `DesktopSessionView`，只在 run 终结、新权限请求时通知。
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/session-view-actions.ts`
  - 在接受 live 更新后调用 observer。
- 修改：`apps/desktop/src/renderer/src/components/desktop/scheduled-page/scheduled-page.tsx`
  - 定时刷新发现新 unread scheduled run 时按通知模式发送通知。
- 测试：
  - `apps/desktop/src/main/features/settings/settings-service.test.ts`
  - `apps/desktop/src/main/features/settings/desktop-preferences.test.ts`
  - `apps/desktop/src/renderer/src/stores/desktop-session/notification-observer.test.ts`
  - 视需要补 `settings-content` 或 `scheduled-page` 的聚焦测试。

## 任务 1：桌面偏好文件和 IPC

**文件：**
- 修改：`apps/desktop/src/shared/settings-types.ts`
- 创建：`apps/desktop/src/main/features/settings/desktop-preferences.ts`
- 修改：`apps/desktop/src/main/features/settings/settings-service.ts`
- 修改：`apps/desktop/src/main/features/settings/ipc.ts`
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 修改：`apps/desktop/src/shared/desktop-api-contract.ts`
- 修改：`apps/desktop/src/preload/desktop-api.ts`
- 测试：`apps/desktop/src/main/features/settings/settings-service.test.ts`
- 测试：`apps/desktop/src/main/features/settings/desktop-preferences.test.ts`

- [ ] **步骤 1：编写失败的设置快照测试**

在 `settings-service.test.ts` 增加：

```ts
it("defaults desktop notifications to when unfocused", () => {
  expect(buildDesktopSettingsSnapshot({})).toEqual({
    workStyle: "practical",
    notificationMode: "when_unfocused",
  })
})

it("preserves a valid desktop notification mode", () => {
  expect(
    buildDesktopSettingsSnapshot({}, { notificationMode: "always" })
  ).toMatchObject({ notificationMode: "always" })
})

it("rejects unknown desktop notification values by falling back safely", () => {
  expect(
    buildDesktopSettingsSnapshot({}, { notificationMode: "chatty" })
  ).toMatchObject({ notificationMode: "when_unfocused" })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @vykor/desktop test -- settings-service.test.ts`
预期：FAIL，原因是 snapshot 还没有 `notificationMode`，也还不能接收桌面偏好输入。

- [ ] **步骤 3：实现 desktop-only 类型和快照读取**

在 `apps/desktop/src/shared/settings-types.ts` 中增加：

```ts
export type DesktopNotificationMode = "never" | "when_unfocused" | "always"

export interface DesktopSettingsSnapshot {
  workStyle: DesktopWorkStyle
  notificationMode: DesktopNotificationMode
}

export interface UpdateDesktopNotificationModeInput {
  notificationMode: DesktopNotificationMode
}

export function isDesktopNotificationMode(value: unknown): value is DesktopNotificationMode {
  return value === "never" || value === "when_unfocused" || value === "always"
}
```

`buildDesktopSettingsSnapshot(settings, preferences)` 从第二个参数读取 `notificationMode`，非法或缺失时返回 `"when_unfocused"`。第一个参数继续只承载 daemon settings 中的 `workStyle` 等现有字段。

- [ ] **步骤 4：实现桌面偏好文件读写**

创建 `apps/desktop/src/main/features/settings/desktop-preferences.ts`：

```ts
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

import { app } from "electron"

import { isDesktopNotificationMode, type DesktopNotificationMode } from "../../../shared/settings-types"

export interface DesktopPreferences {
  notificationMode: DesktopNotificationMode
}

const defaults: DesktopPreferences = {
  notificationMode: "when_unfocused",
}

export function getDesktopPreferences(): DesktopPreferences {
  const filePath = getDesktopPreferencesPath()
  if (!existsSync(filePath)) return defaults
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<DesktopPreferences>
    return {
      notificationMode: isDesktopNotificationMode(raw.notificationMode)
        ? raw.notificationMode
        : defaults.notificationMode,
    }
  } catch {
    return defaults
  }
}

export function patchDesktopPreferences(patch: Partial<DesktopPreferences>): DesktopPreferences {
  const next = { ...getDesktopPreferences(), ...patch }
  try {
    writeFileSync(getDesktopPreferencesPath(), JSON.stringify(next, null, 2), "utf8")
  } catch (error) {
    console.warn("[settings] failed to persist desktop preferences", error)
  }
  return next
}

export function getDesktopPreferencesPath(): string {
  return join(app.getPath("userData"), "desktop-preferences.json")
}
```

测试需要 mock `electron.app.getPath("userData")` 到临时目录，覆盖文件不存在、合法值、非法值、损坏 JSON 四种情况。

- [ ] **步骤 5：实现 settings service 更新**

在 `DesktopSettingsService` 中新增方法：

```ts
async updateNotificationMode(
  input: UpdateDesktopNotificationModeInput
): Promise<DesktopSettingsSnapshot> {
  if (!isDesktopNotificationMode(input.notificationMode)) {
    throw new Error("未知的通知设置，请选择从不、仅失去焦点时或始终。")
  }
  const preferences = patchDesktopPreferences({ notificationMode: input.notificationMode })
  return withDaemonRetry(async (client) =>
    buildDesktopSettingsSnapshot(await client.getSettings(), preferences)
  )
}
```

同时把 `snapshot()` 改为：

```ts
snapshot(): Promise<DesktopSettingsSnapshot> {
  const preferences = getDesktopPreferences()
  return withDaemonRetry(async (client) =>
    buildDesktopSettingsSnapshot(await client.getSettings(), preferences)
  )
}
```

这里不调用 daemon `patchSettings()` 保存通知偏好；daemon 不知道通知偏好的字段名和行为。

- [ ] **步骤 6：补 IPC 与 preload 合约**

新增 channel：`settingsUpdateNotificationMode: "settings:update-notification-mode"`。

给 `DesktopAPI["settings"]` 增加：

```ts
updateNotificationMode: (
  input: UpdateDesktopNotificationModeInput
) => Promise<DesktopSettingsSnapshot>
```

在 preload 中转发到新增 IPC channel。

- [ ] **步骤 7：运行测试验证通过**

运行：`pnpm --filter @vykor/desktop test -- settings-service.test.ts desktop-preferences.test.ts`
预期：PASS。

## 任务 2：设置页 UI

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx`

- [ ] **步骤 1：扩展现有控制模式**

仿照 `WorkStyleControl` 增加 `NotificationModeControl`，它加载 `window.desktop.settings.snapshot()` 并保存 `window.desktop.settings.updateNotificationMode()`。

核心选项：

```ts
const notificationModeLabels = {
  never: "从不",
  when_unfocused: "仅失去焦点时",
  always: "始终",
} satisfies Record<DesktopNotificationMode, string>
```

- [ ] **步骤 2：在常规设置中增加一行**

在“工作风格”后增加：

```tsx
<SettingRow
  title="通知"
  description="选择任务完成、失败或需要你处理时是否发送系统通知。"
  control={<NotificationModeControl />}
/>
<Separator />
```

- [ ] **步骤 3：手动或组件测试验证 UI 文案**

运行：`pnpm --filter @vykor/desktop test -- settings`
预期：现有设置测试通过；如果新增组件测试，应覆盖加载成功、保存失败回滚、非法值不提交。

## 任务 3：对话状态通知观察器

**文件：**
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/notification-observer.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/session-view-actions.ts`
- 测试：`apps/desktop/src/renderer/src/stores/desktop-session/notification-observer.test.ts`

- [ ] **步骤 1：编写失败的 observer 测试**

覆盖：

```ts
it("notifies when a running run completes", async () => {})
it("notifies when a running run fails", async () => {})
it("notifies when a new pending permission appears", async () => {})
it("does not notify for initial snapshots", async () => {})
it("does not notify when notification mode is never", async () => {})
it("uses showWhenFocused only for always mode", async () => {})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @vykor/desktop test -- notification-observer.test.ts`
预期：FAIL，文件和函数不存在。

- [ ] **步骤 3：实现 observer**

导出：

```ts
export async function notifyForSessionViewChange(input: {
  previous: DesktopSessionView | null
  next: DesktopSessionView
}): Promise<void>
```

行为：
- `previous === null` 时不通知，避免打开历史会话时弹旧消息。
- run 从 `pending/running` 到 `completed` 时通知。
- run 从 `pending/running` 到 `failed` 时通知。
- 新出现的 pending permission 通知。
- 每次触发前读取 `window.desktop.settings.snapshot()`，`never` 直接返回。
- `showWhenFocused` 仅在 mode 为 `always` 时传 `true`。

- [ ] **步骤 4：接入状态更新入口**

在 `createApplySessionUpdate()` 接受 view 后，在 `set()` 前后都可以，但必须用当前 `state.sessionView` 作为 previous，并且只对 accepted view 调用：

```ts
void notifyForSessionViewChange({ previous: current, next: view })
```

不要在 `startSession()`、`sendMessage()`、`replyPermission()` 等动作里散落通知逻辑。

- [ ] **步骤 5：运行测试验证通过**

运行：`pnpm --filter @vykor/desktop test -- notification-observer.test.ts session-view-state.test.ts`
预期：PASS。

## 任务 4：已安排任务 unread 通知

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/desktop/scheduled-page/scheduled-page.tsx`

- [ ] **步骤 1：增加刷新期 unread 检测**

在 `refresh()` 获取 status/tasks 后，如果 `nextStatus.unread > previousUnread`，拉取 unread runs：

```ts
const unreadRuns = await window.desktop.schedules.listRuns({ unread: true, limit: 10 })
```

只通知本次新增或未见过的 run id，避免 20 秒轮询重复弹。

- [ ] **步骤 2：复用通知模式**

读取 `window.desktop.settings.snapshot()`：
- `never`：不通知。
- `when_unfocused`：调用 notify，不传 `showWhenFocused`。
- `always`：调用 notify，传 `showWhenFocused: true`。

通知文案：
- 成功：`已安排任务完成`
- 失败：`已安排任务失败`
- body 使用任务名或 run id 的短文本，不暴露过长 prompt。

- [ ] **步骤 3：避免清 unread 时误弹**

当用户已经选中某个任务并进入详情，现有逻辑会把 unread run 标为已读。这个路径不应触发系统通知，因为用户已经在看该任务。

- [ ] **步骤 4：运行测试或手动验证**

运行：`pnpm --filter @vykor/desktop test -- scheduled-page`
预期：现有 scheduled page 测试通过；如果没有合适测试入口，至少跑 desktop test 并手动说明缺口。

## 任务 5：最终验证

**文件：**
- 可能涉及以上全部文件。

- [ ] **步骤 1：运行相关单测**

运行：

```bash
pnpm --filter @vykor/desktop test -- settings-service.test.ts notification-observer.test.ts scheduled-page
```

预期：PASS。

- [ ] **步骤 2：运行类型检查**

运行：

```bash
pnpm --filter @vykor/desktop check-types
```

预期：PASS。

- [ ] **步骤 3：检查 core/server 和 daemon settings 边界**

运行：

```bash
rg -n "DesktopNotificationMode|notificationMode|desktop-preferences" packages/core packages/server
```

预期：没有结果。通知类型、字段名和持久化文件都只出现在 `apps/desktop`。
