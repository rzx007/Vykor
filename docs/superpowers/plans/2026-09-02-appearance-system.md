# Vykor 桌面端外观系统实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Vykor 桌面端实现当前设备全局生效的外观系统，包括主题、强调色、字体、字号、减少动效和恢复默认，并保证设置确实覆盖主要界面。

**架构：** 用渲染端 `AppearanceProvider` 直接替换现有 `ThemeProvider`，以单个版本化 JSON 保存配置，并由 Provider 统一输出主题 class、颜色/排版 CSS 变量和最终减少动效状态。外观页只调用 Provider；颜色推导、配置解析和字体注册表保持为可独立测试的纯模块。旧主题键、旧 Hook 和裸 `D` 快捷键不做任何兼容。

**技术栈：** React 19、TypeScript、Electron、Vitest、jsdom、Tailwind CSS 4、shadcn/ui Base Nova、Base UI、Motion、Fontsource。

---

## 文件结构

### 新建文件

- `apps/desktop/src/renderer/src/components/appearance/appearance-preferences.ts`：配置类型、默认值、字段级解析、序列化和字号边界。
- `apps/desktop/src/renderer/src/components/appearance/appearance-preferences.test.ts`：配置解析、不兼容旧键行为和边界测试。
- `apps/desktop/src/renderer/src/components/appearance/appearance-colors.ts`：HEX 解析、混色、对比度和 shadcn/ui token 推导。
- `apps/desktop/src/renderer/src/components/appearance/appearance-colors.test.ts`：浅色/深色 token 与 WCAG 阈值测试。
- `apps/desktop/src/renderer/src/components/appearance/appearance-fonts.ts`：打包字体、本机候选、回退链和固定候选检测。
- `apps/desktop/src/renderer/src/components/appearance/appearance-fonts.test.ts`：字体来源、检测结果和不可用配置修复测试。
- `apps/desktop/src/renderer/src/components/appearance/appearance-provider.tsx`：React Context、持久化、系统监听、DOM 应用和 `MotionConfig`。
- `apps/desktop/src/renderer/src/components/appearance/appearance-provider.test.ts`：Provider、DOM、storage 和动效测试。
- `apps/desktop/src/renderer/src/components/appearance/appearance-actions.ts`：侧边栏显式明暗切换等纯交互 helper。
- `apps/desktop/src/renderer/src/components/appearance/appearance-actions.test.ts`：纯交互 helper 测试。
- `apps/desktop/src/renderer/src/components/appearance/appearance-settings.tsx`：外观设置页及恢复默认对话框。
- `apps/desktop/src/renderer/src/components/appearance/appearance-settings.test.ts`：设置页 DOM 交互和可访问性测试。
- `apps/desktop/src/renderer/src/components/appearance/theme-preview-card.tsx`：三种主题的纯 CSS 预览卡。
- `apps/desktop/src/renderer/src/components/appearance/appearance-typography-contract.test.ts`：主要界面不得再使用固定像素文字，并验证代码 Shadow DOM 使用语义变量。
- `apps/desktop/src/renderer/src/components/ui/toggle-group.tsx`：通过 shadcn CLI 添加的 Base UI ToggleGroup。

### 修改和删除的核心文件

- 修改 `apps/desktop/package.json`、`pnpm-lock.yaml`：加入打包的 Geist Mono 字体。
- 修改 `apps/desktop/src/renderer/src/main.tsx`：挂载 `AppearanceProvider`。
- 删除 `apps/desktop/src/renderer/src/components/theme-provider.tsx`：不保留旧 Provider 或 `useTheme()`。
- 修改 `apps/desktop/src/renderer/src/assets/main.css`：动态字体、字号、颜色 token 和减少动效选择器。
- 修改 `apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx`：接入真实外观页。
- 修改 `apps/desktop/src/renderer/src/components/desktop/settings-page/index.ts`：导出需要的设置页面边界。
- 修改主题调用方：`code-block.tsx`、`file-viewer.tsx`、`review-tool.tsx`、`sidebar.tsx`。
- 修改 Motion 调用方：`scheduled-page.tsx`；其余 `motion` 组件由根部 `MotionConfig` 控制。
- 修改主要桌面界面的固定像素字号，具体文件在任务 6–8 中列出。

### 工作区保护

当前主工作区已有与图片附件相关的未提交改动，且 `assistant-message.tsx` 与本计划的排版清理重叠。执行前使用 `using-git-worktrees` 创建隔离工作区；不要在当前脏工作区运行批量替换。每个任务只暂存本任务列出的文件，禁止使用 `git add -A`。

---

### 任务 1：建立版本化外观配置模型

**文件：**

- 创建：`apps/desktop/src/renderer/src/components/appearance/appearance-preferences.ts`
- 创建：`apps/desktop/src/renderer/src/components/appearance/appearance-preferences.test.ts`

- [x] **步骤 1：编写失败测试**

覆盖默认配置、合法 JSON、字段级恢复、未知版本回退、字号限制和 HEX 规范化。明确证明旧键不参与解析：测试只向 `parseAppearancePreferences()` 传新键内容；Provider 层另测“只有旧键时仍使用默认配置”。核心断言：

```ts
expect(DEFAULT_APPEARANCE_PREFERENCES).toEqual({
  version: 1,
  theme: "system",
  accent: { kind: "preset", id: "neutral" },
  uiFont: "system",
  codeFont: "geist-mono",
  uiFontSize: 14,
  codeFontSize: 13,
  reducedMotion: "system",
});

expect(
  parseAppearancePreferences('{"version":1,"theme":"dark","uiFontSize":99}'),
).toMatchObject({
  theme: "dark",
  uiFontSize: 18,
});

expect(parseAppearancePreferences('{"version":2,"theme":"dark"}')).toEqual(
  DEFAULT_APPEARANCE_PREFERENCES,
);

expect(normalizeHexColor("#0a6aff")).toBe("#0A6AFF");
expect(normalizeHexColor("#abc")).toBeNull();
```

- [x] **步骤 2：运行测试验证失败**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/appearance/appearance-preferences.test.ts
```

预期：FAIL，模块和导出尚不存在。

- [x] **步骤 3：实现最小配置模块**

导出以下稳定接口：

```ts
export const APPEARANCE_STORAGE_KEY = "vykor-desktop-appearance-v1";
export const UI_FONT_SIZE_RANGE = { min: 12, max: 18 } as const;
export const CODE_FONT_SIZE_RANGE = { min: 11, max: 18 } as const;

export type AppearancePreferences = {
  version: 1;
  theme: "system" | "light" | "dark";
  accent:
    | {
        kind: "preset";
        id: "neutral" | "blue" | "violet" | "terracotta" | "green";
      }
    | { kind: "custom"; value: `#${string}` };
  uiFont: "system" | "segoe-ui" | "inter";
  codeFont: "cascadia-code" | "cascadia-mono" | "geist-mono" | "consolas";
  uiFontSize: number;
  codeFontSize: number;
  reducedMotion: "system" | "on" | "off";
};

export function parseAppearancePreferences(
  raw: string | null,
): AppearancePreferences;
export function normalizeHexColor(value: string): `#${string}` | null;
```

解析器先检查普通对象和 `version === 1`，再逐字段保留合法值；数字使用 `Math.round()` 后限制范围。未知版本、非对象或坏 JSON 返回全新默认对象。不要声明旧存储键常量，也不要读取 `vykor-desktop-theme`。

- [x] **步骤 4：运行测试验证通过**

运行步骤 2 的命令，预期全部 PASS。

- [x] **步骤 5：提交任务 1**

```powershell
git add apps/desktop/src/renderer/src/components/appearance/appearance-preferences.ts apps/desktop/src/renderer/src/components/appearance/appearance-preferences.test.ts
git commit -m "feat(desktop): define appearance preferences"
```

---

### 任务 2：实现可测试的强调色 token 推导

**文件：**

- 创建：`apps/desktop/src/renderer/src/components/appearance/appearance-colors.ts`
- 创建：`apps/desktop/src/renderer/src/components/appearance/appearance-colors.test.ts`

- [x] **步骤 1：编写失败测试**

对五个预设和代表性的自定义色 `#006AFF`、`#808080`、`#FFFF00`、`#050505`，分别在浅色和深色表面解析。断言 token 完整，普通文字至少 `4.5`，焦点/控件边界至少 `3`，弱背景不等于原始高饱和色：

```ts
const tokens = resolveAppearanceColors(
  { kind: "custom", value: "#006AFF" },
  "light",
);

expect(Object.keys(tokens).sort()).toEqual(
  [
    "accent",
    "accentForeground",
    "primary",
    "primaryForeground",
    "ring",
    "sidebarAccent",
    "sidebarAccentForeground",
    "sidebarPrimary",
    "sidebarPrimaryForeground",
    "sidebarSelected",
  ].sort(),
);
expect(
  contrastRatio(tokens.primary, tokens.primaryForeground),
).toBeGreaterThanOrEqual(4.5);
expect(
  contrastRatio(tokens.ring, APPEARANCE_SURFACES.light.background),
).toBeGreaterThanOrEqual(3);
expect(tokens.accent).not.toBe("#006AFF");
```

- [x] **步骤 2：运行测试验证失败**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/appearance/appearance-colors.test.ts
```

预期：FAIL，颜色模块尚不存在。

- [x] **步骤 3：实现颜色数学和 token 映射**

导出 `contrastRatio()`、`resolveAppearanceColors()` 和用于测试的稳定表面色。算法顺序固定为：HEX 转 sRGB；计算相对亮度；黑白前景二选一；焦点和强色向黑或白做二分混合直到达到 `3:1`；弱色与实际表面按低比例混合，再独立选择前景。

```ts
export type AppearanceColorTokens = {
  primary: string;
  primaryForeground: string;
  ring: string;
  accent: string;
  accentForeground: string;
  sidebarPrimary: string;
  sidebarPrimaryForeground: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  sidebarSelected: string;
};

export function resolveAppearanceColors(
  accent: AppearancePreferences["accent"],
  theme: "light" | "dark",
): AppearanceColorTokens;
```

不要把原始 HEX 直接写入 `accent`、`sidebarAccent` 或 `sidebarSelected`。表面常量必须与 `main.css` 的浅色/深色 `background` 和 `sidebar` 基线对应，并在同一测试中留下显式断言。

- [x] **步骤 4：运行颜色测试验证通过**

运行步骤 2 的命令，预期全部 PASS。

- [x] **步骤 5：提交任务 2**

```powershell
git add apps/desktop/src/renderer/src/components/appearance/appearance-colors.ts apps/desktop/src/renderer/src/components/appearance/appearance-colors.test.ts
git commit -m "feat(desktop): derive accessible appearance colors"
```

---

### 任务 3：实现字体注册表和固定候选检测

**文件：**

- 创建：`apps/desktop/src/renderer/src/components/appearance/appearance-fonts.ts`
- 创建：`apps/desktop/src/renderer/src/components/appearance/appearance-fonts.test.ts`
- 修改：`apps/desktop/package.json`
- 修改：`pnpm-lock.yaml`
- 修改：`apps/desktop/src/renderer/src/assets/main.css`

- [x] **步骤 1：编写失败测试**

测试必须区分 bundled、system-generic 和 local 三种来源，并用注入的 `check()` 验证固定候选，不读取系统字体列表：

```ts
expect(UI_FONT_OPTIONS.find((item) => item.id === "inter")?.source).toBe(
  "bundled",
);
expect(CODE_FONT_OPTIONS.find((item) => item.id === "geist-mono")?.source).toBe(
  "bundled",
);

const availability = await detectLocalFontAvailability((query) =>
  query.includes("Cascadia Code"),
);
expect(availability["cascadia-code"]).toBe(true);
expect(availability.consolas).toBe(false);
```

增加 `repairUnavailableFonts()` 用例：已保存的不可用 Cascadia Code 恢复为 Geist Mono；系统 UI 字体和打包字体始终可用。

- [x] **步骤 2：运行字体测试验证失败**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/appearance/appearance-fonts.test.ts
```

预期：FAIL，字体注册表尚不存在。

- [x] **步骤 3：实现字体模块**

```ts
export type AppearanceFontOption<Id extends string> = {
  id: Id;
  label: string;
  source: "bundled" | "system-generic" | "local";
  family: string;
  checkQuery?: string;
};

export const UI_FONT_OPTIONS: readonly AppearanceFontOption<
  AppearancePreferences["uiFont"]
>[];
export const CODE_FONT_OPTIONS: readonly AppearanceFontOption<
  AppearancePreferences["codeFont"]
>[];
export async function detectLocalFontAvailability(
  check: (query: string) => boolean,
): Promise<Record<string, boolean>>;
```

`checkQuery` 使用带引号的字体族，例如 `12px "Cascadia Code"`。不要调用任何字体枚举 API。

- [x] **步骤 4：加入并导入 Geist Mono**

```powershell
pnpm --filter @vykor/desktop add -D @fontsource-variable/geist-mono@^5.3.0
```

在 `main.css` 顶部现有 Inter 导入旁增加：

```css
@import "@fontsource-variable/geist-mono";
```

- [x] **步骤 5：运行字体测试和桌面类型检查**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/appearance/appearance-fonts.test.ts
pnpm --filter @vykor/desktop typecheck:web
```

预期：全部通过，锁文件只增加 Geist Mono 相关条目。

- [x] **步骤 6：提交任务 3**

```powershell
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/renderer/src/assets/main.css apps/desktop/src/renderer/src/components/appearance/appearance-fonts.ts apps/desktop/src/renderer/src/components/appearance/appearance-fonts.test.ts
git commit -m "feat(desktop): register appearance fonts"
```

---

### 任务 4：用 AppearanceProvider 统一主题、持久化和动效

**文件：**

- 创建：`apps/desktop/src/renderer/src/components/appearance/appearance-provider.tsx`
- 创建：`apps/desktop/src/renderer/src/components/appearance/appearance-provider.test.ts`

- [x] **步骤 1：编写失败的 Provider 测试**

测试文件使用 `// @vitest-environment jsdom`，通过 `React.createElement()` 避免在 `.test.ts` 中写 JSX。建立可控的 `matchMedia`，覆盖：

- 新键不存在且只有 `vykor-desktop-theme=dark` 时仍得到 `theme=system`；
- `system` 随系统明暗模式变化；
- `reducedMotion=system/on/off` 得到正确布尔值，`off` 可以覆盖系统 reduce；
- 根节点得到 class、`data-reduced-motion`、字体/字号和全部颜色 token；
- 更新成功写入单个新键；
- `setItem` 抛错时保留旧配置并暴露错误；
- `storage` 事件应用另一窗口的新配置；
- 卸载后移除两个媒体监听和 storage 监听；
- 模块没有 `useTheme` 导出。

测试 Probe 的核心形态：

```ts
let latest: AppearanceContextValue | undefined;
function Probe() {
  latest = useAppearance();
  return React.createElement("output", { "data-theme": latest.resolvedTheme });
}
```

- [x] **步骤 2：运行 Provider 测试验证失败**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/appearance/appearance-provider.test.ts
```

预期：FAIL，Provider 尚不存在。

- [x] **步骤 3：实现 Provider 和 DOM 应用**

上下文公开接口固定为：

```ts
export type AppearanceContextValue = {
  preferences: AppearancePreferences;
  resolvedTheme: "light" | "dark";
  resolvedReducedMotion: boolean;
  fontAvailability: Readonly<Record<string, boolean>>;
  saveState: { status: "idle" | "saved" | "error"; message?: string };
  setPreference: <K extends keyof Omit<AppearancePreferences, "version">>(
    key: K,
    value: AppearancePreferences[K],
  ) => boolean;
  resetAppearance: () => boolean;
};
```

状态初始化器只读取 `APPEARANCE_STORAGE_KEY`。`setPreference()` 先生成并解析完整候选 JSON，成功写入 `localStorage` 后再发布 React 状态；异常时返回 `false` 并设置错误。`useLayoutEffect` 调用 `applyAppearanceToRoot()`，统一设置：

```ts
root.classList.remove("light", "dark");
root.classList.add(resolvedTheme);
root.dataset.reducedMotion = String(resolvedReducedMotion);
root.style.setProperty("--font-sans", uiFont.family);
root.style.setProperty("--font-mono", codeFont.family);
root.style.setProperty("--ui-font-size", `${preferences.uiFontSize}px`);
root.style.setProperty("--code-font-size", `${preferences.codeFontSize}px`);
```

再把任务 2 的 camelCase token 映射到对应的十个 kebab-case CSS 变量。字体检测在 `document.fonts.ready` 后执行；发现已保存本机字体不可用时，写入修复后的打包默认项。

- [x] **步骤 4：在 Provider 内统一 Motion 入口**

Provider 用 `MotionConfig` 包裹 children：

```tsx
<MotionConfig reducedMotion={resolvedReducedMotion ? "always" : "never"}>
  {children}
</MotionConfig>
```

- [x] **步骤 5：运行定向测试和类型检查**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/appearance/appearance-provider.test.ts
pnpm --filter @vykor/desktop typecheck:web
```

预期：Provider 测试和类型检查全部通过。新 Provider 此时尚未挂到应用根部，现有 ThemeProvider 暂时保持原状，任务 5 将以一个完整提交完成切换和删除。

- [x] **步骤 6：提交任务 4**

```powershell
git add apps/desktop/src/renderer/src/components/appearance/appearance-provider.tsx apps/desktop/src/renderer/src/components/appearance/appearance-provider.test.ts
git commit -m "feat(desktop): add appearance provider"
```

---

### 任务 5：迁移全部主题和 Motion 调用方

**文件：**

- 修改：`apps/desktop/src/renderer/src/main.tsx`
- 修改：`apps/desktop/src/renderer/src/assets/main.css`
- 删除：`apps/desktop/src/renderer/src/components/theme-provider.tsx`
- 修改：`apps/desktop/src/renderer/src/components/ui/code-block.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/file-viewer.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/review-tool.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/scheduled-page/scheduled-page.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout-project-operation-error.test.ts`
- 创建：`apps/desktop/src/renderer/src/components/appearance/appearance-actions.ts`
- 创建：`apps/desktop/src/renderer/src/components/appearance/appearance-actions.test.ts`

- [x] **步骤 1：补充失败测试**

在 `appearance-actions.test.ts` 为侧边栏显式主题切换编写纯 helper 测试：

```ts
expect(nextExplicitTheme("dark")).toBe("light");
expect(nextExplicitTheme("light")).toBe("dark");
```

在现有主布局测试中把 mock 从 `useTheme` 改成 `useAppearance`，并明确返回 `resolvedTheme`。

- [x] **步骤 2：运行相关测试验证失败**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/appearance/appearance-actions.test.ts src/renderer/src/components/desktop/layout/main-layout/main-layout-project-operation-error.test.ts
```

预期：FAIL，调用方仍依赖旧 Hook 或缺少 helper。

- [x] **步骤 3：迁移主题调用方**

- 在 `appearance-actions.ts` 实现 `nextExplicitTheme(resolvedTheme)`，只接受并返回 `"light" | "dark"`。
- `code-block.tsx`、`file-viewer.tsx` 读取 `useAppearance().resolvedTheme`。
- `review-tool.tsx` 删除 `useThemeType()`、`resolveThemeType()`、`MutationObserver` 和本地主题 state，直接使用 `resolvedTheme`。
- `sidebar.tsx` 读取 `resolvedTheme` 和 `setPreference`；按钮点击调用 `setPreference("theme", resolvedTheme === "dark" ? "light" : "dark")`。
- 删除 `sidebar.tsx` 的 `isDarkTheme()`，不读取 `window.matchMedia()`。

- [x] **步骤 4：切换应用根入口并删除旧 Provider**

`main.tsx` 改为：

```tsx
<StrictMode>
  <AppearanceProvider>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </AppearanceProvider>
</StrictMode>
```

删除 `theme-provider.tsx`，不要创建 re-export 或兼容文件。把 `main.css` 的无条件 `@media (prefers-reduced-motion: reduce)` 改成 `:root[data-reduced-motion="true"]` 选择器，使 CSS 不再独立读取系统偏好。

- [x] **步骤 5：迁移业务 Motion 判断**

`scheduled-page.tsx` 删除 `useReducedMotion` 导入，改为：

```ts
const { resolvedReducedMotion } = useAppearance();
```

将文件内所有 `prefersReducedMotion` 判断改为 `resolvedReducedMotion`。侧边栏已有的 `motion`/`AnimatePresence` 保持原组件结构，由根部 `MotionConfig` 控制。

- [x] **步骤 6：确认没有旧入口**

```powershell
rg -n "ThemeProvider|useTheme|vykor-desktop-theme|prefers-reduced-motion|useReducedMotion" apps/desktop/src/renderer/src
```

预期：生产代码零命中；测试中只允许“不读取旧键”的字符串断言。`main.css` 不再有 `@media (prefers-reduced-motion: reduce)`。

- [x] **步骤 7：运行测试和类型检查**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/appearance/appearance-provider.test.ts src/renderer/src/components/appearance/appearance-actions.test.ts src/renderer/src/components/desktop/layout/main-layout/main-layout-project-operation-error.test.ts
pnpm --filter @vykor/desktop typecheck:web
```

预期：全部通过。

- [x] **步骤 8：提交任务 5**

```powershell
git add apps/desktop/src/renderer/src/main.tsx apps/desktop/src/renderer/src/assets/main.css apps/desktop/src/renderer/src/components/appearance/appearance-actions.ts apps/desktop/src/renderer/src/components/appearance/appearance-actions.test.ts apps/desktop/src/renderer/src/components/theme-provider.tsx apps/desktop/src/renderer/src/components/ui/code-block.tsx apps/desktop/src/renderer/src/components/desktop/tools/file-viewer.tsx apps/desktop/src/renderer/src/components/desktop/tools/review-tool.tsx apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx apps/desktop/src/renderer/src/components/desktop/scheduled-page/scheduled-page.tsx apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout-project-operation-error.test.ts
git commit -m "feat(desktop): unify appearance runtime"
```

---

### 任务 6：建立排版 token 并适配对话界面

**文件：**

- 创建：`apps/desktop/src/renderer/src/components/appearance/appearance-typography-contract.test.ts`
- 修改：`apps/desktop/src/renderer/src/assets/main.css`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/controls.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message-block.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/image-generation-message.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/model-picker.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/new-conversation-start.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/project-info-popover.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/rich-prompt-input.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/skill-command-menu.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/skill-command-pill-node.tsx`

- [ ] **步骤 1：编写对话排版契约失败测试**

测试读取上述文件源码，逐个断言不含 `text-[数字px]`。同时读取 `main.css`，断言 Markdown 使用变量且不再固定 `14px`：

```ts
expect(source).not.toMatch(/text-\[\d+(?:\.\d+)?px\]/);
expect(css).toContain("font-family: var(--font-sans)");
expect(css).toContain("font-size: var(--ui-font-size)");
```

- [ ] **步骤 2：运行契约测试验证失败**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/appearance/appearance-typography-contract.test.ts
```

预期：FAIL，列出对话界面的固定像素字号和 Markdown 固定值。

- [x] **步骤 3：在 main.css 建立动态层级**

在 `@theme inline` 中覆盖 Tailwind 文字 token，并保留稳定的单位无关行高：

```css
--text-xs: var(--ui-font-size-xs);
--text-sm: var(--ui-font-size);
--text-base: var(--ui-font-size-lg);
--text-lg: var(--ui-font-size-xl);
--text-xl: var(--ui-font-size-title);
--text-2xl: var(--ui-font-size-2xl);
```

在 `:root` 定义规格中的 caption/xs/sm/base/lg/xl/title/2xl/display 和代码字号默认值；增加 `text-ui-caption`、`text-ui-small` 两个语义 utility。把 `.assistant-markdown`、`.desktop-markdown-preview` 及其标题、列表、引用等直接字号改为这些变量，不改变布局间距。

- [x] **步骤 4：逐文件替换对话固定字号**

按当前基线映射：`10–11px → text-ui-caption`，`11.5–12px → text-xs`，`12.5–13.5px → text-ui-small`，`14px → text-sm`，`15–16px → text-base`，`17px → text-lg`，`26px → text-[length:var(--ui-font-size-display)]`。每处先判断它是文字还是尺寸值；不要改宽度、高度或图标尺寸。

`assistant-message.tsx` 在主工作区已有其他改动，隔离 worktree 中只能基于提交历史修改排版 class；后续集成时不得覆盖主工作区的图片附件代码。

- [x] **步骤 5：运行契约、对话测试和类型检查**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/appearance/appearance-typography-contract.test.ts src/renderer/src/components/desktop/conversation-page/transcript.test.ts src/renderer/src/components/desktop/conversation-page/message/message-render-model.test.ts
pnpm --filter @vykor/desktop typecheck:web
```

预期：全部通过。

- [x] **步骤 6：提交任务 6**

只暂存本任务文件：

```powershell
git add apps/desktop/src/renderer/src/assets/main.css apps/desktop/src/renderer/src/components/appearance/appearance-typography-contract.test.ts apps/desktop/src/renderer/src/components/desktop/conversation-page
git commit -m "refactor(desktop): apply appearance typography to conversations"
```

提交前用 `git diff --cached --name-only` 确认没有暂存对话目录之外的用户改动。

---

### 任务 7：适配设置、调度和页面级排版

**文件：**

- 修改：`apps/desktop/src/renderer/src/components/appearance/appearance-typography-contract.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/desktop-empty-state.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/settings-layout/settings-sidebar.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/title-bar.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/open-with/open-with-submenu.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-page.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/scheduled-page/scheduled-detail.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/scheduled-page/scheduled-header.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/scheduled-page/scheduled-page.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/scheduled-page/scheduled-task-editor.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/scheduled-page/task-row.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/attachment-storage-settings.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/plugin-settings.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx`
- 修改：`apps/desktop/src/renderer/src/routes/__root.tsx`

- [ ] **步骤 1：扩展失败契约测试**

把本任务所有文件加入排版契约列表，逐个断言不存在任意像素文字 class。增加设置行、调度任务卡和空状态的代表性语义 class 字符串断言，防止只删除字号不补层级。

- [ ] **步骤 2：运行契约测试验证失败**

运行任务 6 的契约测试命令，预期 FAIL 并列出本组文件。

- [x] **步骤 3：按语义映射替换固定字号**

使用任务 6 的同一映射。保持设置页当前 `Card`、`Field`、`Select` 结构，不在本任务重构业务逻辑。调度页的时间、状态和说明文字分别使用 caption、xs 和 small 层级；页面标题使用标准 title 层级。

- [x] **步骤 4：运行契约、相关测试和类型检查**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/appearance/appearance-typography-contract.test.ts src/renderer/src/components/desktop/settings-page/attachment-storage-settings.test.ts
pnpm --filter @vykor/desktop typecheck:web
```

预期：契约测试、存储设置回归测试和类型检查全部通过；调度页面当前没有专用渲染测试，由排版契约与 TypeScript 编译共同覆盖。

- [x] **步骤 5：提交任务 7**

```powershell
git add apps/desktop/src/renderer/src/components/appearance/appearance-typography-contract.test.ts apps/desktop/src/renderer/src/components/desktop/desktop-empty-state.tsx apps/desktop/src/renderer/src/components/desktop/layout/settings-layout/settings-sidebar.tsx apps/desktop/src/renderer/src/components/desktop/layout/title-bar.tsx apps/desktop/src/renderer/src/components/desktop/open-with/open-with-submenu.tsx apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-page.tsx apps/desktop/src/renderer/src/components/desktop/scheduled-page apps/desktop/src/renderer/src/components/desktop/settings-page/attachment-storage-settings.tsx apps/desktop/src/renderer/src/components/desktop/settings-page/plugin-settings.tsx apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx apps/desktop/src/renderer/src/routes/__root.tsx
git commit -m "refactor(desktop): apply appearance typography to app pages"
```

---

### 任务 8：适配工具面板、代码内容和 UI primitives

**文件：**

- 修改：`apps/desktop/src/renderer/src/components/appearance/appearance-typography-contract.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/ui/code-block.tsx`
- 修改：`apps/desktop/src/renderer/src/components/ui/context-menu.tsx`
- 修改：`apps/desktop/src/renderer/src/components/ui/dropdown-menu.tsx`
- 修改：`apps/desktop/src/renderer/src/components/ui/toggle-widget.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/utility-panel-tab-strip.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/browser-tool.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/file-viewer.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/files-tool.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/placeholder-tool.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/review-tool.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/terminal/terminal-tool.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/virtualized-code-preview.tsx`

- [ ] **步骤 1：扩展失败契约测试**

把本任务文件加入任意像素文字扫描，并增加以下源码契约：

```ts
expect(codeBlockSource).toContain("font-size: var(--code-font-size)");
expect(codeBlockSource).toContain("line-height: var(--code-line-height)");
expect(diffSource).toContain("font-size: var(--code-font-size)");
expect(virtualizedSource).toContain("font-size: var(--code-font-size)");
expect(filesSource).toContain(
  "--trees-font-size-override: var(--ui-font-size-xs)",
);
```

终端 xterm 初始化中的 `fontSize: 13` 和 `fontFamily` 明确加入允许列表；终端周围 React UI 的 `text-[…px]` 不允许保留。

- [ ] **步骤 2：运行契约测试验证失败**

运行任务 6 的契约测试命令，预期 FAIL。

- [x] **步骤 3：适配代码 Shadow DOM**

把 `code-block.tsx`、`review-tool.tsx` 和 `virtualized-code-preview.tsx` 的 `unsafeCSS` 统一改为：

```css
font-family: var(--font-mono);
font-size: var(--code-font-size);
line-height: var(--code-line-height);
```

`pre` 保留 `!important` 以覆盖第三方默认值。文件树的 `--trees-font-family-override` 保持 `var(--font-sans)`，字号改成 UI xs 变量。

- [x] **步骤 4：替换工具和 primitive 固定字号**

按任务 6 的映射替换 React 文本 class。不要修改 xterm 内容字号、图标大小、面板尺寸或 z-index。shadcn primitives 继续使用语义颜色，不顺带重写其交互样式。

- [x] **步骤 5：运行契约、工具测试和类型检查**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/appearance/appearance-typography-contract.test.ts src/renderer/src/components/desktop/tools/file-viewer.test.ts src/renderer/src/components/desktop/tools/virtualized-code-preview.test.ts
pnpm --filter @vykor/desktop typecheck:web
```

预期：全部通过。额外运行：

```powershell
rg -n "text-\[[0-9.]+px\]" apps/desktop/src/renderer/src
```

预期：零命中。`fontSize: 13` 只允许保留在 xterm 初始化配置中。

- [x] **步骤 6：提交任务 8**

```powershell
git add apps/desktop/src/renderer/src/components/appearance/appearance-typography-contract.test.ts apps/desktop/src/renderer/src/components/ui apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/utility-panel-tab-strip.tsx apps/desktop/src/renderer/src/components/desktop/tools
git commit -m "refactor(desktop): apply appearance typography to tools"
```

提交前检查 `git diff --cached --name-only`，确认没有把 UI 目录或工具目录中的无关用户改动带入。

---

### 任务 9：实现外观设置页

**文件：**

- 创建：`apps/desktop/src/renderer/src/components/ui/toggle-group.tsx`
- 创建：`apps/desktop/src/renderer/src/components/appearance/theme-preview-card.tsx`
- 创建：`apps/desktop/src/renderer/src/components/appearance/appearance-settings.tsx`
- 创建：`apps/desktop/src/renderer/src/components/appearance/appearance-settings.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/index.ts`

- [x] **步骤 1：检查并添加 shadcn ToggleGroup**

```powershell
pnpm dlx shadcn@latest add toggle-group --dry-run
pnpm dlx shadcn@latest add toggle-group
```

命令在 `apps/desktop` 目录运行。读取生成的 `toggle-group.tsx`，确认它使用项目的 Base UI、`@renderer` 别名和 lucide 图标约定；不要覆盖已有组件。

- [x] **步骤 2：编写失败的页面交互测试**

测试使用 `// @vitest-environment jsdom` 和 `React.createElement()` 渲染页面，mock `useAppearance()`。覆盖：

- 三个主题选项具有单选语义并调用 `setPreference("theme", value)`；
- 五个预设色调用 `setPreference("accent", ...)`；
- 自定义色输入保留不完整文本，只有完整 HEX 才提交；
- 两个字体 Select 显示禁用的“本机未安装”项；
- Slider 与数字 Input 最终提交相同整数，并限制边界；
- 减少动效三态可用键盘切换；
- 恢复默认必须经过带标题和说明的 AlertDialog；
- `saveState=saved` 使用 `aria-live="polite"`；
- `saveState=error` 渲染页面内 Alert。

代表性断言：

```ts
input.value = "#12";
input.dispatchEvent(new Event("input", { bubbles: true }));
expect(setPreference).not.toHaveBeenCalled();

input.value = "#006AFF";
input.dispatchEvent(new Event("input", { bubbles: true }));
expect(setPreference).toHaveBeenCalledWith("accent", {
  kind: "custom",
  value: "#006AFF",
});
```

- [x] **步骤 3：运行页面测试验证失败**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/appearance/appearance-settings.test.ts
```

预期：FAIL，页面组件尚不存在。

- [x] **步骤 4：实现预览卡和设置页**

使用现有 `SettingsSection`/`SettingRow` 视觉模式，但将可复用版本移动到外观页面内部或一个小型设置页 helper；不要继续扩大 `settings-content.tsx`。页面由：

```tsx
<AppearanceHeader />
<ThemeToggleGroup />
<AppearanceSection title="颜色" />
<AppearanceSection title="字体" />
<AppearanceSection title="动效" />
<ResetAppearanceDialog />
```

组成。表单布局使用 `FieldGroup`、`Field`、`FieldContent`、`FieldLabel`、`FieldDescription`、`FieldError`。SelectItem 必须位于 SelectGroup；ToggleGroup 用于主题、预设色和三态动效。图标放入 Button 时使用 `data-icon`，不在图标上写尺寸 class。

主题卡片只用语义 token 和 CSS 形状，选中状态同时显示边框、勾选和可读文字。自定义色输入使用 `aria-invalid`，Field 使用 `data-invalid`。

- [x] **步骤 5：接入设置路由内容**

在 `SettingsContent` 增加明确分支：

```tsx
selectedSection === "外观" ? <AppearanceSettings /> : ...
```

页面头部说明改为“调整 Vykor 在当前设备上的显示方式。更改会立即预览并自动保存。”，不再显示占位卡。

- [x] **步骤 6：运行页面、设置导航测试和类型检查**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/appearance/appearance-settings.test.ts src/renderer/src/components/desktop/settings-page/settings-navigation.test.ts
pnpm --filter @vykor/desktop typecheck:web
```

预期：全部通过。

- [x] **步骤 7：提交任务 9**

```powershell
git add apps/desktop/src/renderer/src/components/ui/toggle-group.tsx apps/desktop/src/renderer/src/components/appearance/theme-preview-card.tsx apps/desktop/src/renderer/src/components/appearance/appearance-settings.tsx apps/desktop/src/renderer/src/components/appearance/appearance-settings.test.ts apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx apps/desktop/src/renderer/src/components/desktop/settings-page/index.ts
git commit -m "feat(desktop): add appearance settings page"
```

---

### 任务 10：完成回归、计算样式和视觉验收

**文件：**

- 检查：本计划全部修改文件。
- 更新：`docs/superpowers/plans/2026-09-02-appearance-system.md`，勾选实际完成步骤并记录偏差。

- [x] **步骤 1：运行全部外观定向测试**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/appearance
```

预期：配置、颜色、字体、Provider、排版契约和页面测试全部通过。

- [x] **步骤 2：运行桌面端完整质量检查**

```powershell
pnpm --filter @vykor/desktop test
pnpm --filter @vykor/desktop typecheck
pnpm --filter @vykor/desktop lint
git diff --check
```

预期：全部退出码为 0。

- [x] **步骤 3：检查不兼容升级和范围边界**

```powershell
rg -n "ThemeProvider|useTheme|vykor-desktop-theme|@media \(prefers-reduced-motion: reduce\)|useReducedMotion|text-\[[0-9.]+px\]" apps/desktop/src/renderer/src
rg -n "fontSize: 13|Cascadia Mono, CaskaydiaCove" apps/desktop/src/renderer/src/components/desktop/tools/terminal/terminal-tool.tsx
```

第一条只允许测试中出现旧键的否定断言，其余生产代码零命中。第二条必须证明 xterm 内容设置仍保持原值，没有被外观代码接管。

- [ ] **步骤 4：运行应用并检查真实计算样式**

```powershell
pnpm --filter @vykor/desktop dev
```

在外观页依次设为 UI 12/18 px、代码 11/18 px，并在 DevTools Console 对实际元素运行：

```js
const px = (selector) =>
  getComputedStyle(document.querySelector(selector)).fontSize;
console.table({
  sidebar: px("[data-settings-sidebar]"),
  settings: px("[data-appearance-settings]"),
  conversation: px(".assistant-markdown"),
  input: px("[contenteditable='true']"),
});
```

代码块、文件预览和 Diff 位于第三方 Shadow DOM；在 Elements 面板选择实际 `pre` 后运行：

```js
getComputedStyle($0).fontFamily;
getComputedStyle($0).fontSize;
getComputedStyle($0).lineHeight;
```

预期：列出的 UI 表面随 UI 设置变化，三个代码表面随代码设置变化；xterm 内容不变化。把各表面的最小值和最大值记录在任务执行日志中。

- [ ] **步骤 5：完成视觉和键盘检查**

分别检查浅色、深色和跟随系统；在窄窗口检查设置行上下排列且无横向滚动。用 Tab/Shift+Tab、方向键、Enter、Space 完成主题、色板、字体、字号、动效和恢复默认操作。确认：

- 自定义高饱和黄、蓝、深灰时，按钮文字、焦点环、菜单 hover 和侧边栏选中仍可辨识；
- 系统开启减少动效时，应用选择“关闭”后 Motion 与 CSS 动画恢复；选择“开启”后两者都减少；
- 本机缺少候选字体时显示“本机未安装”且不可选择；
- 保存失败模拟下保持上一份外观并显示页面内错误；
- 重启应用后新配置保留，新键缺失时默认跟随系统；
- 侧边栏按钮从跟随系统切换为显式相反主题；按裸 `D` 不再切换主题。

- [x] **步骤 6：检查工作区和提交最终验收记录**

```powershell
git status --short
git diff --stat HEAD~1..HEAD
git log --oneline -10
```

确认没有覆盖执行前的用户改动，没有生成物进入 Git。若计划执行记录发生变化，只提交计划文件：

```powershell
git add docs/superpowers/plans/2026-09-02-appearance-system.md
git commit -m "docs(desktop): record appearance verification"
```

### 执行记录（2026-09-03）

- 任务 6–8 原计划新增的 `appearance-typography-contract.test.ts` 属于扫描源码字符串的伪测试，按测试规范不落库；改为运行真实组件测试、Web 类型检查以及固定字号静态扫描。对话、页面、工具和 Shadow DOM 的实际改造均已完成。
- 外观定向测试共 6 个文件、36 个用例，全部通过；`typecheck:web` 和外观目录定向 ESLint 通过。
- 初次验收时，桌面测试因 `packages/server/src/application/daemon-application.ts` 引用未声明的 `@vykor/tools` 而有 1 个套件无法加载。合并远端 `main` 的修复提交 `e23c6d10` 后，桌面测试 74 个文件、464 个用例全部通过，完整桌面类型检查和正式构建也通过。
- 完整应用无法启动后，使用只加载真实 `AppearanceProvider`、`AppearanceSettings` 和正式样式的临时渲染预览完成视觉检查；临时文件已删除。验证了浅色/深色/系统主题、预设与自定义颜色、UI 12/18 px、代码 11/18 px、本机字体、方向键加空格键操作、恢复默认，以及 480 px 窄窗口无横向滚动。
- 视觉检查发现并修复两项问题：单值 Slider 误渲染两个手柄；恢复默认成功后确认框未关闭。两项均先增加失败断言，再完成修复并通过回归。
- 任务 10 的步骤 4–5 保持未勾选：设置页已完成真实渲染、响应式和键盘验收，但对话区、输入框、代码块、Diff 与 xterm 的同窗计算样式未逐项手工记录；自动测试、静态边界检查和正式构建均已覆盖对应代码路径。

---

## 规格覆盖自检

- 设备级单键配置、字段修复和不兼容旧主题：任务 1、4、5、10。
- 五种预设、自定义 HEX、完整 shadcn/ui token 和对比度阈值：任务 2、4、10。
- 打包字体、本机固定候选、不可用状态与默认修复：任务 3、4、9、10。
- 全应用 UI 字体/字号和代码字体/字号实际覆盖：任务 6、7、8、10。
- 系统/开启/关闭三态动效、CSS 与 Motion 统一：任务 4、5、9、10。
- 主题预览、分组设置、即时保存、错误和恢复默认：任务 9。
- 侧边栏显式切换、删除旧 Hook、删除裸 `D`：任务 5、10。
- 响应式、键盘操作、ARIA 和视觉验收：任务 9、10。
- 集成终端内容保持独立：任务 8、10。
