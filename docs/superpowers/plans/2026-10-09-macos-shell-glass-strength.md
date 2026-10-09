# macOS 外壳磨砂强度实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 macOS 的 Vykor 侧栏与窗口外壳能通过现有强度滑杆显示更明显的原生磨砂，同时保持主工作区不透明。

**架构：** 继续由主进程创建 macOS `under-window` 原生材质，renderer 通过现有 `glassStrength` 偏好调节外壳染色的不透明度。只保留一层外壳染色，工作区继续使用 `--conversation` 实色，不复制 Synara 的原生模糊插件。

**技术栈：** Electron、React、CSS 自定义属性、Vitest、pnpm。

---

## 文件清单

- 修改 `apps/desktop/src/renderer/src/components/appearance/appearance-settings.tsx`：在 macOS 与 Windows 上显示既有的透光强度滑杆。
- 修改 `apps/desktop/src/renderer/src/components/appearance/appearance-settings.test.ts`：覆盖 macOS 滑杆的显示、键盘调节、偏好写入及关闭玻璃时禁用。
- 修改 `apps/desktop/src/renderer/src/assets/main.css`：让 macOS 外壳染色读取现有强度值，并避免 body 与主布局重复绘制染色。
- 检查 `apps/desktop/src/renderer/src/components/appearance/appearance-provider.test.ts`：现有测试验证滑杆写入的强度会同步到 renderer 的 `--window-glass-strength`。
- 检查 `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx`：主布局继续使用 `bg-shell`，其工作区 `bg-conversation` 不变。

## 任务 1：在 macOS 设置中开放既有强度滑杆

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/appearance/appearance-settings.tsx`
- 修改：`apps/desktop/src/renderer/src/components/appearance/appearance-settings.test.ts`

- [ ] **步骤 1：先调整测试，要求 macOS 展示可调滑杆**

保留现有 Windows 断言，删除它当前“macOS 不展示滑杆”的断言，并增加 macOS 用例：

```tsx
it("offers an adjustable glass strength slider on macOS", async () => {
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: { process: { platform: "darwin" } },
  })
  await renderSettings()

  const slider = container.querySelector<HTMLInputElement>(
    'input[type="range"][aria-label="透光强度"]'
  )
  expect(slider).not.toBeNull()
  expect(slider?.getAttribute("aria-valuenow")).toBe("35")
  act(() =>
    slider!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
  )
  expect(setPreference).toHaveBeenCalledWith("glassStrength", 40)
})
```

同时扩展关闭玻璃的用例：将 `window.electron.process.platform` 设为 `"darwin"`，在 `windowMaterial.active` 为 `"opaque"` 时断言滑杆仍存在但 `disabled === true`。这覆盖 macOS 降低透明度时回退 opaque 的 UI 行为。

- [ ] **步骤 2：运行测试并确认它因 macOS 滑杆缺失而失败**

运行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/appearance/appearance-settings.test.ts
```

预期：新增用例失败，原因是查询不到 `透光强度` 滑杆；其它既有用例继续通过。

- [ ] **步骤 3：用现有平台判断扩展滑杆显示条件**

在 `appearance-settings.tsx` 中新增 macOS 判断，并让现有的强度 `Field` 在 Windows 或 macOS 上显示。继续使用相同的 `Slider`、`glassStrength` 与 `setPreference("glassStrength", next)`，不要复制第二份控件。

```tsx
const isMac = typeof window !== "undefined" && window.electron?.process?.platform === "darwin"
```

将字段条件扩为 `isWindows || isMac`。保留 `disabled={windowMaterial.active !== "glass"}`，并保留当前“弱 / 强”标签和默认值。

- [ ] **步骤 4：运行设置测试确认 macOS 与 Windows 行为通过**

运行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/appearance/appearance-settings.test.ts
```

预期：macOS 用例验证默认值 35、方向键后写入 40；Windows 既有用例仍通过；Windows 与 macOS 的 opaque 状态下滑杆都仍禁用。

- [ ] **步骤 5：提交设置控件与回归测试**

```powershell
git add -- apps/desktop/src/renderer/src/components/appearance/appearance-settings.tsx apps/desktop/src/renderer/src/components/appearance/appearance-settings.test.ts
git commit -m "feat: macOS 外观设置开放磨砂强度" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## 任务 2：让 macOS 外壳强度生效并移除重复染色

**文件：**
- 修改：`apps/desktop/src/renderer/src/assets/main.css`
- 检查：`apps/desktop/src/renderer/src/components/appearance/appearance-provider.test.ts`
- 检查：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx`

- [ ] **步骤 1：确认现有强度偏好到 CSS 的同步测试**

运行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/appearance/appearance-provider.test.ts
```

预期：现有 `previews glass strength immediately and restores its saved value on remount` 用例通过，并确认从 provider 改为 80 后，根元素的 `--window-glass-strength` 变为 `80%`。后续 macOS CSS 直接读取这个变量，不增加新的存储键或同步路径。

- [ ] **步骤 2：将 CSS 改为单层、可调的 macOS 外壳染色**

在 `main.css` 的 `html[data-window-shell="translucent"]` 规则中，让 tint opacity 使用 `calc(100% - var(--window-glass-strength, 35%))`，并让浅色、深色共用同一强度变量。保留 `--shell-solid` 对主题颜色的选择。

增加一个只匹配 macOS translucent shell 的 body 覆盖，使 document body 背景透明；`main-layout.tsx` 的 `main.bg-shell` 负责唯一一层外壳染色。不得改 `--conversation`、`--background`、卡片或工作区填充。

目标 CSS 形状：

```css
html[data-window-shell="translucent"] {
  --window-glass-tint-opacity: calc(100% - var(--window-glass-strength, 35%));
  --shell: color-mix(in oklab, var(--shell-solid) var(--window-glass-tint-opacity), transparent);
}

html[data-window-shell="translucent"] body {
  background: transparent;
}
```

删除原先固定的浅色 `60%` 与深色 `64%` 外壳染色规则；保留 Windows 的 Acrylic 规则和 Linux 行为不变。

- [ ] **步骤 3：运行外观与主布局相关测试**

运行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/appearance/appearance-settings.test.ts src/renderer/src/components/appearance/appearance-provider.test.ts src/renderer/src/apply-startup-theme.test.ts
```

预期：所有相关 renderer 测试通过；opaque 状态不会匹配新的 CSS 规则。运行期降低透明度时仍回退 opaque 的既有主进程断言由下列测试覆盖：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/main/features/main-window/window-material.test.ts
```

- [ ] **步骤 4：运行 renderer 类型检查**

运行：

```powershell
pnpm --filter @vykor/desktop run typecheck:web
```

预期：退出码为 0。

- [ ] **步骤 5：检查差异并提交外壳样式**

运行：

```powershell
git diff --check
git status --short
```

确认差异只涉及任务 2 文件后提交：

```powershell
git add -- apps/desktop/src/renderer/src/assets/main.css
git commit -m "fix: 加强 macOS 窗口外壳磨砂效果" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

实际 macOS 的 WindowServer 合成效果无法在 Windows 开发机上证明；不以 Windows 截图代替 macOS 验收。
