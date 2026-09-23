# 原生磨玻璃窗口（Windows Acrylic / macOS Vibrancy）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。
>
> **版本：** 第 2 版（2026-09-22 由 4 个核查子代理对照真实代码审核后修订，随后又由第 5 个子代理对修订稿做了一轮复核并收口）。第 1 版的任务编号与结构保持不变，但部分类型字段、CSS 方案、存储归属与测试预期已更正；**实现时以本版为准**，修订清单见文末「修订记录」。

**目标：** 把主窗口背景从纯色改为操作系统原生材质（Windows Acrylic / macOS `under-window` vibrancy / Linux 透明 + 合成器模糊），并在设置 → 外观页提供「不透明 / 透明磨玻璃」开关，用户选择在重启后仍然生效。

**架构：** 主进程新增纯函数 `mainWindowMaterialOptions()`，按平台返回材质相关窗口选项，与现有 `mainWindowChromeOptions()` 并列被 `createMainWindow()` 展开；材质决策结果（偏好 / 实际生效 / 降级原因 / 外壳模式）通过 `webPreferences.additionalArguments` 同步注入 renderer，`preload` 解析后暴露为 `window.desktop.window.material`（无参数入口为 `null`），`applyStartupTheme()` 在 React 之前把它写成 `html[data-window-material]` 与 `html[data-window-shell]`，`main.css` 据此切换 `--shell`：玻璃生效时外壳透明（Windows Acrylic / Linux 合成器模糊只在 web 内容透明处可见）或半透明染色（macOS vibrancy 之上）。材质偏好由主进程持久化（`desktop-window-material.json`——建窗口时 renderer 还不存在，主进程必须能同步读到），外观页开关通过新增的窄 IPC（`window:set-material`）让主进程实时调用 `setVibrancy()` / `setBackgroundMaterial()` 并落盘。Windows 补 `resized` / `show` 的有界双帧重绘。

**技术栈：** Electron 39.8.10、electron-vite 5、React 19、TypeScript、Vitest、jsdom、Tailwind CSS 4、shadcn/ui、pnpm workspace。

---

## 0. 侦察结论（动手前必须先读）

以下全部为本次在实际仓库中核对过的事实，不是推测。

### 0.1 桌面壳与构建

| 项 | 事实 | 证据位置 |
| --- | --- | --- |
| 桌面壳 | Electron `39.8.10`，electron-vite `5.0.0`，electron-builder `26.0.12` | `apps/desktop/package.json`；`node -e "console.log(require('./apps/desktop/node_modules/electron/package.json').version)"` |
| 应用包 | `@openharness/desktop`，`main: ./out/main/index.js` | `apps/desktop/package.json` |
| 开发 | `pnpm --filter @openharness/desktop dev`（= `electron-vite dev`） | 同上 scripts |
| 构建 | `pnpm --filter @openharness/desktop build`（先 `verify-workspace-boundaries.mjs` + `typecheck`，再 `electron-vite build`） | 同上 |
| 单测 | `pnpm --filter @openharness/desktop exec vitest run`；配置 `apps/desktop/vitest.config.ts`，`include: src/**/*.test.{ts,tsx}`，alias `@renderer` / `@main` / `@shared` | 同上 |
| 类型检查 | `pnpm --filter @openharness/desktop typecheck`（`typecheck:node` + `typecheck:web`） | 同上 |
| 本机环境 | Windows `10.0.26200`（Win11 24H2+），`HKCU\...\Themes\Personalize\EnableTransparency = 1` | `Get-ItemProperty`、`node -e "os.release()"` |

### 0.2 主窗口创建现状

`apps/desktop/src/main/features/main-window/window.ts:19-40` 当前传入的窗口选项：

```ts
options: {
  width: 1180,
  height: 760,
  minWidth: 960,
  minHeight: 640,
  title: "OpenHarness",
  autoHideMenuBar: true,
  ...mainWindowChromeOptions(process.platform),   // frame / titleBarStyle / trafficLightPosition
  backgroundColor: mainWindowBackgroundColor(nativeTheme.shouldUseDarkColors), // 纯色
  webPreferences: { webviewTag: true },
}
```

- **没有** `vibrancy`、`backgroundMaterial`、`transparent`、`hasShadow`、`roundedCorners`、`visualEffectState`。
- `show: false` 由 `WindowManager.createWindow()` 注入（`core/services/window-manager.ts:42-45`）；`createMainWindow()` 返回后 `main/index.ts:82` **立刻调用 `showMainWindow()`**，所以窗口在 renderer 首帧以前就会显示，`ready-to-show`（`window.ts:55-57`）只是补充路径。这一点决定了启动遮罩的存在意义与 D11 的措辞。
- `show` 路径共三条：`main/index.ts` 的启动分支、`activate` 分支、`second-instance` 分支，最终都调用 `showMainWindow()`（`window.ts:45-49`）。
- `mainWindowChromeOptions()`（`window-chrome.ts:7-14`）：macOS `{ frame: true, titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 11 } }`；`win32` / `linux` 为 `{ frame: false }`。
- `mainWindowBackgroundColor()`（`window-background.ts:4-6`）：浅 `#f4f7f9`、深 `#20242a`，**与启动遮罩底色完全一致**（本任务会把遮罩底色去掉，见任务 8；`window-background.test.ts:3` 仍会 import 它）。
- Linux 已有 `app.commandLine.appendSwitch("enable-transparent-visuals")`（`src/main/index.ts:38-41`）。
- pet 窗口已用 `transparent: true` + `backgroundColor: "#00000000"` + `hasShadow: false`（`features/pet/window.ts:34-47`），是本仓库既有的透明窗口先例。

### 0.3 renderer 入口与玻璃面

| 项 | 事实 | 证据位置 |
| --- | --- | --- |
| 入口 HTML | `apps/desktop/src/renderer/index.html`（可自由编辑） | — |
| 挂载根 | `<div id="root">`；`main.tsx` 用 `createRoot(document.getElementById("root")!)` | `index.html:103`、`src/main.tsx` |
| 启动遮罩 | `<div id="startup-loading">`，**自带不透明底色** `#f4f7f9` / `#20242a`，含 `prefers-color-scheme` 与 `html.light` / `html.dark` 三套底色 | `index.html:12-98` |
| 玻璃面 | `body { @apply overflow-hidden bg-shell text-foreground }` | `assets/main.css:280-285` |
| `--shell` | 浅 `oklch(0.969 0.008 236)`，深 `oklch(0.22 0.012 250)`；`--chrome: var(--shell)`；`--sidebar: var(--shell)` | `assets/main.css:146-147,163,203-204,220` |
| 外壳节点 | `<main class="relative flex h-screen min-h-0 flex-col overflow-hidden bg-shell text-foreground">` | `layout/main-layout/main-layout.tsx:322` |
| 设置外壳 | `<main class="flex h-screen min-h-0 flex-col overflow-hidden bg-shell text-foreground">` | `layout/settings-layout/settings-layout.tsx:79` |
| 标题栏 | `<header class="titlebar-drag flex h-9 shrink-0 items-center bg-transparent text-ui-foreground select-none">`（已透明 + 已是拖拽区） | `layout/title-bar.tsx:133` |
| 内容层 | workspace `<section class="... rounded-tl-lg border-t border-l bg-conversation shadow-workspace">`；`--conversation` 是 `var(--background)`（`main.css:148,205`），实际取值浅 `oklch(0.99 0 0)` / 深 `oklch(0.145 0 0)`（`main.css:119,177`），**已不透明** | `main-layout.tsx:244`、`settings-layout.tsx:148` |
| 已有透明先例 | `html:has([data-pet-window]) { background: transparent }`（含 body、#root） | `assets/main.css:287-291` |
| 拖拽区工具类 | `.titlebar-drag { -webkit-app-region: drag }` | `assets/main.css:314-315` |

**结论：** 「玻璃面 = body/外壳的 `bg-shell`」在仓库里天然成立——`title-bar` 已 `bg-transparent`，`sidebar` 无背景（透出 shell），workspace 已经是不透明的 `bg-conversation`。`bg-shell` 的实际用处只有 `body`（`main.css:281`）、两个布局 `<main>`（`main-layout.tsx:322`、`settings-layout.tsx:79`）与标题栏里一个 10px（`size-2.5`）的装饰角块（`title-bar.tsx:463`），所以本任务**不需要**重构组件树，只需要：根节点按材质切换 + 原生材质开关 + 设置入口。

> **第 2 版更正：** 玻璃档的外壳必须**透明**（D7），第 1 版「其余一律保持不透明」的说法是错的——Windows Acrylic 与 Linux 合成器模糊只在 web 内容透明处可见，壳层不透明会把材质整块盖住，验收 1 不可能通过。

### 0.4 主题与外观系统

| 项 | 事实 | 证据位置 |
| --- | --- | --- |
| 偏好存储 | renderer `localStorage`，键 `openharness-desktop-appearance-v1`，`version: 1` | `components/appearance/appearance-preferences.ts:1,12-32` |
| 已有字段 | `theme`(system/light/dark)、`accent`、`uiFont`、`codeFont`、`uiFontSize`、`codeFontSize`、`reducedMotion` | 同上 |
| 写入点 | `AppearanceProvider.applyAppearanceToRoot()` → `root.classList.add(resolvedTheme)` 等 | `appearance-provider.tsx:93-111,164-171` |
| 启动期抢先应用 | `startup-theme.ts` → `applyStartupTheme()`（React 之前写 `html.light/dark`） | `startup-theme.ts`、`apply-startup-theme.ts:6-18` |
| 主进程主题耦合 | 仅用 `nativeTheme.shouldUseDarkColors` 取窗口底色；**主进程不写 `nativeTheme.themeSource`** | `window.ts:31` |
| 外观页结构 | 4 个 `AppearanceSection`：主题 / 颜色 / 字体 / 动效；交互用 `ToggleGroup` + `Field` + `FieldDescription` | `appearance-settings.tsx:85-232` |
| 外观页文案 | `settings-content.tsx:52-53`「调整 OpenHarness 在当前设备上的显示方式…」 | `settings-content.tsx` |
| 恢复默认弹窗 | 文案 `「恢复默认外观？」`、`「主题、颜色、字体、字号和动效」`，两处都被测试断言 | `appearance-settings.test.ts:140-141` |

主进程侧另有一套 `desktop-preferences.json`（`notificationMode` / `defaultOpenerId` / `defaultTerminalShellId` / `installIdentity` / `daemonOnboardingState`，见 `desktop-preferences-storage.ts:13-19`），经 `settingsUpdate*` 逐字段 IPC 暴露。本任务**不使用**这套存储（它没有「窗口材质」字段，硬塞进去需要改既有契约与测试）；材质偏好新建独立的 `desktop-window-material.json`，理由见修订后的 D3。renderer 的 `AppearancePreferences` **第 2 版不再新增字段**。

### 0.5 窗口事件与托盘现状

- `attachMainWindowBehavior()`（`window.ts:51-98`）已监听：`ready-to-show`、`close`、`minimize`、`restore`、`show`、`focus`、`maximize`、`unmaximize`。
- **`show` 已存在**（`window.ts:76-79`，做 `clearAttention` + `syncPetWithMainWindow`）——重绘补偿挂到同一个事件即可。
- **`resized` 未监听**，需要新增。
- 托盘 hide→show：`tray.ts:34-38 showMainFromTray()` → `showMainWindow()` → `win.show()`；点窗口 X 走 `window.ts:59-65` 转为 `win.hide()` + 显示 pet 窗口。两条路径都汇到 `show` 事件。
- 主窗口 `webPreferences` 默认 `backgroundThrottling: false`（`window-manager.ts:51`），隐藏时 renderer 不被节流。

### 0.6 关键技术决策记录（ADR 摘要）

**D1：材质选 Acrylic（Windows）。**
Acrylic 实时模糊窗口背后的动态内容，视觉上等价于 macOS 的 `under-window` vibrancy；Mica 只采样壁纸，窗口背后移动的内容不跟着变，与验收 1（拖到彩色壁纸上能看到被模糊的壁纸）不符。代价是拖动时 DWM 持续重算模糊，低端 GPU 可能掉帧——用验收 12 兜底。材质名收敛在 `window-material.ts` 的常量 `WINDOWS_WINDOW_MATERIAL` 里（全仓库唯一一处），将来改 Mica 只改这个值。

> **实机风险（第 2 版新增）：** Electron 在 Windows 上「Acrylic 何时可见」存在版本差异（见 D2 的证据），必须把任务 9 的「Windows 材质可见性」当作第一条实机验收；不可见时的正确处置是关闭 Windows 玻璃（D2 尾部），不要临时改用 `transparent: true`。

**D2（第 2 版重写）：macOS / Windows 都不用 `transparent: true`；Linux 只能用它。**
- **macOS：** `transparent: true` 会让系统不再画窗口阴影（官方教程 `docs/tutorial/custom-window-styles.md`「Transparent windows → Limitations」原文：*The native window shadow will not be shown on a transparent window*）。Electron ≥ 27 起 vibrancy 不再要求 `transparent: true`（electron/electron#40109），所以 macOS 用「`backgroundColor: "#00000000"` + `vibrancy`」。
- **Windows：** `transparent: true` 在 Electron 39 上有两条社区实机确认的回归：(1) `frame: false` + `transparent: true` 的窗口失去可缩放能力（electron/electron#48554：`transparent` 会强制 `thick_frame_ = false`，而 `IsResizable()` 在 `thick_frame_ == false` 时恒为 false；`thickFrame: true` 显式传入也救不回来）；(2) DWM 对 transparent 窗口的命中测试不同，破坏 Windows Snap / FancyZones（同类回归报告 NousResearch/hermes-agent#90237）。所以 Windows 也用「`backgroundColor: "#00000000"` + `backgroundMaterial: "acrylic"`」，不引入 `transparent`。
- **Windows 的不确定性（第 2 版新增，必须实机裁决）：** 部分 Electron 版本里不设 `transparent: true` 时 `backgroundMaterial` 不生效（electron/electron#49443，2026-01 报告；同时 electron/electron#38466 是同一现象的更早报告）。本机 Electron 39.8.10 + Win11 26200 属未验证组合。因此：
  1. 建窗时除构造选项外，还在 `onCreated` 里调用一次 `applyMainWindowMaterial()`（运行期 `setBackgroundMaterial()` 的 bug 在 Electron 36+ 已修，electron/electron#47386；构造期激活有历史 bug，electron/electron#46657）。
  2. 任务 9 先验「Windows 材质是否可见」。若不可见，**不要**改用 `transparent: true`（会踩上面两条回归）；正确处置是把 `supportsNativeWindowMaterial()` 里的 `win32` 暂时移除，让 Windows 的玻璃降级为 `unsupported-platform`（外观页文案会自动解释），并在交付记录里写明「待 Electron 修复后重新启用」。
     改动集中在 `window-material.ts` 与其测试：`window-material.test.ts` 里 `supportsNativeWindowMaterial("win32")` 与「Windows 玻璃」相关预期要同步改成关闭后的分支（这是**有意的行为变更**，不是把测试改成将就实现），任务 9 步骤 4.2 会重跑这两个测试文件确认。
- **Linux：** 没有可移植的原生材质，只能 `transparent: true` + `frame: false` + `hasShadow: false`（部分窗口管理器会给 frameless 窗口画外缘阴影/描边，看起来像一条黑线）。官方教程同页也提示透明窗口在部分平台不可缩放；本机无法验证 Linux，风险写入交付记录。

**D3（第 2 版重写）：材质偏好由主进程持久化（`desktop-window-material.json`），renderer 不新增 `AppearancePreferences` 字段。**
第 1 版的 D3 说「真相源放 renderer 的 `localStorage`，避免两处存储」，但那条前提不成立：主进程在 renderer 启动**之前**就要建窗口并决定材质，永远读不到 `localStorage`，所以主进程侧总得有一份持久化。若 renderer 再存一份，会出现两个具体坏处：(1) 第 1 版的 `setWindowMaterial` 根本没有写它，而 `setPreference` 每次改主题/字体都会把 `preferencesRef.current` 整体重新持久化，导致这个字段永远停留在启动时解析出的旧值——纯死字段；(2) 主进程文件丢失/损坏回退默认时，两边静默分叉，没有人能发现。
所以第 2 版改为：
- **唯一持久化 = 主进程的 `desktop-window-material.json`**（`window-material-preference.ts`，组织方式对齐 `desktop-preferences-storage.ts`：可注入路径的 `createWindowMaterialPreferenceStore(resolvePath)` + 惰性生产默认实例）。
- renderer 首帧快照来自 `additionalArguments`（D5），不读存储；设置页开关的选中态来自 `window.desktop.window.material.preference`（权威状态）；「恢复默认外观」在重置 `AppearancePreferences` 之后再调一次 `window:set-material`，把主进程偏好复位为 `glass`。
代价：外观偏好分属两处存储（一份 JSON、一份 localStorage）。可接受——它们由不同进程在生命周期不同阶段消费，且互不覆盖。

**D4：主进程不写 `nativeTheme.themeSource`。**
规格书 §6 要求「启动 loading 阶段先不要写原生窗口主题」。本仓库当前**确实没有任何地方**写 `themeSource`，该要求天然满足。本计划明确**不引入**该写入，并在 `window.ts` 相关位置加注释说明原因，防止后人「顺手补齐」。副作用：macOS 上若用户把应用主题设为浅色而系统是深色，vibrancy 背板仍跟随系统——这是刻意取舍（写 `themeSource` 会在启动期污染系统壳观察到的窗口主题）。

**D5：材质决策结果通过 `webPreferences.additionalArguments` 同步下发，不用 IPC。**
renderer 首帧必须已经知道「玻璃是否真的生效」才能一次画出正确的外壳底色；IPC 只能异步，会先出一帧不透明底再跳玻璃（正是验收 3 要排除的）。`additionalArguments` 追加到渲染进程 argv（`electron.d.ts:18357-18362`），preload 用 `process.argv` 同步解析，`applyStartupTheme()` 在 React 之前写成 `html[data-window-material]` / `html[data-window-shell]`。主窗口带**四个**前缀参数（preference / active / reason / shell）；宠物窗口等其它入口不带参数，`parseWindowMaterialArguments()` 返回 `null`，`window.desktop.window.material` 就是 `null`，Provider 与 `applyStartupTheme()` 据此跳过整条材质接线。

> **第 2 版更正：** 第 1 版在 preload 里写了 `?? { preference: "glass", active: "opaque", ... }` 的 fallback，让宠物窗口拿到一个伪造的非 null 状态，与「宠物窗口返回 null、Provider 跳过接线」自相矛盾，也让任务 6 的 null 分支在真机上永不触发。第 2 版删掉 fallback，契约类型为 `DesktopWindowMaterialState | null`。

**D6：不探测 Windows「透明效果」开关，靠 D7 的结构性保证代替。**
已实测本机 Electron 39.8.10：`nativeTheme.prefersReducedTransparency === false`，`systemPreferences` 在 win32 下只有 `getAccentColor/getAnimationSettings/getColor/getMediaAccessStatus`，**没有**读取 DWM 透明效果的 API。规格书 §3.3 的兜底要求是「不能出现半透明面板浮在实心底上的浑浊观感」——而按 D7，Windows 的面板在任何情况下都不透明，所以透明效果关闭时窗口退化为「系统给的不透明背板 + 我们自己的不透明外壳」，观感正常。因此**不引入** `reg query` 注册表探测或 `capturePage()` 像素探测（两者都会新增 spawn / 异步时序风险却换不来正确性）。这条是本次相对规格书 §3.3 的**有意简化**，写入交付记录。

**D7（第 2 版重写）：外壳模式分三档 —— `solid` / `translucent` / `transparent`。**
第 1 版「Windows/Linux 的 `--shell` 保持不透明」是错的：Acrylic 与 Linux 合成器模糊只在 web 内容透明的地方可见，而壳层（`body` + 两个布局 `<main>`）是不透明的 `bg-shell`，玻璃会被整块盖住，验收 1 不可能通过。第 2 版让主进程直接算出 `shell` 三档，renderer 只做写属性：
- `opaque` 档（用户选不透明 / 系统降级 / 平台不支持）→ `shell: "solid"`，CSS 不覆盖任何 token，保持现状；
- 玻璃 + macOS → `shell: "translucent"`，`--shell` 用半透明色给 vibrancy 轻微染色（保留第 1 版的观感设计）；
- 玻璃 + Windows/Linux → `shell: "transparent"`，`--shell: transparent`，把原生材质直接露出来。
CSS 选择器用 `html[data-window-shell="..."]`。第 1 版 D7 提到的 `data-window-platform` 从未被写入任何代码，已删除。Windows 系统「透明效果」关闭时 Acrylic 退化为系统给的不透明背板，「外壳全透明」的观感仍然正常（不是「半透明面板浮在实心底上」的浑浊状态）。

**D8：`visualEffectState: "active"`。**
默认值 `followWindow` 会让窗口失焦时材质转为 inactive（观感变暗发灰），在浅色壁纸上看起来像「材质坏了」。`active` 让材质保持活跃，代价是失焦不变暗，可接受（验收 5）。该选项只在 macOS 有效（`electron.d.ts:3932-3938`）。

> **第 2 版更正：** 第 1 版的理由「默认值会让玻璃视觉上关掉」不准确——官方默认值 `followWindow` 只是失焦时变 inactive，不是关掉。

**D9：系统「降低透明度」命中时自动切不透明底。**
`nativeTheme.prefersReducedTransparency === true`（macOS 辅助功能 → 显示 → 降低透明度）时，材质状态直接判为 `reduced-transparency`，renderer 用不透明外壳。该值只在建窗口与切换开关时读取；系统设置运行中变化不会触发 `nativeTheme.on("updated")`（该事件只覆盖 `shouldUseDarkColors` / `shouldUseHighContrastColors` / `shouldUseInvertedColorScheme`），属于已知限制，写入交付记录。

**D10：不做窗口级圆角能力判定，也不自绘圆角。**
`roundedCorners` 默认 `true`，在 macOS 与 Windows 11 Build 22000+ 上已经是正确行为（`electron.d.ts:3841-3847`），无需显式传入。规格书 §3.4 的 Linux `border-radius` + `clip-path` 自绘圆角会改变现有 Linux 观感（当前 Linux 窗口本来就是直角），且本机无法验证，故**不做**。规格书 §11 要求的「圆角能力判定」函数因此**不写**——写了就是无人调用的死代码（YAGNI）。

> **第 2 版更正：** 第 1 版「不修改 window-chrome.ts」里写「Electron 39 没有 `setTrafficLightPosition`，运行期重算无法实现」是错的——`win.setWindowButtonPosition({ x, y })`（`electron.d.ts:6260-6266`，传 `null` 复位）就是运行期入口，`trafficLightPosition`（`electron.d.ts:3901-3905`）只是构造期选项。不修改 `window-chrome.ts` 的真实理由是：本机是 Windows，把 `hiddenInset` 改成 `hidden` 并随缩放重算属于**无法验证**的 macOS 标题栏几何改动，收益不足。该能力记入交付记录的遗留项。

**D11：不为主题变化重挂材质。**
玻璃档位下 `backgroundColor` 是透明色，浅色/深色差异全部由 renderer 的 CSS token 与系统材质自身承担；不透明档位的 `backgroundColor` 在 renderer 首帧之前一直可见（`main/index.ts:82` 建完窗立刻 `show()`，不是只闪一帧）。重启后 `mainWindowBackgroundColor(nativeTheme.shouldUseDarkColors)` 会重新计算，因此不需要 `nativeTheme.on("updated")` 运行期换色。代价：应用主题设为浅色、系统为深色时，不透明档的窗口底色在下一次重启前不跟随应用主题——这与现状一致，不是本任务引入的回归。

### 0.7 工作区保护

主工作区 `E:/code/openharness-ts`（`main`）**长期存在与本任务无关的未提交改动**（第 1 版记录时的快照是：`MEMORIES.md`、`uploadClipboardImage → uploadMemoryAttachment` 改名、composer / conversation-page / attachment-actions 等一批改动）。执行时以当时的 `git status` 为准，不要相信本段列出的文件清单是完整的。

- `MEMORIES.md` 是定时审阅任务写的，**绝对不要提交**。
- 本计划要改 `desktop-api.ts` / `desktop-api-contract.ts` / `ipc-channels.ts`，但只动 `window` 命名空间（材质 IPC），不要碰 `attachments` / `sessions` 等其它命名空间。

**因此：执行本计划前必须用 `using-git-worktrees` 创建隔离工作区**（`git worktree add .worktrees/desktop-window-material -b feat/desktop-window-material`，随后在 worktree 内 `pnpm install`）。

每个任务只暂存本任务列出的文件，**禁止 `git add -A`**。

---

## 文件结构

### 新建文件

| 文件 | 职责 |
| --- | --- |
| `apps/desktop/src/shared/window-material-types.ts` | 材质偏好 / 状态 / 外壳模式的类型、argv 参数编解码。主进程与 preload 共用的唯一真相源。 |
| `apps/desktop/src/shared/window-material-types.test.ts` | 偏好守卫、argv 往返、缺参数 / 脏参数返回 `null`。 |
| `apps/desktop/src/main/features/main-window/window-material.ts` | 纯函数：按平台 + 状态算出窗口材质选项（含外壳模式）；运行期应用函数。 |
| `apps/desktop/src/main/features/main-window/window-material.test.ts` | 三平台 × 两档位 × 深浅色的选项矩阵与降级矩阵。 |
| `apps/desktop/src/main/features/main-window/window-material-repaint.ts` | Windows 有界双帧重绘补偿。 |
| `apps/desktop/src/main/features/main-window/window-material-repaint.test.ts` | 双次 invalidate、32ms 去重、销毁守卫。 |
| `apps/desktop/src/main/features/main-window/window-material-preference.ts` | 材质偏好的主进程持久化（唯一真相源）：读 / 写 `desktop-window-material.json`，损坏回退默认。 |
| `apps/desktop/src/main/features/main-window/window-material-preference.test.ts` | 缺文件 / 损坏 / 非法值的回退，写入后新实例能读回。 |
| `apps/desktop/src/renderer/src/components/appearance/window-material-copy.ts` | 外观页「窗口背景」区块的说明文案，按状态返回。 |
| `apps/desktop/src/renderer/src/components/appearance/window-material-copy.test.ts` | 五种状态的文案覆盖。 |
| `apps/desktop/src/renderer/src/startup-overlay.ts` | 启动遮罩的卸载时机状态机（入场动画 ∧ React 首帧，各自带兜底超时）。 |
| `apps/desktop/src/renderer/src/startup-overlay.test.ts` | 两个信号的先后顺序、兜底超时、淡出后真移除。 |

### 修改文件

| 文件 | 改动 |
| --- | --- |
| `apps/desktop/src/main/features/main-window/window.ts` | 展开材质选项；下发 `additionalArguments`；`onCreated` 里应用一次材质并挂 Windows 重绘补偿；导出 `currentMainWindowMaterialState()` 与 `setMainWindowMaterial()`。 |
| `apps/desktop/src/main/features/window-controls/ipc.ts` | 新增 `window:set-material` 一个 handler。 |
| `apps/desktop/src/shared/ipc-channels.ts` | 新增 `window:set-material` 通道常量与 `IpcInvokeMap` 条目。 |
| `apps/desktop/src/shared/desktop-api-contract.ts` | `window` 命名空间补 `material`（`DesktopWindowMaterialState \| null`）与 `setMaterial`。 |
| `apps/desktop/src/preload/desktop-api.ts` | 解析 `process.argv` 得到同步快照（无参数为 `null`）；接线 `setMaterial` 通道。 |
| `apps/desktop/src/preload/desktop-api.test.ts` | 断言快照在测试进程里为 `null`、`setMaterial` 走对通道。 |
| `apps/desktop/src/renderer/src/components/appearance/appearance-provider.tsx` | 持有材质状态、写 `data-window-material` / `data-window-shell`、暴露 `setWindowMaterial`，恢复默认时一并复位（不写 localStorage）。 |
| `apps/desktop/src/renderer/src/components/appearance/appearance-provider.test.ts` | 材质接线、乐观更新与失败回滚。 |
| `apps/desktop/src/renderer/src/components/appearance/appearance-settings.tsx` | 新增「窗口」区块 + 更新恢复默认弹窗文案。 |
| `apps/desktop/src/renderer/src/components/appearance/appearance-settings.test.ts` | 三处 mock 补材质字段；新开关用例；更新弹窗文案断言。 |
| `apps/desktop/src/renderer/src/apply-startup-theme.ts` | 导出 `readWindowMaterialSnapshot()` / `writeWindowMaterialAttributes()`，`applyStartupTheme()` 末尾写 material / shell 属性。 |
| `apps/desktop/src/renderer/src/apply-startup-theme.test.ts` | 断言 macOS 玻璃 / Windows 玻璃 / 快照缺失三种输入下的属性值。 |
| `apps/desktop/src/renderer/src/assets/main.css` | 新增 `html[data-window-shell]` 的 `--shell` 分支：`transparent`（Windows/Linux 玻璃）与 `translucent`（macOS 玻璃）。 |
| `apps/desktop/src/renderer/src/index.html` | 启动遮罩去掉不透明底色，改为「遮罩透明 + 中心徽标自带底色」；加入场动画与拖拽区。 |
| `apps/desktop/src/renderer/src/startup-loading.test.ts` | 断言遮罩无底色、徽标有底色与入场动画。 |
| `apps/desktop/src/renderer/src/main.tsx` | `render()` 之后调用 `watchStartupOverlay()`。 |
| `apps/desktop/src/renderer/src/dismiss-startup-loading.ts` | 改 import `STARTUP_OVERLAY_ELEMENT_ID`（行为不变，仍同步移除）。 |

### 不修改的文件与理由

- `apps/desktop/src/main/index.ts`：不需要预热探测（D6 去掉了探测），`createMainWindow` 保持同步。
- `apps/desktop/src/main/features/main-window/window.test.ts`：不修改（任务 4 不新增用例，原有 `mainWindowChromeOptions` 测试继续跑）。
- `apps/desktop/src/main/features/main-window/window-chrome.ts`：macOS 保持 `hiddenInset`。规格书 §3.2 建议改成 `hidden` + 固定 `trafficLightPosition` 并随缩放档位重算；运行期重定位其实有 `setWindowButtonPosition`（见 D10 更正），但本机是 Windows，改 `hiddenInset` → `hidden` 属于无法验证的 macOS 标题栏几何改动，故不动，作为遗留项写入交付记录。
- `apps/desktop/src/main/features/settings/*`：开关不走 `desktop-preferences.json`，新建独立小文件（D3）。
- `apps/desktop/src/renderer/src/components/desktop/layout/**`：外壳组件树已经满足要求（§0.3）。
- `apps/desktop/src/renderer/src/components/appearance/appearance-preferences.ts` / `.test.ts`：**第 2 版不再新增 `windowMaterial` 字段**（D3），这两个文件保持原样。
- `apps/desktop/src/renderer/src/dismiss-startup-loading.test.ts`：不修改（`dismissStartupLoading` 行为不变，第 1 版表格里「改为异步断言」是错的）。

---

### 任务 1：共享材质类型与 argv 编解码

**文件：**
- 创建：`apps/desktop/src/shared/window-material-types.ts`
- 测试：`apps/desktop/src/shared/window-material-types.test.ts`

- [ ] **步骤 1：编写失败测试**

```ts
// apps/desktop/src/shared/window-material-types.test.ts
import { describe, expect, it } from "vitest"

import {
  DEFAULT_WINDOW_MATERIAL_PREFERENCE,
  isDesktopWindowMaterialPreference,
  parseWindowMaterialArguments,
  windowMaterialArguments,
  type DesktopWindowMaterialState,
} from "./window-material-types"

describe("isDesktopWindowMaterialPreference", () => {
  it("只接受 glass 与 opaque", () => {
    expect(isDesktopWindowMaterialPreference("glass")).toBe(true)
    expect(isDesktopWindowMaterialPreference("opaque")).toBe(true)
    expect(isDesktopWindowMaterialPreference("acrylic")).toBe(false)
    expect(isDesktopWindowMaterialPreference(undefined)).toBe(false)
  })
})

describe("windowMaterialArguments", () => {
  it("往返后得到同一个状态", () => {
    const state: DesktopWindowMaterialState = {
      preference: "glass",
      active: "opaque",
      unavailableReason: "reduced-transparency",
      shell: "solid",
    }

    expect(parseWindowMaterialArguments(windowMaterialArguments(state))).toEqual(state)
  })

  it("默认偏好是玻璃", () => {
    expect(DEFAULT_WINDOW_MATERIAL_PREFERENCE).toBe("glass")
  })

  it("缺参数、脏参数、未知取值都返回 null（宠物窗口走这条路径）", () => {
    expect(parseWindowMaterialArguments(["--no-sandbox"])).toBeNull()
    expect(
      parseWindowMaterialArguments([
        "--openharness-window-material=glass",
        "--openharness-window-material-active=holographic",
        "--openharness-window-material-reason=none",
        "--openharness-window-material-shell=transparent",
      ])
    ).toBeNull()
    expect(
      parseWindowMaterialArguments([
        "--openharness-window-material=mirror",
        "--openharness-window-material-active=glass",
        "--openharness-window-material-reason=none",
        "--openharness-window-material-shell=translucent",
      ])
    ).toBeNull()
    expect(
      parseWindowMaterialArguments([
        "--openharness-window-material=glass",
        "--openharness-window-material-active=glass",
        "--openharness-window-material-reason=none",
        "--openharness-window-material-shell=holographic",
      ])
    ).toBeNull()
  })
})
```

> **第 2 版修正：** 第 1 版的往返用例对象缺 `translucentShell`/`shell` 字段，`toEqual` 与 `typecheck:node` 都会失败；第 1 版把「壳层是否半透明」建模成布尔值，现在改成三值枚举 `shell`（D7），因为 Windows/Linux 玻璃需要的是「全透明」而不是「半透明」。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/desktop exec vitest run src/shared/window-material-types.test.ts`
预期：FAIL，报错 `Failed to resolve import "./window-material-types"`。

- [ ] **步骤 3：编写最少实现代码**

```ts
// apps/desktop/src/shared/window-material-types.ts
export type DesktopWindowMaterialPreference = "glass" | "opaque"

/** 材质实际是否生效；"opaque" 既可能是用户选的，也可能是系统侧不支持后的降级。 */
export type DesktopWindowMaterialActive = "glass" | "opaque"

export type DesktopWindowMaterialUnavailableReason =
  | "unsupported-platform"
  | "reduced-transparency"

/**
 * renderer 外壳（`--shell`）该用什么底：
 * - "solid"：不透明档，token 保持原值；
 * - "translucent"：玻璃 + macOS，vibrancy 之上再叠一层半透明染色；
 * - "transparent"：玻璃 + Windows/Linux，外壳全透明，
 *   让原生材质（Acrylic / 合成器模糊）直接可见——材质只在 web 内容透明处才透得出来。
 */
export type DesktopWindowMaterialShell = "solid" | "translucent" | "transparent"

export interface DesktopWindowMaterialState {
  preference: DesktopWindowMaterialPreference
  active: DesktopWindowMaterialActive
  /** 只有「用户选了玻璃但没生效」时才有值，用于外观页说明原因。 */
  unavailableReason: DesktopWindowMaterialUnavailableReason | null
  shell: DesktopWindowMaterialShell
}

export const DEFAULT_WINDOW_MATERIAL_PREFERENCE: DesktopWindowMaterialPreference = "glass"

export const WINDOW_MATERIAL_ARGUMENT_PREFIX = "--openharness-window-material="
export const WINDOW_MATERIAL_ACTIVE_ARGUMENT_PREFIX = "--openharness-window-material-active="
export const WINDOW_MATERIAL_REASON_ARGUMENT_PREFIX = "--openharness-window-material-reason="
export const WINDOW_MATERIAL_SHELL_ARGUMENT_PREFIX = "--openharness-window-material-shell="
export const NO_WINDOW_MATERIAL_REASON = "none"

const PREFERENCES = new Set<DesktopWindowMaterialPreference>(["glass", "opaque"])
const ACTIVE_VALUES = new Set<DesktopWindowMaterialActive>(["glass", "opaque"])
const REASONS = new Set<DesktopWindowMaterialUnavailableReason>([
  "unsupported-platform",
  "reduced-transparency",
])
const SHELL_VALUES = new Set<DesktopWindowMaterialShell>(["solid", "translucent", "transparent"])

export function isDesktopWindowMaterialPreference(
  value: unknown
): value is DesktopWindowMaterialPreference {
  return typeof value === "string" && PREFERENCES.has(value as DesktopWindowMaterialPreference)
}

export function isGlassWindowMaterial(state: DesktopWindowMaterialState): boolean {
  return state.active === "glass"
}

/**
 * 主进程建窗口时把结论塞进 webPreferences.additionalArguments，preload 再同步读回来。
 * 走 argv 而不是 IPC 是因为 renderer 首帧就必须知道玻璃是否真的生效，异步 IPC 会先出一帧错误底色。
 */
export function windowMaterialArguments(state: DesktopWindowMaterialState): string[] {
  return [
    `${WINDOW_MATERIAL_ARGUMENT_PREFIX}${state.preference}`,
    `${WINDOW_MATERIAL_ACTIVE_ARGUMENT_PREFIX}${state.active}`,
    `${WINDOW_MATERIAL_REASON_ARGUMENT_PREFIX}${state.unavailableReason ?? NO_WINDOW_MATERIAL_REASON}`,
    `${WINDOW_MATERIAL_SHELL_ARGUMENT_PREFIX}${state.shell}`,
  ]
}

/** 只有主窗口会带这四个参数；宠物窗口等其它入口返回 null。 */
export function parseWindowMaterialArguments(
  argv: readonly string[]
): DesktopWindowMaterialState | null {
  const preference = readArgument(argv, WINDOW_MATERIAL_ARGUMENT_PREFIX)
  const active = readArgument(argv, WINDOW_MATERIAL_ACTIVE_ARGUMENT_PREFIX)
  const reason = readArgument(argv, WINDOW_MATERIAL_REASON_ARGUMENT_PREFIX)
  const shell = readArgument(argv, WINDOW_MATERIAL_SHELL_ARGUMENT_PREFIX)

  if (!isDesktopWindowMaterialPreference(preference)) return null
  if (typeof active !== "string" || !ACTIVE_VALUES.has(active as DesktopWindowMaterialActive)) {
    return null
  }
  if (reason === null) return null
  if (
    reason !== NO_WINDOW_MATERIAL_REASON &&
    !REASONS.has(reason as DesktopWindowMaterialUnavailableReason)
  ) {
    return null
  }
  if (shell === null || !SHELL_VALUES.has(shell as DesktopWindowMaterialShell)) return null

  return {
    preference,
    active: active as DesktopWindowMaterialActive,
    unavailableReason:
      reason === NO_WINDOW_MATERIAL_REASON
        ? null
        : (reason as DesktopWindowMaterialUnavailableReason),
    shell: shell as DesktopWindowMaterialShell,
  }
}

function readArgument(argv: readonly string[], prefix: string): string | null {
  const match = argv.find((value) => value.startsWith(prefix))
  return match === undefined ? null : match.slice(prefix.length)
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/desktop exec vitest run src/shared/window-material-types.test.ts`
预期：PASS，4 个用例全绿。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/shared/window-material-types.ts apps/desktop/src/shared/window-material-types.test.ts
git commit -m "feat(desktop): 新增窗口材质状态的共享类型与 argv 编解码"
```

---

### 任务 2：主进程材质选项纯函数

**文件：**
- 创建：`apps/desktop/src/main/features/main-window/window-material.ts`
- 测试：`apps/desktop/src/main/features/main-window/window-material.test.ts`

- [ ] **步骤 1：编写失败测试**

```ts
// apps/desktop/src/main/features/main-window/window-material.test.ts
import { describe, expect, it } from "vitest"

import {
  mainWindowMaterialOptions,
  resolveWindowMaterialState,
  supportsNativeWindowMaterial,
  TRANSPARENT_WINDOW_BACKGROUND,
} from "./window-material"

describe("supportsNativeWindowMaterial", () => {
  it("只在 darwin / win32 / linux 上为真", () => {
    expect(supportsNativeWindowMaterial("darwin")).toBe(true)
    expect(supportsNativeWindowMaterial("win32")).toBe(true)
    expect(supportsNativeWindowMaterial("linux")).toBe(true)
    expect(supportsNativeWindowMaterial("freebsd")).toBe(false)
  })
})

describe("resolveWindowMaterialState", () => {
  it("用户选不透明时直接生效，且没有降级原因", () => {
    expect(
      resolveWindowMaterialState({
        platform: "darwin",
        preference: "opaque",
        reducedTransparency: true,
      })
    ).toEqual({
      preference: "opaque",
      active: "opaque",
      unavailableReason: null,
      shell: "solid",
    })
  })

  it("macOS 玻璃生效时外壳半透明染色", () => {
    expect(
      resolveWindowMaterialState({
        platform: "darwin",
        preference: "glass",
        reducedTransparency: false,
      })
    ).toEqual({
      preference: "glass",
      active: "glass",
      unavailableReason: null,
      shell: "translucent",
    })
  })

  it("Windows 玻璃生效时外壳全透明（材质只在内容透明处可见）", () => {
    expect(
      resolveWindowMaterialState({
        platform: "win32",
        preference: "glass",
        reducedTransparency: false,
      })
    ).toEqual({
      preference: "glass",
      active: "glass",
      unavailableReason: null,
      shell: "transparent",
    })
  })

  it("Linux 玻璃生效时外壳同样是全透明", () => {
    expect(
      resolveWindowMaterialState({
        platform: "linux",
        preference: "glass",
        reducedTransparency: false,
      })
    ).toEqual({
      preference: "glass",
      active: "glass",
      unavailableReason: null,
      shell: "transparent",
    })
  })

  it("系统开启降低透明度时降级为不透明并给出原因", () => {
    expect(
      resolveWindowMaterialState({
        platform: "darwin",
        preference: "glass",
        reducedTransparency: true,
      })
    ).toEqual({
      preference: "glass",
      active: "opaque",
      unavailableReason: "reduced-transparency",
      shell: "solid",
    })
  })

  it("平台不支持时降级为不透明并给出原因", () => {
    expect(
      resolveWindowMaterialState({
        platform: "freebsd",
        preference: "glass",
        reducedTransparency: false,
      })
    ).toEqual({
      preference: "glass",
      active: "opaque",
      unavailableReason: "unsupported-platform",
      shell: "solid",
    })
  })
})

describe("mainWindowMaterialOptions", () => {
  const glass = {
    preference: "glass",
    active: "glass",
    unavailableReason: null,
    shell: "transparent",
  } as const
  const opaque = {
    preference: "opaque",
    active: "opaque",
    unavailableReason: null,
    shell: "solid",
  } as const

  it("macOS 玻璃用 vibrancy 且不用 transparent", () => {
    expect(
      mainWindowMaterialOptions({ platform: "darwin", state: glass, useDarkColors: false })
    ).toEqual({
      backgroundColor: TRANSPARENT_WINDOW_BACKGROUND,
      vibrancy: "under-window",
      visualEffectState: "active",
    })
  })

  it("macOS 不透明用主题底色且不带材质属性", () => {
    expect(
      mainWindowMaterialOptions({ platform: "darwin", state: opaque, useDarkColors: true })
    ).toEqual({ backgroundColor: "#20242a" })
  })

  it("Windows 玻璃用 acrylic 且不用 transparent", () => {
    expect(
      mainWindowMaterialOptions({ platform: "win32", state: glass, useDarkColors: false })
    ).toEqual({
      backgroundColor: TRANSPARENT_WINDOW_BACKGROUND,
      backgroundMaterial: "acrylic",
    })
  })

  it("Windows 不透明用主题底色", () => {
    expect(
      mainWindowMaterialOptions({ platform: "win32", state: opaque, useDarkColors: false })
    ).toEqual({ backgroundColor: "#f4f7f9" })
  })

  it("Linux 无条件透明无阴影（运行期无法重建窗口，两档位都靠 renderer 铺底）", () => {
    const expected = {
      backgroundColor: TRANSPARENT_WINDOW_BACKGROUND,
      transparent: true,
      hasShadow: false,
    }

    expect(
      mainWindowMaterialOptions({ platform: "linux", state: glass, useDarkColors: false })
    ).toEqual(expected)
    expect(
      mainWindowMaterialOptions({ platform: "linux", state: opaque, useDarkColors: true })
    ).toEqual(expected)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/desktop exec vitest run src/main/features/main-window/window-material.test.ts`
预期：FAIL，报错 `Failed to resolve import "./window-material"`。

- [ ] **步骤 3：编写最少实现代码**

```ts
// apps/desktop/src/main/features/main-window/window-material.ts
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron"

import {
  isGlassWindowMaterial,
  type DesktopWindowMaterialPreference,
  type DesktopWindowMaterialState,
  type DesktopWindowMaterialUnavailableReason,
} from "../../../shared/window-material-types"
import { mainWindowBackgroundColor } from "./window-background"

/**
 * 窗口底色。macOS 的 vibrancy 与 Windows 的 backgroundMaterial 都要求「窗口背景色为透明」；
 * 页面的不透明区域仍然由 renderer 自己铺（内容层 token 都是不透明的）。
 * 注意：这里刻意不配 transparent: true —— macOS 上它会让系统不画窗口阴影（官方教程原文），
 * Windows 上 frame:false + transparent:true 在 Electron 39 会失去可缩放能力并破坏 Snap（见 D2）。
 */
export const TRANSPARENT_WINDOW_BACKGROUND = "#00000000"

/**
 * Windows 材质名。选 acrylic 而不是 mica：acrylic 实时模糊窗口背后的动态内容，
 * 效果最接近 macOS 的 under-window vibrancy；mica 只采样桌面壁纸，窗口背后移动的内容不会跟着变。
 * 代价是拖动窗口时 DWM 持续重算模糊，低端 GPU 可能掉帧。若要换成 mica，只改这一处。
 */
export const WINDOWS_WINDOW_MATERIAL = "acrylic" as const

export const MACOS_WINDOW_VIBRANCY = "under-window" as const

export function supportsNativeWindowMaterial(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32" || platform === "linux"
}

export function resolveWindowMaterialState(input: {
  platform: NodeJS.Platform
  preference: DesktopWindowMaterialPreference
  reducedTransparency: boolean
}): DesktopWindowMaterialState {
  const solid = (
    preference: DesktopWindowMaterialPreference,
    unavailableReason: DesktopWindowMaterialUnavailableReason | null
  ): DesktopWindowMaterialState => ({
    preference,
    active: "opaque",
    unavailableReason,
    shell: "solid",
  })

  if (input.preference === "opaque") return solid("opaque", null)

  // 系统级「降低透明度」（macOS 辅助功能）开启时必须退化为不透明底。
  if (input.reducedTransparency) return solid("glass", "reduced-transparency")

  if (!supportsNativeWindowMaterial(input.platform)) {
    return solid("glass", "unsupported-platform")
  }

  return {
    preference: "glass",
    active: "glass",
    unavailableReason: null,
    // macOS 的 vibrancy 是稳定材质，外壳再叠一层半透明染色；
    // Windows/Linux 必须把外壳全部让出来（transparent），否则系统材质会被不透明的壳层盖住。
    shell: input.platform === "darwin" ? "translucent" : "transparent",
  }
}

export type MainWindowMaterialOptions = Pick<
  BrowserWindowConstructorOptions,
  "backgroundColor" | "transparent" | "hasShadow" | "vibrancy" | "visualEffectState" | "backgroundMaterial"
>

export function mainWindowMaterialOptions(input: {
  platform: NodeJS.Platform
  state: DesktopWindowMaterialState
  useDarkColors: boolean
}): MainWindowMaterialOptions {
  const glass = isGlassWindowMaterial(input.state)
  const opaqueBackground = mainWindowBackgroundColor(input.useDarkColors)

  if (input.platform === "darwin") {
    // 整窗玻璃用 vibrancy: under-window。
    // visualEffectState: active 让窗口失焦时材质仍然生效；默认值会让玻璃「视觉上关掉」，看起来像坏了。
    return glass
      ? {
          backgroundColor: TRANSPARENT_WINDOW_BACKGROUND,
          vibrancy: MACOS_WINDOW_VIBRANCY,
          visualEffectState: "active",
        }
      : { backgroundColor: opaqueBackground }
  }

  if (input.platform === "win32") {
    // frame: false 由 window-chrome.ts 提供，窗口控制按钮由 renderer 自绘，避免出现两套按钮。
    // 实机风险：不设 transparent 时 Acrylic 可能不生效（D2），任务 9 有专门验收与降级处置。
    return glass
      ? { backgroundColor: TRANSPARENT_WINDOW_BACKGROUND, backgroundMaterial: WINDOWS_WINDOW_MATERIAL }
      : { backgroundColor: opaqueBackground }
  }

  // Linux 没有可移植的原生材质，只能靠透明窗口 + 桌面合成器自带模糊（KWin 等，需用户开启）。
  // 这里两档位都无条件透明：transparent 是构造期选项、运行期改不了，
  // 若在不透明档位用不透明窗口，用户之后切回玻璃就必须重启；而 renderer 在不透明档位会自己铺满底色，
  // 所以「始终透明」两档位都正确。hasShadow: false 是因为部分窗口管理器会给 frameless 窗口画外侧阴影/描边，
  // 看起来像窗口外缘多了一条黑线。renderer 圆角本仓库没有做，因此不涉及「透明底把圆角填成直角黑底」。
  return {
    backgroundColor: TRANSPARENT_WINDOW_BACKGROUND,
    transparent: true,
    hasShadow: false,
  }
}

/**
 * 运行期切换材质。Linux 的 transparent 只能构造期指定，这里刻意什么都不做：
 * 窗口始终是透明底，外壳观感完全由 renderer 的 data-window-shell 负责
 * （把底色改成不透明反而会在透明窗口上产生无法预测的结果）。
 */
export function applyMainWindowMaterial(
  win: BrowserWindow,
  input: {
    platform: NodeJS.Platform
    state: DesktopWindowMaterialState
    useDarkColors: boolean
  }
): void {
  if (win.isDestroyed()) return

  const glass = isGlassWindowMaterial(input.state)

  if (input.platform === "darwin") {
    win.setBackgroundColor(
      glass ? TRANSPARENT_WINDOW_BACKGROUND : mainWindowBackgroundColor(input.useDarkColors)
    )
    win.setVibrancy(glass ? MACOS_WINDOW_VIBRANCY : null)
    return
  }

  if (input.platform === "win32") {
    win.setBackgroundColor(
      glass ? TRANSPARENT_WINDOW_BACKGROUND : mainWindowBackgroundColor(input.useDarkColors)
    )
    // 运行期设置是兜底：Electron 36 之前存在「动态 setBackgroundMaterial 不生效」的 bug
    // （electron/electron#47386），构造期激活也有历史 bug（#46657）。
    win.setBackgroundMaterial(glass ? WINDOWS_WINDOW_MATERIAL : "none")
    return
  }

  // Linux：不碰底色与材质，只由 renderer 的 data-window-shell 决定观感。
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/desktop exec vitest run src/main/features/main-window/window-material.test.ts`
预期：PASS，12 个用例全绿（1 个 `supportsNativeWindowMaterial` + 6 个 `resolveWindowMaterialState` + 5 个 `mainWindowMaterialOptions`）。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/main/features/main-window/window-material.ts apps/desktop/src/main/features/main-window/window-material.test.ts
git commit -m "feat(desktop): 新增按平台返回窗口原生材质选项的纯函数"
```

---

### 任务 3：Windows 有界双帧重绘补偿

**文件：**
- 创建：`apps/desktop/src/main/features/main-window/window-material-repaint.ts`
- 测试：`apps/desktop/src/main/features/main-window/window-material-repaint.test.ts`

- [ ] **步骤 1：编写失败测试**

```ts
// apps/desktop/src/main/features/main-window/window-material-repaint.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  MATERIAL_REPAINT_DELAY_MS,
  attachWindowsMaterialRepaint,
} from "./window-material-repaint"

type FakeWindow = Parameters<typeof attachWindowsMaterialRepaint>[0]

function createFakeWindow() {
  const listeners = new Map<string, () => void>()
  const invalidate = vi.fn()
  const win = {
    isDestroyed: vi.fn(() => false),
    webContents: { isDestroyed: vi.fn(() => false), invalidate },
    on: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener)
      return win
    }),
    once: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener)
      return win
    }),
  }
  return { win, listeners, invalidate }
}

describe("attachWindowsMaterialRepaint", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("resized 后立即重绘一次，32ms 后再补一次", () => {
    const { win, listeners, invalidate } = createFakeWindow()
    attachWindowsMaterialRepaint(win as unknown as FakeWindow)

    listeners.get("resized")!()
    expect(invalidate).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(MATERIAL_REPAINT_DELAY_MS)
    expect(invalidate).toHaveBeenCalledTimes(2)
  })

  it("show 复用同一个补偿函数", () => {
    const { win, listeners, invalidate } = createFakeWindow()
    attachWindowsMaterialRepaint(win as unknown as FakeWindow)

    listeners.get("show")!()
    vi.advanceTimersByTime(MATERIAL_REPAINT_DELAY_MS)

    expect(invalidate).toHaveBeenCalledTimes(2)
  })

  it("连续事件只保留一个补帧定时器", () => {
    const { win, listeners, invalidate } = createFakeWindow()
    attachWindowsMaterialRepaint(win as unknown as FakeWindow)

    listeners.get("resized")!()
    listeners.get("resized")!()
    vi.advanceTimersByTime(MATERIAL_REPAINT_DELAY_MS)

    expect(invalidate).toHaveBeenCalledTimes(3)
  })

  it("窗口或 webContents 已销毁时不再重绘", () => {
    const { win, listeners, invalidate } = createFakeWindow()
    win.isDestroyed.mockReturnValue(true)
    attachWindowsMaterialRepaint(win as unknown as FakeWindow)

    listeners.get("resized")!()
    vi.advanceTimersByTime(MATERIAL_REPAINT_DELAY_MS)

    expect(invalidate).not.toHaveBeenCalled()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/desktop exec vitest run src/main/features/main-window/window-material-repaint.test.ts`
预期：FAIL，报错 `Failed to resolve import "./window-material-repaint"`。

- [ ] **步骤 3：编写最少实现代码**

```ts
// apps/desktop/src/main/features/main-window/window-material-repaint.ts
import type { BrowserWindow } from "electron"

/** 补帧延迟。取一帧多一点（32ms ≈ 2 帧 @60Hz），让后端合成器有机会先处理完窗口 bounds 变化。 */
export const MATERIAL_REPAINT_DELAY_MS = 32

/**
 * Windows 上 acrylic 窗口的两处合成层补偿，共用同一个「有界双帧重绘」：
 *
 * - `resized`：手动拉伸结束后，Chromium 偶发只更新窗口 bounds，renderer 最后一帧没完整 repaint，
 *   新扩展出来的区域会留下宿主底色（用户看到的是一块死区）。
 * - `show`：窗口 hide 到托盘后再次 show 时，可能继续复用已经失效的合成 surface——
 *   renderer 与后端进程都还活着，但窗口只剩宿主底色。
 *
 * 处理方式：立即 invalidate 一次，32ms 后再补一次；已有 pending 定时器先清掉，保证有界。
 *
 * 禁止在这里 reload renderer / 重建 webContents / 重建会话：这是合成层问题，不是页面状态问题。
 */
export function attachWindowsMaterialRepaint(win: BrowserWindow): void {
  let pending: ReturnType<typeof setTimeout> | null = null

  const repaint = (): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return

    win.webContents.invalidate()

    if (pending) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = null
      if (win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.invalidate()
    }, MATERIAL_REPAINT_DELAY_MS)
    pending.unref?.()
  }

  win.on("resized", repaint)
  win.on("show", repaint)
  win.once("closed", () => {
    if (!pending) return
    clearTimeout(pending)
    pending = null
  })
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/desktop exec vitest run src/main/features/main-window/window-material-repaint.test.ts`
预期：PASS，4 个用例全绿。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/main/features/main-window/window-material-repaint.ts apps/desktop/src/main/features/main-window/window-material-repaint.test.ts
git commit -m "fix(desktop): Windows 磨玻璃窗口补有界双帧重绘"
```

---

### 任务 4：主进程偏好回读缓存 + 主窗口接线

**文件：**
- 创建：`apps/desktop/src/main/features/main-window/window-material-preference.ts`
- 创建：`apps/desktop/src/main/features/main-window/window-material-preference.test.ts`
- 修改：`apps/desktop/src/main/features/main-window/window.ts`

> 测试放在独立的 `window-material-preference.test.ts`，不塞进 `window.test.ts`：`window.ts` 顶层在类型导入之外还有值导入，
> 但「import 就会碎」的说法不成立——vitest（Vite SSR）会把 `import { app } from "electron"` 编译成属性访问，拿到 `undefined`
> （electron 包的 CJS main 在 node 下导出的是可执行文件路径字符串，不是 API 对象）。真正会碎的是**调用** `app.getPath()`
> 这类 API。所以纪律是：偏好存储用「可注入路径的工厂」隔离，测试只碰工厂、不碰默认实例；将来若要测默认实例，
> 必须像 `desktop-preferences.test.ts` 那样 `vi.mock("electron", ...)`。

- [ ] **步骤 1：编写失败测试**

```ts
// apps/desktop/src/main/features/main-window/window-material-preference.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createWindowMaterialPreferenceStore,
  resolveWindowMaterialPreferencePath,
  WINDOW_MATERIAL_PREFERENCE_FILE_NAME,
} from "./window-material-preference"

describe("createWindowMaterialPreferenceStore", () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wm-"))
    path = join(dir, WINDOW_MATERIAL_PREFERENCE_FILE_NAME)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("文件缺失时返回默认玻璃", () => {
    const store = createWindowMaterialPreferenceStore(() => path)
    expect(store.get()).toBe("glass")
  })

  it("写入后新实例能读回同一个偏好", () => {
    createWindowMaterialPreferenceStore(() => path).set("opaque")
    expect(createWindowMaterialPreferenceStore(() => path).get()).toBe("opaque")
  })

  it("损坏内容回退默认", () => {
    writeFileSync(path, "not-json", "utf8")
    expect(createWindowMaterialPreferenceStore(() => path).get()).toBe("glass")
  })

  it("非法取值回退默认", () => {
    writeFileSync(path, JSON.stringify("holographic"), "utf8")
    expect(createWindowMaterialPreferenceStore(() => path).get()).toBe("glass")
  })
})

describe("resolveWindowMaterialPreferencePath", () => {
  it("落在 userData 目录下", () => {
    expect(resolveWindowMaterialPreferencePath("/tmp/oh")).toBe(
      join("/tmp/oh", WINDOW_MATERIAL_PREFERENCE_FILE_NAME)
    )
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/desktop exec vitest run src/main/features/main-window/window-material-preference.test.ts`
预期：FAIL，报错 `Failed to resolve import "./window-material-preference"`。

- [ ] **步骤 3：编写实现代码**

```ts
// apps/desktop/src/main/features/main-window/window-material-preference.ts
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { app } from "electron"

import {
  DEFAULT_WINDOW_MATERIAL_PREFERENCE,
  isDesktopWindowMaterialPreference,
  type DesktopWindowMaterialPreference,
} from "../../../shared/window-material-types"

export const WINDOW_MATERIAL_PREFERENCE_FILE_NAME = "desktop-window-material.json"

/**
 * 材质偏好的持久化（唯一真相源，D3）。
 *
 * 主进程在建窗口时必须同步知道上次选了什么：走 renderer 的 localStorage 行不通（那时 renderer 还没起来），
 * 所以偏好落在 userData 下的一个小 JSON 文件里，模式对齐 `desktop-preferences-storage.ts`。
 * 刻意不做内存缓存：读盘只在建窗口与切换材质时发生（低频），少一层缓存就少一处「缓存与磁盘不一致」的状态；
 * 文件缺失、损坏或取值非法时一律回退默认值。
 */
export function resolveWindowMaterialPreferencePath(userDataDir: string): string {
  return join(userDataDir, WINDOW_MATERIAL_PREFERENCE_FILE_NAME)
}

export interface WindowMaterialPreferenceStore {
  get(): DesktopWindowMaterialPreference
  set(preference: DesktopWindowMaterialPreference): void
}

export function createWindowMaterialPreferenceStore(
  resolvePath: () => string
): WindowMaterialPreferenceStore {
  const get = (): DesktopWindowMaterialPreference => {
    try {
      const raw = JSON.parse(readFileSync(resolvePath(), "utf8")) as unknown
      return isDesktopWindowMaterialPreference(raw) ? raw : DEFAULT_WINDOW_MATERIAL_PREFERENCE
    } catch {
      return DEFAULT_WINDOW_MATERIAL_PREFERENCE
    }
  }

  const set = (preference: DesktopWindowMaterialPreference): void => {
    try {
      writeFileSync(resolvePath(), JSON.stringify(preference), "utf8")
    } catch (error) {
      // 写盘失败不影响本次会话：材质已经应用，只是重启后会退回上一次的值。
      console.warn("[window-material] failed to persist window material preference", error)
    }
  }

  return { get, set }
}

// 生产默认实例惰性创建：只有真正被调用时才触碰 electron 的 app，模块加载期不依赖它。
let defaultStore: WindowMaterialPreferenceStore | null = null

function resolveDefaultStore(): WindowMaterialPreferenceStore {
  if (!defaultStore) {
    defaultStore = createWindowMaterialPreferenceStore(() =>
      resolveWindowMaterialPreferencePath(app.getPath("userData"))
    )
  }
  return defaultStore
}

export function getWindowMaterialPreference(): DesktopWindowMaterialPreference {
  return resolveDefaultStore().get()
}

export function setWindowMaterialPreference(preference: DesktopWindowMaterialPreference): void {
  resolveDefaultStore().set(preference)
}
```

修改 `apps/desktop/src/main/features/main-window/window.ts`：

1. 顶部 import 改为：

```ts
import { BrowserWindow, nativeTheme, shell, type WebPreferences } from "electron"

import { IpcEvents } from "../../../shared/ipc-channels"
import type { AppContext } from "../../core/app-context"
import { isForceQuit } from "../../core/services/lifecycle"
import { showPetWindow, syncPetWithMainWindow } from "../pet/window"
import { clearAttention } from "../tray/attention-badge"
import { isAllowedWebviewUrl } from "./webview-policy"
import { mainWindowChromeOptions } from "./window-chrome"
import {
  applyMainWindowMaterial,
  mainWindowMaterialOptions,
  resolveWindowMaterialState,
} from "./window-material"
import { attachWindowsMaterialRepaint } from "./window-material-repaint"
import {
  getWindowMaterialPreference,
  setWindowMaterialPreference,
} from "./window-material-preference"
import {
  isDesktopWindowMaterialPreference,
  type DesktopWindowMaterialPreference,
  type DesktopWindowMaterialState,
  windowMaterialArguments,
} from "../../../shared/window-material-types"
```

（原 `mainWindowBackgroundColor` 的 import 删除——`window.ts:31` 是它唯一的使用点；`window-background.ts` 本身仍由 `window-material.ts` 与 `window-background.test.ts:3` 使用。）

2. `createMainWindow()` 的 `options` 与 `onCreated` 改为：

```ts
  const platform = process.platform
  const materialState = currentMainWindowMaterialState(platform)

  const mainWindow = ctx.windowManager.createWindow({
    id: "main",
    route: "/",
    paths: ctx.paths,
    options: {
      width: 1180,
      height: 760,
      minWidth: 960,
      minHeight: 640,
      title: "OpenHarness",
      autoHideMenuBar: true,
      ...mainWindowChromeOptions(platform),
      ...mainWindowMaterialOptions({
        platform,
        state: materialState,
        useDarkColors: nativeTheme.shouldUseDarkColors,
      }),
      webPreferences: {
        webviewTag: true,
        // renderer 首帧就要知道玻璃是否真的生效，才能一次性画出正确的外壳底色。
        // 走 additionalArguments 而不是 IPC：IPC 只能异步，会在玻璃与不透明之间闪一帧。
        additionalArguments: windowMaterialArguments(materialState),
      },
    },
    onCreated: (win) => {
      attachMainWindowBehavior(ctx, win)
      attachMainWindowDiagnostics(win)
      // 构造期材质激活有历史 bug（electron/electron#46657、#47386），这里再应用一次做兜底。
      applyMainWindowMaterial(win, {
        platform,
        state: materialState,
        useDarkColors: nativeTheme.shouldUseDarkColors,
      })
      // 仅 Windows 需要：acrylic 窗口在拉伸与托盘 hide→show 后可能留下合成层死区。
      if (platform === "win32") attachWindowsMaterialRepaint(win)
    },
  })
```

3. 在 `createMainWindow` 之后新增两个导出：

```ts
/**
 * 当前材质状态。刻意保持同步：建窗口路径（托盘、activate、second-instance 都会走到）不能 await。
 * 刻意不写 nativeTheme.themeSource：启动 loading 阶段写原生窗口主题会污染系统壳观察到的窗口主题，
 * 且会让 macOS vibrancy 跟随应用主题而不是系统主题。不要在这里「顺手补齐」。
 */
export function currentMainWindowMaterialState(
  platform: NodeJS.Platform = process.platform
): DesktopWindowMaterialState {
  return resolveWindowMaterialState({
    platform,
    preference: getWindowMaterialPreference(),
    reducedTransparency: nativeTheme.prefersReducedTransparency,
  })
}

/** 供 `window:set-material` 使用：先落盘偏好，再把材质应用到窗口。 */
export function setMainWindowMaterial(
  win: BrowserWindow,
  preference: DesktopWindowMaterialPreference
): DesktopWindowMaterialState {
  if (!isDesktopWindowMaterialPreference(preference)) {
    throw new Error("未知的窗口材质设置。")
  }

  setWindowMaterialPreference(preference)

  const state = currentMainWindowMaterialState(process.platform)
  applyMainWindowMaterial(win, {
    platform: process.platform,
    state,
    useDarkColors: nativeTheme.shouldUseDarkColors,
  })

  return state
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/desktop exec vitest run src/main/features/main-window/window-material-preference.test.ts src/main/features/main-window/window-material.test.ts src/main/features/main-window/window.test.ts`
预期：PASS（`window.test.ts` 的既有 `mainWindowChromeOptions` 用例不动，仍然绿）。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/main/features/main-window/window.ts \
        apps/desktop/src/main/features/main-window/window-material-preference.ts \
        apps/desktop/src/main/features/main-window/window-material-preference.test.ts
git commit -m "feat(desktop): 主窗口接入原生材质并下发材质快照到 renderer"
```

---

### 任务 5：新增 IPC 通道 + preload 桥

**文件：**
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 修改：`apps/desktop/src/shared/desktop-api-contract.ts`
- 修改：`apps/desktop/src/preload/desktop-api.ts`
- 修改：`apps/desktop/src/main/features/window-controls/ipc.ts`
- 测试：`apps/desktop/src/preload/desktop-api.test.ts`

- [ ] **步骤 1：编写失败测试**

在 `desktop-api.test.ts` 的 `describe("desktop window preload bridge", ...)` 内追加：

```ts
it("exposes the argv material snapshot and routes the material command", async () => {
  // vitest 进程的 argv 不含主进程注入的四个前缀参数，因此快照必须是 null（宠物窗口走同一条路径）。
  expect(desktopAPI.window.material).toBeNull()

  await desktopAPI.window.setMaterial("opaque")

  expect(electron.invoke).toHaveBeenCalledWith(IpcChannels.windowSetMaterial, "opaque")
})
```

> `desktopAPI.window.material` 是 preload 里从 `process.argv` 解析出的**同步值**，不依赖 IPC；
> 测试进程没有这四个 argv 参数，断言 `null` 就是在验证 D5 的约定：无参数入口不伪造材质状态。
>
> **第 2 版修正：** 第 1 版有 `window:get-material` 通道与 `getMaterial()`，但整个计划没有任何地方消费它——renderer 的状态来自 argv 快照 + `setMaterial` 的返回值，属于死接口（D10 自己的 YAGNI 原则），已删除。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/desktop exec vitest run src/preload/desktop-api.test.ts`
预期：FAIL。`desktopAPI.window.material` 此刻是 `undefined`，第一条断言报 `expected undefined to be null`。

- [ ] **步骤 3：编写实现代码**

`ipc-channels.ts` 顶部 import 里补：

```ts
import type {
  DesktopWindowMaterialPreference,
  DesktopWindowMaterialState,
} from "./window-material-types"
```

`IpcChannels` 对象 `windowOpenExternal` 之后补：

```ts
  windowOpenExternal: "window:open-external",
  windowSetMaterial: "window:set-material",
```

`IpcInvokeMap` 里 `windowSetZoomLevel` 之后补：

```ts
  [IpcChannels.windowSetMaterial]: {
    args: [preference: DesktopWindowMaterialPreference]
    result: DesktopWindowMaterialState
  }
```

`desktop-api-contract.ts` 顶部 import 补 `DesktopWindowMaterialPreference` / `DesktopWindowMaterialState`（来自 `./window-material-types`），并把 `window` 命名空间改成：

```ts
  window: {
    /** 主窗口建窗时由主进程通过 additionalArguments 注入的同步快照；宠物窗口等无参数入口为 null。 */
    material: DesktopWindowMaterialState | null
    showMain: () => Promise<void>
    minimize: () => Promise<void>
    close: () => Promise<void>
    toggleMaximize: () => Promise<void>
    isMaximized: () => Promise<boolean>
    getZoomLevel: () => Promise<number>
    setZoomLevel: (level: number) => Promise<number>
    openExternal: (url: string) => Promise<void>
    /** 切换窗口材质；返回主进程算出的权威状态（偏好 / 生效 / 降级原因 / 外壳模式）。 */
    setMaterial: (preference: DesktopWindowMaterialPreference) => Promise<DesktopWindowMaterialState>
    onMaximizedChanged: (listener: (value: boolean) => void) => () => void
  }
```

`desktop-api.ts` 顶部 import 补：

```ts
import {
  parseWindowMaterialArguments,
  type DesktopWindowMaterialPreference,
} from "../shared/window-material-types"
```

`desktopAPI.window` 里（`openExternal` 之后）补：

```ts
    // 建窗时主进程把材质结论塞进 additionalArguments，这里同步读出来。
    // 走 argv 而不是 IPC：renderer 首帧就要知道玻璃是否生效，异步 IPC 会先出一帧错误底色。
    // 没有参数（宠物窗口等）就是 null——不要在这里伪造 fallback 状态（D5）。
    material: parseWindowMaterialArguments(process.argv),
    setMaterial: (preference: DesktopWindowMaterialPreference) =>
      invoke(IpcChannels.windowSetMaterial, preference),
```

`window-controls/ipc.ts` import 补：

```ts
import { isDesktopWindowMaterialPreference } from "../../../shared/window-material-types"
import { setMainWindowMaterial, showMainWindow } from "../main-window/window"
```

（原 `showMainWindow` 的 import 合并到这里。）`windowOpenExternal` 之后补：

```ts
      {
        channel: IpcChannels.windowSetMaterial,
        handler: (event, preference) => {
          if (!isDesktopWindowMaterialPreference(preference)) {
            throw new Error("未知的窗口材质设置。")
          }
          const win = getEventWindow(event.sender)
          if (!win) throw new Error("窗口不存在，无法切换窗口材质。")
          return setMainWindowMaterial(win, preference)
        },
      },
```

> `getEventWindow()` 是 `window-controls/ipc.ts:88` 已有的内部函数（`BrowserWindow.fromWebContents`，返回 `BrowserWindow | null`），不需要新写。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/desktop exec vitest run src/preload/desktop-api.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/shared/desktop-api-contract.ts \
        apps/desktop/src/preload/desktop-api.ts apps/desktop/src/preload/desktop-api.test.ts \
        apps/desktop/src/main/features/window-controls/ipc.ts
git commit -m "feat(desktop): 暴露窗口材质快照与切换的窄 IPC"
```

---

### 任务 6：renderer 材质接线（抢先属性 + CSS token + 偏好）

**文件：**
- 修改：`apps/desktop/src/renderer/src/apply-startup-theme.ts`
- 修改：`apps/desktop/src/renderer/src/apply-startup-theme.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/appearance/appearance-provider.tsx`
- 修改：`apps/desktop/src/renderer/src/components/appearance/appearance-provider.test.ts`
- 修改：`apps/desktop/src/renderer/src/assets/main.css`
- 创建：`apps/desktop/src/renderer/src/components/appearance/window-material-copy.ts`
- 创建：`apps/desktop/src/renderer/src/components/appearance/window-material-copy.test.ts`

> **第 2 版：** 不再改 `appearance-preferences.ts` / `appearance-preferences.test.ts`（D3 重写：材质偏好由主进程持久化）。

- [ ] **步骤 1：编写失败测试（apply-startup-theme）**

```ts
// apps/desktop/src/renderer/src/apply-startup-theme.test.ts（在现有 describe 上追加）
import { applyWindowMaterialToRoot, writeWindowMaterialAttributes } from "./apply-startup-theme"

function setSnapshot(snapshot: unknown): void {
  ;(window as unknown as { desktop?: unknown }).desktop = { window: { material: snapshot } }
}

describe("applyWindowMaterialToRoot", () => {

  it("macOS 玻璃写 glass/translucent", () => {
    setSnapshot({
      preference: "glass",
      active: "glass",
      unavailableReason: null,
      shell: "translucent",
    })
    const root = document.createElement("html")

    applyWindowMaterialToRoot(root)

    expect(root.dataset.windowMaterial).toBe("glass")
    expect(root.dataset.windowShell).toBe("translucent")
  })

  it("Windows / Linux 玻璃写 glass/transparent", () => {
    setSnapshot({
      preference: "glass",
      active: "glass",
      unavailableReason: null,
      shell: "transparent",
    })
    const root = document.createElement("html")

    applyWindowMaterialToRoot(root)

    expect(root.dataset.windowMaterial).toBe("glass")
    expect(root.dataset.windowShell).toBe("transparent")
  })

  it("不透明档写 opaque/solid", () => {
    setSnapshot({
      preference: "opaque",
      active: "opaque",
      unavailableReason: null,
      shell: "solid",
    })
    const root = document.createElement("html")

    applyWindowMaterialToRoot(root)

    expect(root.dataset.windowMaterial).toBe("opaque")
    expect(root.dataset.windowShell).toBe("solid")
  })

  it("快照缺失（宠物窗口）时不写任何属性", () => {
    setSnapshot(null)
    const root = document.createElement("html")

    applyWindowMaterialToRoot(root)

    expect(root.dataset.windowMaterial).toBeUndefined()
    expect(root.dataset.windowShell).toBeUndefined()
  })
})

describe("writeWindowMaterialAttributes", () => {
  it("不读快照，直接写给定状态（Provider 运行期切换用）", () => {
    setSnapshot(null)
    const root = document.createElement("html")

    writeWindowMaterialAttributes(root, {
      preference: "opaque",
      active: "opaque",
      unavailableReason: null,
      shell: "solid",
    })

    expect(root.dataset.windowMaterial).toBe("opaque")
    expect(root.dataset.windowShell).toBe("solid")
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/desktop exec vitest run src/renderer/src/apply-startup-theme.test.ts`
预期：FAIL，`applyWindowMaterialToRoot is not a function`。

- [ ] **步骤 3：编写实现代码（apply-startup-theme）**

```ts
// apps/desktop/src/renderer/src/apply-startup-theme.ts
import {
  APPEARANCE_STORAGE_KEY,
  parseAppearancePreferences,
} from "./components/appearance/appearance-preferences"
import {
  isGlassWindowMaterial,
  type DesktopWindowMaterialState,
} from "@shared/window-material-types"

export function applyStartupTheme(root: HTMLElement = document.documentElement): void {
  try {
    const preferences = parseAppearancePreferences(localStorage.getItem(APPEARANCE_STORAGE_KEY))
    const prefersDark =
      typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
    const resolved =
      preferences.theme === "system" ? (prefersDark ? "dark" : "light") : preferences.theme
    root.classList.remove("light", "dark")
    root.classList.add(resolved)
  } catch {
    // Keep the CSS prefers-color-scheme fallback if storage or parsing fails.
  }

  applyWindowMaterialToRoot(root)
}

/** 读 preload 注入的同步快照；宠物窗口等没有注入时返回 null。 */
export function readWindowMaterialSnapshot(): DesktopWindowMaterialState | null {
  if (typeof window === "undefined") return null
  return window.desktop?.window?.material ?? null
}

/** 写给定状态。Provider 运行期切换也用它——argv 快照不会更新，不能靠重读快照。 */
export function writeWindowMaterialAttributes(
  root: HTMLElement,
  state: DesktopWindowMaterialState
): void {
  root.dataset.windowMaterial = isGlassWindowMaterial(state) ? "glass" : "opaque"
  root.dataset.windowShell = state.shell
}

/** 启动时按快照写属性；没有快照（宠物窗口）就清掉可能残留的属性。 */
export function applyWindowMaterialToRoot(root: HTMLElement = document.documentElement): void {
  const snapshot = readWindowMaterialSnapshot()
  if (!snapshot) {
    delete root.dataset.windowMaterial
    delete root.dataset.windowShell
    return
  }

  writeWindowMaterialAttributes(root, snapshot)
}
```

> 说明：`@shared` 是 vitest / electron-vite 的 alias（`vitest.config.ts:8-11`、`tsconfig.web.json:14-24`、`electron.vite.config.ts:72-78`）。
> `window.desktop` 已有全局类型声明（`src/preload/index.d.ts:5-9`），所以 `readWindowMaterialSnapshot()` 直接用可选链读，**不要**再写 `(window as unknown as {...})` 强转——仓库里已有 `window.desktop?.updates` 这样的先例。

- [ ] **步骤 4：编写实现代码（appearance-provider）**

`appearance-provider.tsx`：

1. import：从 `@shared/window-material-types` 取 `DEFAULT_WINDOW_MATERIAL_PREFERENCE` 与 `type DesktopWindowMaterialPreference` / `type DesktopWindowMaterialState`（只 import 实际用到的，`tsconfig.web.json` 开着 `noUnusedLocals`）；从 `@renderer/apply-startup-theme` 取 `readWindowMaterialSnapshot` / `writeWindowMaterialAttributes`。
2. `AppearanceContextValue` 增加字段：

```ts
export type AppearanceContextValue = {
  preferences: AppearancePreferences
  resolvedTheme: "light" | "dark"
  resolvedReducedMotion: boolean
  /** 主窗口才有值；宠物窗口等其它入口为 null。 */
  windowMaterial: DesktopWindowMaterialState | null
  fontAvailability: Readonly<Record<string, boolean>>
  saveState: { status: "idle" | "saved" | "error"; message?: string }
  setPreference: <K extends keyof Omit<AppearancePreferences, "version">>(
    key: K,
    value: AppearancePreferences[K]
  ) => boolean
  setWindowMaterial: (preference: DesktopWindowMaterialPreference) => void
  resetAppearance: () => boolean
}
```

3. Provider 内部：

```tsx
const [windowMaterial, setWindowMaterialState] = useState<DesktopWindowMaterialState | null>(
  readWindowMaterialSnapshot
)
const windowMaterialRef = useRef(windowMaterial)

const setWindowMaterial = useCallback(
  (preference: DesktopWindowMaterialPreference): void => {
    const previous = windowMaterialRef.current
    // 乐观更新：开关立刻反映选择，原生材质等主进程返回权威状态后再变。
    // 不伪造 active / shell——沿用上一份状态，只改 preference。
    const optimistic = previous ? { ...previous, preference } : null
    windowMaterialRef.current = optimistic
    setWindowMaterialState(optimistic)

    window.desktop.window
      .setMaterial(preference)
      .then((state) => {
        windowMaterialRef.current = state
        setWindowMaterialState(state)
      })
      .catch(() => {
        windowMaterialRef.current = previous
        setWindowMaterialState(previous)
        setSaveState({ status: "error", message: "无法切换窗口材质" })
      })
  },
  []
)
```

> 第 1 版在这里还有一段「临时把 `active` 设成 `opaque`」的乐观更新与 `windowMaterialRef` 使用，但 `windowMaterialRef` 从未声明、`active: "opaque"` 也不是必要行为。第 2 版只改 `preference`，DOM 写入交给下面的 `useLayoutEffect`，逻辑更短且没有自相矛盾。

`resetAppearance` 里追加材质复位（best-effort：`setWindowMaterial` 失败时会回滚状态并置错误提示，主进程偏好保持不变）：

```ts
const resetAppearance = useCallback(() => {
  const saved = persistPreferences(parseAppearancePreferences(null))
  if (saved) setWindowMaterial(DEFAULT_WINDOW_MATERIAL_PREFERENCE)
  return saved
}, [persistPreferences, setWindowMaterial])
```

`useLayoutEffect` 里补属性写入（Provider 挂载与状态变化时与 DOM 同步；`setWindowMaterial` 只改 state）：

```tsx
useLayoutEffect(() => {
  applyAppearanceToRoot(document.documentElement, preferences, resolvedTheme, resolvedReducedMotion)
  if (windowMaterial) writeWindowMaterialAttributes(document.documentElement, windowMaterial)
}, [preferences, resolvedReducedMotion, resolvedTheme, windowMaterial])
```

4. 别忘了把两个新字段加进 `useMemo<AppearanceContextValue>` 的 value 与依赖数组（实际 `appearance-provider.tsx:211-230` 是 value 字面量）。漏掉的话 `typecheck:web` 会报缺属性，外观页运行期点开关会 `TypeError`：

```tsx
const value = useMemo<AppearanceContextValue>(
  () => ({
    preferences,
    resolvedTheme,
    resolvedReducedMotion,
    windowMaterial,
    fontAvailability,
    saveState,
    setPreference,
    setWindowMaterial,
    resetAppearance,
  }),
  [
    fontAvailability,
    preferences,
    resetAppearance,
    resolvedReducedMotion,
    resolvedTheme,
    saveState,
    setPreference,
    setWindowMaterial,
    windowMaterial,
  ]
)
```

- [ ] **步骤 5：补充 appearance-provider 测试**

在 `appearance-provider.test.ts` 追加两个用例：

- 挂载时把快照写进 `data-window-material` / `data-window-shell`（快照 `shell: "transparent"` → `data-window-shell="transparent"`）；
- `setWindowMaterial("opaque")` 时先乐观写 `data-window-material="opaque"`，`setMaterial` resolve 后写权威状态；reject 时回滚到旧属性并置 `saveState.status === "error"`。

测试用 `vi.fn()` 伪造 `window.desktop = { window: { material: {...}, setMaterial } } as unknown as DesktopAPI`（记得 `import type { DesktopAPI } from "@shared/desktop-api-contract"`），并在 `afterEach` 里 `delete (window as { desktop?: unknown }).desktop`，避免污染同文件其它用例（现有用例不依赖 `window.desktop`，但不清理会留下全局状态）。

- [ ] **步骤 6：编写实现代码（main.css + window-material-copy）**

`main.css` 的 `.dark { ... }` 块之后追加（注意放在 `@layer base` 之前）：

```css
/* 玻璃档的外壳模式由主进程决定（D7）：
   - transparent：Windows/Linux，把外壳完全让出来，Acrylic / 合成器模糊才透得出来；
   - translucent：macOS，vibrancy 之上再叠一层半透明染色。
   不透明档不匹配任何规则，保持上面 :root / .dark 的实色 token。 */
html[data-window-shell="transparent"] {
  --shell: transparent;
}

html[data-window-shell="translucent"] {
  --shell: color-mix(in oklab, oklch(0.969 0.008 236) 60%, transparent);
}

html.dark[data-window-shell="translucent"] {
  --shell: color-mix(in oklab, oklch(0.22 0.012 250) 64%, transparent);
}
```

> `--sidebar`、`--chrome` 都是 `var(--shell)`，会跟着一起变；`--conversation`、`--card`、`--code` 等内容 token 保持不透明，长文本/代码/表格的可读性不依赖壁纸。标题栏里那个 10px（`size-2.5`）的装饰角块（`title-bar.tsx:463`）也用 `bg-shell`，玻璃档下会一起变透明，属于可接受的观感变化。
>
> **第 2 版修正：** 第 1 版只给 macOS 写半透明、Windows/Linux 保持不透明——那会让 Windows 的 Acrylic 被 `bg-shell` 完全盖住（§0.3 结论、D7）。

`window-material-copy.ts`：

```ts
import type { DesktopWindowMaterialState } from "@shared/window-material-types"

export function windowMaterialDescription(state: DesktopWindowMaterialState | null): string {
  if (!state) return "窗口背景使用当前设备默认外观。"
  if (state.active === "glass") {
    return "窗口背景使用系统原生材质，桌面内容会被系统模糊后透进来。"
  }
  if (state.preference === "opaque") {
    return "窗口背景使用不透明底色，与系统窗口主题保持一致。"
  }
  if (state.unavailableReason === "reduced-transparency") {
    return "系统已开启「降低透明度」，窗口背景已回退为不透明。"
  }
  return "当前系统不提供原生窗口材质，窗口背景已回退为不透明。"
}
```

`window-material-copy.test.ts` 逐分支断言以上字符串（共 5 个分支）。

- [ ] **步骤 7：运行测试验证通过**

运行：`pnpm --filter @openharness/desktop exec vitest run src/renderer/src/apply-startup-theme.test.ts src/renderer/src/components/appearance/appearance-provider.test.ts src/renderer/src/components/appearance/window-material-copy.test.ts`
预期：全 PASS。（`appearance-preferences.test.ts` 第 2 版不修改，也应保持全绿。）

- [ ] **步骤 8：Commit**

```bash
git add apps/desktop/src/renderer/src/apply-startup-theme.ts apps/desktop/src/renderer/src/apply-startup-theme.test.ts \
        apps/desktop/src/renderer/src/assets/main.css \
        apps/desktop/src/renderer/src/components/appearance/appearance-provider.tsx \
        apps/desktop/src/renderer/src/components/appearance/appearance-provider.test.ts \
        apps/desktop/src/renderer/src/components/appearance/window-material-copy.ts \
        apps/desktop/src/renderer/src/components/appearance/window-material-copy.test.ts
git commit -m "feat(desktop): renderer 按材质快照切换外壳底色并接入偏好"
```

---

### 任务 7：外观页「窗口」开关

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/appearance/appearance-settings.tsx`
- 测试：`apps/desktop/src/renderer/src/components/appearance/appearance-settings.test.ts`

- [ ] **步骤 1：编写失败测试**

在 `appearance-settings.test.ts` 追加（三处 `mocks.useAppearance.mockReturnValue`——`appearance-settings.test.ts:32、122、152`——都要补 `windowMaterial` 与 `setWindowMaterial` 两个字段，并在 `beforeEach` 的 `vi.fn()` 变量里加 `setWindowMaterial: vi.fn()`，供新用例断言）：

```ts
it("commits the window material choice immediately", async () => {
  await renderSettings()

  const glass = container.querySelector<HTMLButtonElement>('[aria-label="透明磨玻璃窗口背景"]')
  const opaque = container.querySelector<HTMLButtonElement>('[aria-label="不透明窗口背景"]')
  expect(glass).not.toBeNull()
  expect(opaque).not.toBeNull()

  act(() => opaque?.click())
  expect(setWindowMaterial).toHaveBeenCalledWith("opaque")
})
```

> mock 的 `windowMaterial` 必须是**非 null** 且 `preference: "glass"`（开关初始选中玻璃），否则组件直接不渲染「窗口」区块，或 Base UI 的 ToggleGroup 在取消选中时回调空数组、`commitSingle` 不触发。

把「恢复默认」用例的文案断言更新为：

```ts
expect(document.body.textContent).toContain("主题、颜色、字体、字号、动效和窗口材质")
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/appearance/appearance-settings.test.ts`
预期：FAIL（找不到 `透明磨玻璃窗口背景` 控件）。

- [ ] **步骤 3：编写实现代码**

`appearance-settings.tsx`：

1. import 补 `windowMaterialDescription`（来自 `./window-material-copy`）与 `type DesktopWindowMaterialPreference`（来自 `@shared/window-material-types`）。**不要** import 用不到的 `DesktopWindowMaterialState`——`tsconfig.web.json` 的 `noUnusedLocals` 会报错。
2. 顶部常量：

```ts
const WINDOW_MATERIAL_OPTIONS: readonly { value: DesktopWindowMaterialPreference; label: string }[] = [
  { value: "glass", label: "透明磨玻璃" },
  { value: "opaque", label: "不透明" },
]
```

3. `AppearanceSettings` 解构里补 `windowMaterial, setWindowMaterial`。
4. 在「主题」区块之后插入「窗口」区块：

```tsx
      {windowMaterial ? (
        <AppearanceSection title="窗口">
          <FieldGroup>
            <Field orientation="responsive">
              <FieldContent>
                <FieldTitle id="window-material-label">窗口背景</FieldTitle>
                <FieldDescription>{windowMaterialDescription(windowMaterial)}</FieldDescription>
              </FieldContent>
              <ToggleGroup
                aria-labelledby="window-material-label"
                variant="outline"
                value={[windowMaterial.preference]}
                onValueChange={(values) =>
                  commitSingle(values as DesktopWindowMaterialPreference[], (value) =>
                    setWindowMaterial(value)
                  )
                }
              >
                {WINDOW_MATERIAL_OPTIONS.map(({ value, label }) => (
                  <ToggleGroupItem
                    key={value}
                    value={value}
                    aria-label={`${label}窗口背景`}
                  >
                    {label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
          </FieldGroup>
        </AppearanceSection>
      ) : null}
```

5. `ResetAppearanceDialog` 的文案里「主题、颜色、字体、字号和动效」改为「主题、颜色、字体、字号、动效和窗口材质」。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/appearance/appearance-settings.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/components/appearance/appearance-settings.tsx \
        apps/desktop/src/renderer/src/components/appearance/appearance-settings.test.ts
git commit -m "feat(desktop): 外观页新增窗口背景（透明/不透明）开关"
```

---

### 任务 8：启动遮罩去底色 + 卸载时机状态机

**文件：**
- 修改：`apps/desktop/src/renderer/index.html`
- 修改：`apps/desktop/src/renderer/src/startup-loading.test.ts`
- 创建：`apps/desktop/src/renderer/src/startup-overlay.ts`
- 创建：`apps/desktop/src/renderer/src/startup-overlay.test.ts`
- 修改：`apps/desktop/src/renderer/src/main.tsx`
- 修改：`apps/desktop/src/renderer/src/dismiss-startup-loading.ts`
- 不修改：`apps/desktop/src/renderer/src/dismiss-startup-loading.test.ts`（行为不变，见步骤 6）

- [ ] **步骤 1：修改 index.html**

`#startup-loading` 改为「遮罩透明 + 中心徽标自带底色 + 入场动画 + 拖拽区」：

```html
    <style>
      html, body, #root { width: 100%; height: 100%; margin: 0; }

      /* 遮罩层本身不设背景色：窗口从第一帧就是原生材质，只有中心徽标自己带底色，
         这样玻璃在第一帧就可见，且徽标在任意壁纸上都读得清。 */
      #startup-loading {
        position: fixed;
        inset: 0;
        z-index: 9999;
        display: grid;
        place-items: center;
        -webkit-app-region: drag;
        transition: opacity 0.16s ease;
      }

      #startup-loading[data-startup-dismissed="true"] { opacity: 0; }

      .startup-loading-content {
        display: grid;
        justify-items: center;
        gap: 0.75rem;
        padding: 1.5rem 1.75rem;
        border-radius: 1.5rem;
        background: linear-gradient(180deg, #000000 0%, #151718 100%);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
        color: #ffffff;
        -webkit-app-region: no-drag;
        animation: startup-badge-in 0.72s cubic-bezier(0.22, 1, 0.36, 1) both;
      }

      .startup-loading-wordmark { font-size: 0.9375rem; font-weight: 500; letter-spacing: 0.03em; }
      .startup-loading-dots { display: flex; gap: 0.3125rem; }
      .startup-loading-dot { width: 0.25rem; height: 0.25rem; border-radius: 999px; background: currentColor; animation: startup-dot 1.5s ease-in-out infinite; }
      .startup-loading-dot:nth-child(2) { animation-delay: 160ms; }
      .startup-loading-dot:nth-child(3) { animation-delay: 320ms; }

      @keyframes startup-badge-in {
        0% { transform: scale(0.72); opacity: 0.2; }
        60% { transform: scale(1.045); opacity: 1; }
        80% { transform: scale(0.985); }
        90% { transform: scale(1.008); }
        100% { transform: scale(1); opacity: 1; }
      }
      @keyframes startup-dot { 0%, 100% { opacity: 0.28; } 50% { opacity: 0.9; } }

      @media (prefers-reduced-motion: reduce) {
        .startup-loading-content { animation: none; }
        .startup-loading-dot { animation: none; opacity: 0.55; }
      }
    </style>
```

并把 `<body>` 里的徽标文案改成同一个内容（保留 `data-startup-dot`，`aria-label` 保持不变）：

```html
    <div id="startup-loading" role="status" aria-label="正在启动 OpenHarness">
      <div class="startup-loading-content" data-startup-badge="true" aria-hidden="true">
        <span class="startup-loading-wordmark">OpenHarness-ts</span>
        <span class="startup-loading-dots">
          <span class="startup-loading-dot" data-startup-dot="true"></span>
          <span class="startup-loading-dot" data-startup-dot="true"></span>
          <span class="startup-loading-dot" data-startup-dot="true"></span>
        </span>
      </div>
    </div>
```

> 规格书 §7 的「96×96 徽标 + 白色 SVG + 可见文案为零」需要仓库里有正式 logo 素材；本仓库只有 `icon.png`，没有 SVG。
> 为不擅自定品牌符号，这里保留现有 wordmark 文字，只落实 §7 的结构性要求（遮罩无底色、徽标自带底色、入场动画、
> 减少动效降级、可拖动）。React 第二段徽标接力因此不做（遮罩透明后没有白屏可接力），详见交付记录。

- [ ] **步骤 2：更新 startup-loading.test.ts**

原测试的「style 内容」用例（`startup-loading.test.ts:30-48`）**整段替换**为新版断言。注意原用例除 `#f4f7f9` / `#20242a` / `html.dark` / `html.light` 外，还断言了 `prefers-color-scheme: dark`——新 `index.html` 已删除该媒体查询，必须一起删掉，否则用例会挂：

```ts
it("遮罩层没有不透明底色，只有中心徽标自带底色", () => {
  const document = new JSDOM(html).window.document
  const styles = document.querySelector("style")?.textContent ?? ""

  expect(styles).toContain("#startup-loading")
  expect(styles).not.toMatch(/#startup-loading\s*\{[^}]*background\s*:\s*#/)
  expect(styles).toContain("linear-gradient(180deg, #000000 0%, #151718 100%)")
  expect(styles).toContain("animation: startup-badge-in")
  expect(styles).toContain("prefers-reduced-motion: reduce")
})
```

保留同一文件里的结构断言：「wordmark 在 #root 之外」「全屏遮罩（`position: fixed` / `inset: 0` / `z-index: 9999`）」「可访问 label（`role="status"` + `aria-label`）」「`[data-startup-dot="true"]` 三个点」以及 `./src/startup-theme.ts` 的 script 断言（步骤 1 没删该 script）。

- [ ] **步骤 3：编写 startup-overlay.ts**

```ts
// apps/desktop/src/renderer/src/startup-overlay.ts
export const STARTUP_OVERLAY_ELEMENT_ID = "startup-loading"
export const STARTUP_ROOT_ELEMENT_ID = "root"
/** 入场动画事件缺失（reduced-motion 把 animation 关掉）时的兜底。 */
export const STARTUP_OVERLAY_ANIMATION_FALLBACK_MS = 1000
/** React 始终不提交首帧（崩溃/白屏）时的兜底。 */
export const STARTUP_OVERLAY_REACT_READY_FALLBACK_MS = 3000
/** 淡出结束后再 remove（比 CSS 里 #startup-loading 的 0.16s 过渡宽裕）。 */
export const STARTUP_OVERLAY_REMOVE_DELAY_MS = 500

type Timer = ReturnType<typeof setTimeout>

export interface StartupOverlayClock {
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
}

const defaultClock: StartupOverlayClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
}

/**
 * 启动遮罩卸载状态机。卸载条件 = 入场动画结束 ∧ React 已提交首帧。
 *
 * - 入场动画结束：`[data-startup-badge]` 的 animationend；reduced-motion 下 CSS 把 animation 关掉，
 *   事件永远不会来，由 STARTUP_OVERLAY_ANIMATION_FALLBACK_MS 兜底。
 * - React 已提交首帧：#root 出现第一个子节点（MutationObserver）；调用时已有子节点就直接视为就绪；
 *   始终没有出现时由 STARTUP_OVERLAY_REACT_READY_FALLBACK_MS 兜底。
 * 两个信号都满足后写 `data-startup-dismissed="true"` 触发 0.16s 淡出，再等 REMOVE_DELAY 后真正 remove()。
 *
 * `dismissStartupLoading()`（数据就绪/失败路径）会直接 remove 节点，是快速通道；
 * 节点已被移除时本函数立即返回，不报错。
 * 返回值只在测试/中断场景使用，`main.tsx` 丢弃它；注意若在 dismiss 之后再调用 cleanup，
 * 会把已排队的移除定时器清掉、节点留在 DOM 里（当前没有调用方这么做）。
 */
export function watchStartupOverlay(
  doc: Document = document,
  clock: StartupOverlayClock = defaultClock
): () => void {
  const overlay = doc.getElementById(STARTUP_OVERLAY_ELEMENT_ID)
  if (!overlay) return () => {}

  const badge = overlay.querySelector("[data-startup-badge]")
  const reactRoot = doc.getElementById(STARTUP_ROOT_ELEMENT_ID)

  let animationSettled = false
  let reactSettled = reactRoot === null || reactRoot.childElementCount > 0
  let dismissed = false
  let observer: MutationObserver | null = null
  const timers = new Set<Timer>()

  const schedule = (handler: () => void, delay: number): void => {
    timers.add(clock.setTimeout(handler, delay))
  }

  const clearTimers = (): void => {
    for (const timer of timers) clock.clearTimeout(timer)
    timers.clear()
  }

  const dismiss = (): void => {
    if (dismissed || !animationSettled || !reactSettled) return
    dismissed = true
    clearTimers()
    overlay.dataset.startupDismissed = "true"
    // 注意：这行必须在 clearTimers() 之后，否则刚排的移除定时器会被自己清掉。
    schedule(() => overlay.remove(), STARTUP_OVERLAY_REMOVE_DELAY_MS)
  }

  const onAnimationEnd = (event: Event): void => {
    if (event.target !== badge) return
    animationSettled = true
    dismiss()
  }

  if (badge) badge.addEventListener("animationend", onAnimationEnd)

  if (!reactSettled && reactRoot) {
    observer = new MutationObserver(() => {
      if (reactRoot.childElementCount === 0) return
      reactSettled = true
      observer?.disconnect()
      dismiss()
    })
    observer.observe(reactRoot, { childList: true })
  }

  schedule(() => {
    animationSettled = true
    dismiss()
  }, STARTUP_OVERLAY_ANIMATION_FALLBACK_MS)

  schedule(() => {
    reactSettled = true
    observer?.disconnect()
    dismiss()
  }, STARTUP_OVERLAY_REACT_READY_FALLBACK_MS)

  return () => {
    observer?.disconnect()
    if (badge) badge.removeEventListener("animationend", onAnimationEnd)
    clearTimers()
  }
}
```

> **第 2 版重写：** 第 1 版里 `reactSettled = true` 在函数体里被立即置位，`STARTUP_OVERLAY_REACT_READY_FALLBACK_MS` 的 3000ms 定时器永远只是空跑——「React 就绪」这个条件名存实亡，测试也验证不了任何东西。第 2 版改用 `#root` 的首个子节点作为 React 已提交首帧的真实信号（React 19 的 `render()` 没有回调，MutationObserver 是可靠且可测的做法），兜底定时器因此变得有意义。

- [ ] **步骤 4：编写 startup-overlay.test.ts**

```ts
// @vitest-environment jsdom
// apps/desktop/src/renderer/src/startup-overlay.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  STARTUP_OVERLAY_ANIMATION_FALLBACK_MS,
  STARTUP_OVERLAY_REACT_READY_FALLBACK_MS,
  STARTUP_OVERLAY_REMOVE_DELAY_MS,
  watchStartupOverlay,
} from "./startup-overlay"

function mountDom(): void {
  document.body.innerHTML = `
    <div id="root"></div>
    <div id="startup-loading"><div data-startup-badge="true"></div></div>
  `
}

function getOverlay(): HTMLElement {
  return document.getElementById("startup-loading")!
}

function commitReact(): void {
  document.getElementById("root")!.appendChild(document.createElement("div"))
}

describe("watchStartupOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = ""
  })
  afterEach(() => vi.useRealTimers())

  it("动画结束且 React 提交首帧后才淡出，再延迟移除", async () => {
    mountDom()
    watchStartupOverlay()

    getOverlay().querySelector("[data-startup-badge]")!.dispatchEvent(new Event("animationend"))
    expect(getOverlay().dataset.startupDismissed).toBeUndefined()

    commitReact()
    await Promise.resolve() // 等 MutationObserver 的微任务回调

    expect(getOverlay().dataset.startupDismissed).toBe("true")
    vi.advanceTimersByTime(STARTUP_OVERLAY_REMOVE_DELAY_MS)
    expect(document.getElementById("startup-loading")).toBeNull()
  })

  it("React 先就绪、动画随后结束时同样会卸载", async () => {
    mountDom()
    watchStartupOverlay()

    commitReact()
    await Promise.resolve()
    expect(getOverlay().dataset.startupDismissed).toBeUndefined()

    getOverlay().querySelector("[data-startup-badge]")!.dispatchEvent(new Event("animationend"))
    expect(getOverlay().dataset.startupDismissed).toBe("true")
  })

  it("动画事件缺失（reduced-motion）时由 1000ms 兜底", async () => {
    mountDom()
    watchStartupOverlay()
    commitReact()
    await Promise.resolve()

    vi.advanceTimersByTime(STARTUP_OVERLAY_ANIMATION_FALLBACK_MS)
    expect(getOverlay().dataset.startupDismissed).toBe("true")
  })

  it("React 始终不提交时由 3000ms 兜底", () => {
    mountDom()
    watchStartupOverlay()
    getOverlay().querySelector("[data-startup-badge]")!.dispatchEvent(new Event("animationend"))

    vi.advanceTimersByTime(STARTUP_OVERLAY_REACT_READY_FALLBACK_MS)
    expect(getOverlay().dataset.startupDismissed).toBe("true")
  })

  it("两个信号都没来时不会提前卸载", () => {
    mountDom()
    watchStartupOverlay()

    vi.advanceTimersByTime(STARTUP_OVERLAY_REACT_READY_FALLBACK_MS - 1)
    expect(getOverlay().dataset.startupDismissed).toBeUndefined()
  })

  it("#root 在调用时已有子节点则视为已就绪", () => {
    mountDom()
    commitReact()
    watchStartupOverlay()

    getOverlay().querySelector("[data-startup-badge]")!.dispatchEvent(new Event("animationend"))
    expect(getOverlay().dataset.startupDismissed).toBe("true")
  })

  it("#startup-loading 已被 dismissStartupLoading 移除时安全返回", () => {
    document.body.innerHTML = '<div id="root"></div>'

    expect(() => watchStartupOverlay()).not.toThrow()
  })
})
```

> 第 1 版给的两个测试示例不能直接跑：`badge` 变量没有声明（ReferenceError），也没有 `vi.useFakeTimers()` / jsdom 环境声明；而且「React 就绪」当时是硬编码 true，测试验证不到串行关系。第 2 版把信号做成真实可观察的 DOM 变化后，这些用例才有意义。

- [ ] **步骤 5：main.tsx 接入 + dismiss 委托**

`main.tsx` 的 `createRoot(...).render(...)` 之后加一行：

```ts
import { watchStartupOverlay } from "./startup-overlay"
// ...render(...) 之后
watchStartupOverlay()
```

> 不需要给 `render()` 传「React 就绪」回调——状态机自己观察 `#root` 的子节点，`render()` 同步提交时也能正确判定（步骤 3 里已有「调用时已有子节点」分支）。

`dismiss-startup-loading.ts` 改为委托（保留原导出名，`bootstrap-actions.ts` 与 `routes/pet.tsx` 无需改）：

```ts
// apps/desktop/src/renderer/src/dismiss-startup-loading.ts
import { STARTUP_OVERLAY_ELEMENT_ID } from "./startup-overlay"

/** 应用数据就绪/失败时的「立即移除」路径；watchStartupOverlay 负责动画与 React 首帧的时机。 */
export function dismissStartupLoading(): void {
  if (typeof document === "undefined") return
  document.getElementById(STARTUP_OVERLAY_ELEMENT_ID)?.remove()
}
```

- [ ] **步骤 6：dismiss-startup-loading.test.ts 不修改**

`dismissStartupLoading()` 仍然同步 `remove()`（只把字符串换成常量 import），原测试断言的行为没变，**无需改动**。

> 为什么保留两条路径：`dismissStartupLoading()` 是**数据就绪/失败**的快速通道（`bootstrap-actions.ts:26/82/105` 调用），跳过淡出直接移除；`watchStartupOverlay()` 处理**动画结束 ∧ React 首帧**的另一条路径，数据一直不信号时用户不会永远看着启动徽标。如果哪天要把 dismiss 也改成带淡出的异步移除，必须同时改 `bootstrap-actions.startup-loading.test.ts`（4 个用例）与 `routes/pet.test.ts`（1 个用例）——本计划明确不做这件事。第 1 版文件结构表写的「改为异步断言（淡出 + 移除）」是错的，已更正。

- [ ] **步骤 7：运行测试验证通过**

运行：`pnpm --filter @openharness/desktop exec vitest run src/renderer/src/startup-loading.test.ts src/renderer/src/startup-overlay.test.ts src/renderer/src/dismiss-startup-loading.test.ts`
预期：全 PASS。

- [ ] **步骤 8：Commit**

```bash
git add apps/desktop/src/renderer/index.html apps/desktop/src/renderer/src/startup-loading.test.ts \
        apps/desktop/src/renderer/src/startup-overlay.ts apps/desktop/src/renderer/src/startup-overlay.test.ts \
        apps/desktop/src/renderer/src/main.tsx apps/desktop/src/renderer/src/dismiss-startup-loading.ts
git commit -m "feat(desktop): 启动遮罩去掉不透明底色并接入卸载时机状态机"
```

---

## 任务 9：全量验证与交付

- [ ] **步骤 1：跑 desktop 全量单测**

运行：`pnpm --filter @openharness/desktop exec vitest run`
预期：全 PASS（含既有用例）。

- [ ] **步骤 2：类型检查**

运行：`pnpm --filter @openharness/desktop typecheck`
预期：`typecheck:node` 与 `typecheck:web` 均通过。第 2 版特别注意两点：`tsconfig.web.json` 的 `noUnusedLocals` 是开着的（renderer 里不要留未使用的 import）；node 侧是 `strict`（`window-material.ts` 的类型导入必须齐全，第 1 版就漏了 `DesktopWindowMaterialUnavailableReason`）。

- [ ] **步骤 3：构建**

运行：`pnpm --filter @openharness/desktop build`
预期：`verify-workspace-boundaries.mjs` + `typecheck` + `electron-vite build` 全通过。

- [ ] **步骤 4：Windows 实机冒烟（先于完整验收，结果决定 Windows 分支要不要关掉）**

1. 启动 `pnpm --filter @openharness/desktop dev`，把窗口拖到彩色壁纸上，确认标题栏 / 侧边栏区域能看到被模糊的壁纸（Acrylic 生效），并且没有出现「整窗全黑 / 全白」。
2. 若材质不可见：先在 DevTools 里确认 `document.documentElement.dataset.windowShell === "transparent"`（renderer 侧正确），然后按 D2 处置——把 `supportsNativeWindowMaterial()` 里的 `win32` 移除，让 Windows 玻璃降级为 `unsupported-platform`；重跑 `pnpm --filter @openharness/desktop exec vitest run src/main/features/main-window`，把「关闭 Windows 玻璃」写进交付记录。**不要**改用 `transparent: true`（Electron 39 的 resizable 回归）。
3. 无论材质是否可见，都要回归窗口基础行为：拖拽边缘缩放、双击标题栏最大化/还原、Win+方向键 Snap、PowerToys FancyZones（若安装）。这些是 Windows 玻璃的连带风险面（D2）。

- [ ] **步骤 5：手工验收（Windows 实机，逐条记录证据）**

按规格书 §9 的 12 条验收标准，重点在 Windows 实机验证 1/2/4/6/7/10/11/12；macOS/Linux 项明确标注「未验证」。Windows 上必须额外记录：

- 玻璃可见性结论（可见 / 不可见 + 处置）；
- 切换「透明磨玻璃 ↔ 不透明」：开关立即响应（乐观更新）、外壳 token 随之变化、窗口没有重建（`webContents` 未 reload）、没有肉眼可见的一帧错误底色；
- `show` / `resized` 重绘补偿：从托盘 hide → show、拉伸窗口后没有合成层死区（验收 12 的实现条目）；
- 启动一致性：冷启动时玻璃在第一帧就可见（不是先铺一层实色再切玻璃），徽标在动画结束后淡出，数据就绪路径（`dismissStartupLoading`）不冲突；
- 重启后偏好保持：切到「不透明」→ 退出 → 重开，窗口仍是不透明底色且开关仍在「不透明」。

- [ ] **步骤 6：写交付记录**

把改动文件清单、关键函数签名、材质决策记录、验证证据、遗留风险按规格书 §11 整理成一段报告（可直接放进本计划的 `docs/superpowers/reviews/` 或对话输出）。必须写进记录的三条：
1. Windows 材质是否可见、以及是否因此关闭了 Windows 玻璃；
2. 第 1 版计划的哪些结论被第 2 版推翻（transparent 的前提下半句「`transparent: true` 会丢圆角」未证实、D3 的 localStorage 真相源不成立、D7 的「Windows 保持不透明」会让材质不可见、`window:get-material` 是死接口）；
3. 遗留项：macOS `hiddenInset → hidden` + `setWindowButtonPosition` 随缩放重算（本机不可验证）、Linux 透明窗口的可缩放/无合成器风险、`prefersReducedTransparency` 运行中变化不更新。

---

## 自检结果

**1. 规格覆盖度：** §1 侦察（本计划 §0）、§2 分层模型（§0.3 + 任务 6）、§3 材质配置（任务 2/4）、§4 renderer 配合（任务 6，第 2 版改成三档 shell）、§5 稳定性补偿（任务 3）、§6 主题与降级（D4/D9/D6/D7 + 任务 2/6）、§7 启动一致性（任务 8）、§8 硬约束（无新依赖/不动业务逻辑/带注释）、§9 验收（任务 9）、§11 交付（任务 9 步骤 6）。覆盖无遗漏。

**2. 占位符扫描：** 无「TODO / 待定 / 后续实现 / 类似任务 N」。每个任务的步骤都含可执行的测试或实现代码。D2 里有一处**故意保留的实机裁决点**（Windows Acrylic 可见性），它带明确的操作步骤与降级方案，不是占位符。

**3. 类型一致性：** `DesktopWindowMaterialState` 四个字段（`preference` / `active` / `unavailableReason` / `shell`）在任务 1 定义、任务 2 的 `resolveWindowMaterialState` 产出、任务 4 的 `currentMainWindowMaterialState` 透传、任务 5 的 IPC 返回与 preload 快照、任务 6 的 Provider 与 apply-startup-theme 消费，全程一致；偏好类型（`DesktopWindowMaterialPreference`，shared）就是任务 7 开关取值与任务 5/6 `setMaterial` 入参的类型，不再有第 1 版那个 renderer 同名的 `WindowMaterialId`，不存在漂移。

**4. 修订覆盖度：** 4 个核查子代理提出的高优先级问题全部落在第 2 版里：(1) 任务 1 往返用例缺字段与任务 2 漏 import（第 1 版必挂 `typecheck`）；(2) 任务 5 的死接口 `get-material` 与 preload fallback 矛盾；(3) 任务 6 的 localStorage 死字段与 `windowMaterialRef` 未声明；(4) 任务 8 状态机空转与不可运行的测试片段；(5) D7 的 Windows 材质被不透明壳层盖住的结构性缺陷；(6) 各处引用不实的 `electron.d.ts` 论述与 `setTrafficLightPosition` 结论。中低优先级的事实性错误（行号、用例计数、`ready-to-show` 首次显示、`reset` 用例测不出缓存）也一并修正。

---

## 修订记录（2026-09-22，第 2 版）

审核方式：4 个子代理并行核查（主进程窗口链路 / renderer 外观与启动链路 / shared + preload + IPC / Electron 39 API 与社区回归），逐条对照 `file:line` 与 `electron.d.ts` 原文；本版按核查结果修订。主要改动：

| 类别 | 第 1 版的错误 | 第 2 版的修订 |
| --- | --- | --- |
| 必挂编译 | 任务 1 往返用例缺 `translucentShell` 字段；任务 2 实现漏 import `DesktopWindowMaterialUnavailableReason` | 补齐字段与类型导入；`shell` 改三值枚举 |
| 结构性缺陷 | D7 让 Windows/Linux 的 `--shell` 保持不透明，`bg-shell` 会把 Acrylic 整块盖住 | 新增 `shell: "transparent"` 档；CSS 用 `html[data-window-shell]` 三条规则 |
| 自相矛盾 | D3 说真相源在 `localStorage`，但任务 5 的 fallback 让宠物窗口永不返回 null、任务 6 的 `setWindowMaterial` 又从不写 localStorage，且 `windowMaterialRef` 从未声明 | D3 重写为「主进程 `desktop-window-material.json` 单一持久化」；删掉 `AppearancePreferences` 改动与 preload fallback；契约改 `material: ... \| null` |
| 死接口 | `window:get-material` / `getMaterial()` 无人消费 | 删除，只留 `window:set-material` |
| 事实错误 | 「Electron 39 没有 `setTrafficLightPosition`，运行期重算无法实现」 | 更正为 `setWindowButtonPosition` 存在；不修改 `window-chrome.ts` 的理由改为「不可验证」 |
| 引用不实 | 「`electron.d.ts` 明确 backgroundMaterial 与不透明 backgroundColor 互斥」「macOS transparent 丢圆角」「`visualEffectState` 默认值让玻璃关掉」 | 删掉无出处的引文，改用官方教程/issue 原文；D2 补 Acrylic 可见性风险与两条 Windows 回归（#48554、#90237） |
| 空转实现 | 任务 8 的 `reactSettled = true` 立即置位，3000ms 兜底是死代码；测试片段引用未声明变量 | 改为 MutationObserver 观察 `#root` 首个子节点；补 7 个可运行用例 |
| 测试测不出行为 | 偏好存储的 `reset` 用例在「reset 是空函数」时也会通过 | 去掉缓存语义与 `reset`；改为「写入后新实例能读回 + 损坏/非法回退」 |
| 表述与计数 | 「首次显示由 ready-to-show 触发」「9 个用例」「两个参数」「dismiss 测试改为异步断言」 | 分别更正为 `main/index.ts:82` 立即 show、12 个用例、四个参数、dismiss 测试不修改 |
| 其他 | `--conversation` 证据行号指向别名；`backgroundThrottling` 是所有窗口默认值 | 更正行号与措辞 |



