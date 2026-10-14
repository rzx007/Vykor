# Codex Windows 半透明侧边栏实现

2026-10-14。分析版本：Windows 包 `26.1007.9446.0`，包内应用版本 `26.1007.71326`，Electron 依赖 `42.3.0`。

核心实现是 **Windows Mica 窗口背景材质 + 网页透明底层 + 侧栏半透明染色 + 主内容实色覆盖**。设置改变窗口背景材质，同时由宿主通知前端实际是否采用不透明背景。

## 窗口层怎样启用 Mica

安装包主进程中的 `L9` 函数根据平台、窗口类型和是否要求不透明，选择窗口参数。常规 Windows 主窗口开启效果时返回：

```js
{
  backgroundColor: "#00000000",
  backgroundMaterial: "mica"
}
```

这些值既用于 `new BrowserWindow(...)`，也用于运行中的窗口刷新：

```js
window.setBackgroundColor(backgroundColor);
if (backgroundMaterial != null) {
  window.setBackgroundMaterial(backgroundMaterial);
}
```

关闭效果时，Windows 分支返回 `backgroundMaterial: "none"`，背景为深色 `#000000` 或浅色 `#f9f9f9`。常规主窗口没有使用 `transparent: true`；该属性出现在其他浮层窗口的配置中。这里透明的是网页绘制背景，底下仍有系统绘制的 Mica 材质。（主进程证据 W02～W04、W07）

Electron 将 `backgroundMaterial` 定义为系统绘制的窗口背景，包括非客户区；`setBackgroundMaterial()` 文档要求 Windows 11 22H2 或更新版本。[Electron 文档](https://www.electronjs.org/docs/latest/api/base-window#winsetbackgroundmaterialmaterial-windows)

**Mica 会融合桌面壁纸和系统主题颜色。** 微软将它定义为不透明的动态材质，因此它不会实时透出窗口后面的其他应用内容。侧栏的透明色层透出的是这层系统材质。[微软 Mica 说明](https://learn.microsoft.com/en-us/windows/apps/design/style/mica)

## 设置如何传到窗口

设置开关实际使用反向字段：

```js
checked: !theme.opaqueWindows
onChange: enabled => patchTheme({ opaqueWindows: !enabled })
```

浅色与深色分别保存到 `appearanceLightChromeTheme`、`appearanceDarkChromeTheme`。包内 Electron 基础主题两者都默认 `opaqueWindows: false`；用户配置和预置主题可以覆盖。前端合并主题修改，再写宿主设置，不只是改变 React 临时状态。（前端证据 ui-toggle、config-keys、electron-default、config-write）

主进程设置回调遇到上述主题键或 `appearanceTheme` 改变，会调用 `refreshWindowBackdrops()`，重新计算所有已注册窗口的背景。系统深浅色主题变化也触发同类刷新。当前生效的主题决定使用哪个 `opaqueWindows` 值。（W03、W05、W06）

更新窗口后，宿主向前端发出：

```js
{
  type: "electron-window-opaque-surface-changed",
  opaqueWindowSurfaceEnabled: trueOrFalse
}
```

前端监听实际结果，在 Electron 根元素上添加或移除 `electron-opaque`。该 class 会为根和 body 填入实色背景，并采用不透明的浮层颜色。这样在系统能力不足、宿主已经退化时，前端也有正确底色。（W03、native-state-event、native-state-class、opaque-class-css）

## 为什么只有侧边栏呈现材质

Mica 作用于窗口整体，网页通过不同背景层决定哪些位置露出它：

```text
Windows 绘制的 Mica 窗口底层
  └─ 透明网页根元素和 body
       ├─ 左侧栏：透明背景与半透明主题染色
       └─ 主内容：实色 surface 背景，覆盖下方材质
```

安装包 CSS 中，常规 Electron 根和 body 使用透明背景，侧栏 rail 明确使用 `electron:bg-transparent`。左栏或包裹它的 frame 使用以下染色方式：

```css
background: color-mix(
  in srgb,
  var(--color-surface-tertiary) 70%,
  transparent
);
```

page surface 的另一组规则为浅色 85%、深色 80%；左栏已经被 frame/page 包裹时自身再次设为透明，避免重复叠加。上述规则排除了 `data-codex-window-chrome=application-menu`，不能机械套用到所有窗口布局。（transparent-html、transparent-body、sidebar-alpha、rail-transparent）

默认主内容区域则使用 `background-color: var(--color-surface)`；Windows 专属样式给它左上圆角。这让对话区域保持清楚、稳定，同时侧边栏保留材质效果。（opaque-main-content、win-main-content-radius）

包中确实有 `backdrop-filter: blur(16px)`，但读到的这一规则属于 popover 局部效果，不能用来解释 Windows 主侧栏的系统背景。（popover-css-local-blur）

## 哪些情况会退化

Codex 的支持检测函数先检查 Windows `app.getGPUFeatureStatus().gpu_compositing === "enabled"`，再调用 `BrowserWindow.isSystemBackdropSupported()`。不支持时，常规窗口强制采用不透明表面。设置界面仅在能力返回明确 false 时隐藏开关，能力尚未返回时仍可能显示。（W01、W03、ui-capability）

主进程还有窗口失焦和大尺寸时的不透明策略，但这两条代码仅适用于 macOS。Windows 失焦时材质外观是否变化由系统材质处理，不能将 macOS 分支归到 Windows。（W04）

Windows 自身还可能因关闭系统透明效果、节电、高对比度等条件使用纯色回退，即使应用已经请求 Mica。因此“已经调用 mica”不保证当前屏幕一定呈现同样的视觉效果。[微软的回退条件](https://learn.microsoft.com/en-us/windows/apps/design/style/mica)

## 我们的 Electron 界面如何复用

以下是便于理解的等价示意，变量和类名经过简化，并非从 Codex 拷出的完整实现：

```js
function applySidebarMaterial(win, enabled) {
  const supported = process.platform === "win32"
    && app.getGPUFeatureStatus().gpu_compositing === "enabled"
    && BrowserWindow.isSystemBackdropSupported();
  const useMica = enabled && supported;

  win.setBackgroundColor(useMica
    ? "#00000000"
    : nativeTheme.shouldUseDarkColors ? "#000000" : "#f9f9f9");
  if (process.platform === "win32") {
    win.setBackgroundMaterial(useMica ? "mica" : "none");
  }
  // 通过现有可信 IPC 将实际 useMica 状态通知前端。
}
```

前端让根、body、侧栏祖先保留透明底；侧栏用主题色与 transparent 混合，主体用实色覆盖。关闭效果时补齐不透明根背景。主题变化和设置变化都重新应用窗口参数，主进程负责能力判断。

接入前需核对本项目 Electron 版本是否支持上面的能力检测 API，并保持已有窗口安全配置和 IPC 校验。仅给 sidebar 加 CSS 模糊无法获得桌面 Mica；只设置窗口 Mica，但让 body 或侧栏祖先铺满实色，也看不到它。

## 证据与核实范围

主进程源文件为 `.vite/build/main-Bgi5Xaw-.js`。设置和前端主题主要位于 `general-settings-7cb780277784.js`、`app-initial-102e45562729.js`、`app-shared-30671c57ec82.js` 及配套 CSS。

摘录、文件摘要和字节偏移分别保存在 [主进程证据](./research/codex-translucent-sidebar/main-evidence.json) 与 [前端证据](./research/codex-translucent-sidebar/renderer-evidence.json)。8 条主进程、19 条前端摘录已与安装包原字节核对。

REA 全包分析因一个解包 serialport 原生模块的声明摘要与实际文件不一致而停止；对主进程副本的分析在 45 秒超时后保留了部分证据，父 Evidence ID 为 `ev_30ff4a9ccedc39ab67838b89947d7692b0cbab398ae35e022560b75740078f67`。本结论主要依据随后直接核对的交付 JS/CSS 控制流。没有切换用户设置或观测运行时 DOM，当前机器的实际材质呈现仍由系统状态决定。
