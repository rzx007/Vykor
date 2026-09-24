# 中性主题低强调度实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 默认中性主题采用极淡选中态，并让应用与内置浏览器的滚动条降低存在感。

**架构：** 外观颜色生成器继续负责用户主题下的侧栏选中背景。渲染器 CSS 使用新增的滚动条语义 token；浏览器工具调用独立的纯函数生成与当前解析主题匹配的网页 CSS，并在网页加载完成时注入。

**技术栈：** React、TypeScript、Vitest、Tailwind CSS v4、Electron `webview`。

---

## 文件结构

- 修改：`apps/desktop/src/renderer/src/components/appearance/appearance-colors.ts` — 调整侧栏选中背景混色比例。
- 修改：`apps/desktop/src/renderer/src/components/appearance/appearance-colors.test.ts` — 覆盖中性主题两种模式的低强调度颜色。
- 创建：`apps/desktop/src/renderer/src/components/desktop/tools/browser-webview-style.ts` — 生成独立网页可使用的滚动条 CSS。
- 创建：`apps/desktop/src/renderer/src/components/desktop/tools/browser-webview-style.test.ts` — 覆盖浅色和深色网页样式。
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/browser-tool.tsx` — 在完成加载后注入当前主题网页样式。
- 修改：`apps/desktop/src/preload/index.d.ts` — 补充 Electron `webview.insertCSS` 的最小类型声明。
- 修改：`apps/desktop/src/renderer/src/assets/main.css` — 定义并使用全局滚动条 token。

### 任务 1：侧栏选中背景

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/appearance/appearance-colors.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/appearance/appearance-colors.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
it.each([
  ["light", "#E0E6E9"],
  ["dark", "#22262A"],
] as const)("uses the C-level neutral selected color in %s mode", (theme, expected) => {
  expect(resolveAppearanceColors({ kind: "preset", id: "neutral" }, theme).sidebarSelected).toBe(expected)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @vykor/desktop test -- appearance-colors.test.ts`

预期：FAIL，因为当前比例生成较深的 `#CDD2D5` 与 `#292D30`。

- [ ] **步骤 3：编写最少实现代码**

```ts
const sidebarSelectedStrength = theme === "light" ? 0.1 : 0.2
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @vykor/desktop test -- appearance-colors.test.ts`

预期：PASS。

### 任务 2：内置浏览器滚动条样式

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/desktop/tools/browser-webview-style.test.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/tools/browser-webview-style.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/browser-tool.tsx`
- 修改：`apps/desktop/src/preload/index.d.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
expect(buildBrowserScrollbarCss("light")).toContain("rgb(20 27 33 / 8%)")
expect(buildBrowserScrollbarCss("dark")).toContain("rgb(245 247 249 / 10%)")
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @vykor/desktop test -- browser-webview-style.test.ts`

预期：FAIL，因为样式生成函数尚不存在。

- [ ] **步骤 3：编写最少实现代码**

```ts
export function buildBrowserScrollbarCss(theme: "light" | "dark"): string {
  const foreground = theme === "light" ? "20 27 33" : "245 247 249"
  const idleOpacity = theme === "light" ? "8%" : "10%"
  const hoverOpacity = theme === "light" ? "16%" : "18%"
  return `* { scrollbar-color: rgb(${foreground} / ${idleOpacity}) transparent; }`
}
```

在 `did-stop-loading` 事件中调用 `webview.insertCSS(buildBrowserScrollbarCss(resolvedTheme))`，并忽略页面卸载造成的注入失败。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @vykor/desktop test -- browser-webview-style.test.ts`

预期：PASS。

### 任务 3：应用全局滚动条

**文件：**
- 修改：`apps/desktop/src/renderer/src/assets/main.css`

- [ ] **步骤 1：写入语义 token 与最少样式实现**

```css
--scrollbar-thumb: color-mix(in oklab, var(--foreground) 8%, transparent);
--scrollbar-thumb-hover: color-mix(in oklab, var(--foreground) 16%, transparent);
```

深色模式使用 10% / 18%，已有全局 Firefox 与 WebKit 规则改为引用上述 token。

- [ ] **步骤 2：运行桌面端完整验证**

运行：`pnpm --filter @vykor/desktop test && pnpm --filter @vykor/desktop typecheck && pnpm --filter @vykor/desktop build`

预期：所有测试、类型检查与构建均通过。
