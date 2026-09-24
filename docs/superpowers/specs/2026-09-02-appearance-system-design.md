# Vykor 桌面端外观系统设计

## 背景

桌面端设置导航已经包含“外观”入口，但页面目前仍是占位内容。渲染端已有 `ThemeProvider`，能够处理 `system`、`light`、`dark` 三种模式；`main.css` 也已经通过 shadcn/ui 语义变量定义浅色和深色主题。因此，本次工作不重新设计组件库，而是在现有基础上补齐一套正式、可扩展的外观配置系统。

当前主题保存在旧键 `vykor-desktop-theme`，应用入口把默认主题设置为浅色。本次功能明确采用不兼容升级：新外观系统不读取、不迁移、也不维护旧键；首次运行新版本时，无论用户过去使用什么主题，都按照新配置的默认值“跟随系统”启动。设备上即使残留旧键值，也只是不会再被访问的无效数据。

参考界面只用于确认功能组织方式。Vykor 保持现有设置页布局和 shadcn/ui `base-nova` 视觉语言，不逐像素复制其他产品。

## 目标

首版提供以下当前设备全局外观设置：

- 主题模式：跟随系统、浅色、深色；
- 强调色：经过验证的预设色板和自定义十六进制颜色；
- 界面字体：内置推荐字体和常见本机字体；
- 代码字体：内置推荐等宽字体和常见本机等宽字体；
- 界面字号；
- 代码字号；
- 减少动态效果：跟随系统、开启、关闭；
- 恢复默认外观。

所有有效修改立即作用于整个应用并自动保存在当前设备上。关闭和重新启动应用后继续使用上次配置。

## 非目标

首版不包含：

- 账户级或跨设备同步；
- 按项目保存外观；
- 主题导入、导出或复制；
- 半透明侧边栏或原生窗口材质；
- 背景色、前景色、焦点环等底层 token 的逐项编辑；
- 手动对比度调节；
- 光标样式；
- Diff 标记颜色编辑；
- 集成终端的字体和配色设置；
- 扫描并枚举操作系统中的全部字体；
- 读取或迁移旧主题键 `vykor-desktop-theme`；
- 保留旧 `ThemeProvider`、`useTheme()` 或裸 `D` 主题快捷键的兼容行为。

终端继续由独立的“终端”设置页管理，避免两个设置入口控制同一行为。

## 方案选择

采用“渲染端统一 `AppearanceProvider` + 版本化本地配置”。

没有采用主进程设置仓库和 IPC，是因为本次配置只影响渲染层。同步读取渲染端本地配置可以在第一次渲染前得到主题，避免先显示默认主题再跳变。没有采用每个选项独立保存，是因为单个版本化 JSON 更容易校验、字段级修复、恢复默认和保持原子性。

外观由 renderer 自己拥有；工作风格、通知等会改变应用运行行为的设置继续使用现有主进程设置接口。

## 架构与职责

### AppearanceProvider

现有 `ThemeProvider` 由 `AppearanceProvider` 直接取代，Provider 继续位于 React 应用根部。它是外观状态的唯一入口，负责：

1. 启动时同步读取当前设备保存的配置；
2. 解析配置版本，修复非法或缺失字段；
3. 暴露当前偏好、解析后的明暗主题、解析后的减少动效状态、更新单项和恢复默认方法；
4. 将主题 class、数据属性和 CSS 变量应用到文档根节点；
5. 监听系统明暗模式和系统减少动效偏好；
6. 监听 `storage` 事件，使同一应用的其他窗口同步变化；
7. 释放所有事件监听器。

设置页面只调用 Provider，不直接访问 `localStorage` 或操作 DOM。

现有调用方全部改用 `useAppearance()`，不提供 `useTheme()` 兼容适配层。侧边栏明暗按钮继续存在，但读取 `resolvedTheme`；点击后写入与当前解析主题相反的显式 `light` 或 `dark`，因此用户处于“跟随系统”时，点击该按钮会明确退出系统模式。现有未登记的裸 `D` 快捷键删除，不替换为隐藏的新组合键；以后如需键盘切换，应通过正式的快捷键设置系统提供。

代码块、文件查看器、侧边栏和审查工具都直接读取 `useAppearance().resolvedTheme`。审查工具现有的 DOM class `MutationObserver` 和本地主题状态一并删除，不能在统一 Provider 之外继续维护第二套主题判断。

### 纯逻辑模块

配置默认值、运行时校验、字段级修复、字体注册表、颜色规范化和颜色 token 推导放在独立的纯 TypeScript 模块中。该模块不依赖 React 或浏览器 DOM，可以直接进行单元测试。

### CSS 主题层

`main.css` 继续是视觉规则的唯一来源。业务组件只使用 `primary`、`ring`、`sidebar-primary`、`accent` 等语义变量，不根据主题写硬编码颜色。

Provider 将解析结果写入根节点：

- `light` 或 `dark` class 表示已解析的明暗主题；
- 字体、字号和颜色写入 CSS 自定义属性；
- 最终减少动效状态写入 `data-reduced-motion="true"` 或 `data-reduced-motion="false"`；
- 系统模式发生变化时重新解析主题和颜色派生值，但不修改用户保存的原始偏好。

代码高亮、Diff 和文件预览首期只接收代码字体与代码字号。它们的配色继续跟随应用明暗主题，不开放独立配色。

`AppearanceProvider` 同时在应用根部提供 `MotionConfig`，并根据最终布尔值传入 `reducedMotion="always"` 或 `reducedMotion="never"`，让 `motion/react` 动画服从同一份结果。现有直接调用 `useReducedMotion()` 的业务代码改为读取 `useAppearance().resolvedReducedMotion`，避免 JavaScript 动画绕过应用设置。

## 配置模型

配置保存在单个键 `vykor-desktop-appearance-v1` 下：

```ts
type AppearancePreferences = {
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
```

默认配置为：

```ts
const defaultAppearancePreferences: AppearancePreferences = {
  version: 1,
  theme: "system",
  accent: { kind: "preset", id: "neutral" },
  uiFont: "system",
  codeFont: "geist-mono",
  uiFontSize: 14,
  codeFontSize: 13,
  reducedMotion: "system",
};
```

界面字号合法范围为 12–18 px，代码字号合法范围为 11–18 px。自定义颜色只接受完整的 `#RRGGBB`，保存前统一规范为大写形式。

新键不存在时直接使用上述默认配置，不检查旧主题键。旧键不会被复制或删除，因为新版本不再读取它；这样既不增加迁移分支，也不会为了清理无效数据引入额外写操作。新配置不支持降级兼容。

## 字体注册表

字体选项来自固定注册表，每项包含稳定 ID、界面名称、来源和完整 CSS 回退链。首版分为两类：

- 随应用打包：Inter、Geist Mono；
- 本机候选：系统默认、Segoe UI Variable、Cascadia Code、Cascadia Mono、Consolas。

界面字体下拉框提供系统默认、Inter 和可用的 Segoe UI Variable。代码字体下拉框提供 Geist Mono，以及本机可用的 Cascadia Code、Cascadia Mono 和 Consolas。Inter 与 Geist Mono 通过 Fontsource 随桌面应用打包，不从网络加载。

系统不枚举本机全部字体。页面使用 `document.fonts.check()` 逐个检查注册表中的固定本机候选；不可用项仍显示名称和“本机未安装”，但处于禁用状态，不能形成“看起来已选择，实际使用了别的字体”的状态。字体可用性在 `document.fonts.ready` 后解析；如果已保存的本机字体后来被卸载，Provider 在结果返回前先使用该注册项的回退链，结果确认不可用后再恢复为对应类别的打包默认字体并写回修复后的配置。

“系统默认”始终可选，使用跨平台系统 UI 字体栈。默认代码字体使用随应用打包的 Geist Mono，保证所有支持平台的默认结果一致。

## 排版变量与覆盖范围

Provider 只写入基础值，`main.css` 从基础值派生稳定的语义层级：

```css
--ui-font-size: 14px;
--ui-font-size-caption: calc(var(--ui-font-size) - 3px);
--ui-font-size-xs: calc(var(--ui-font-size) - 2px);
--ui-font-size-sm: calc(var(--ui-font-size) - 1px);
--ui-font-size-lg: calc(var(--ui-font-size) + 2px);
--ui-font-size-xl: calc(var(--ui-font-size) + 4px);
--ui-font-size-title: calc(var(--ui-font-size) + 6px);
--ui-font-size-2xl: calc(var(--ui-font-size) + 10px);
--ui-font-size-display: calc(var(--ui-font-size) + 12px);
--code-font-size: 13px;
--code-line-height: 1.65;
```

Tailwind 的标准层级按当前视觉基线映射：`text-xs` 使用 `--ui-font-size-xs`，`text-sm` 使用 `--ui-font-size`，`text-base` 使用 `--ui-font-size-lg`，`text-lg` 使用 `--ui-font-size-xl`，`text-xl` 使用 `--ui-font-size-title`，`text-2xl` 使用 `--ui-font-size-2xl`。额外提供 caption 和介于 caption、正文之间的 small 语义层级，分别使用 `--ui-font-size-caption` 与 `--ui-font-size-sm`。

首版同时审计并替换桌面端第一方代码中的任意像素字号，例如 `text-[11px]`、`text-[12px]` 和 `text-[13px]`；它们必须改成对应的语义文字层级，不能只在根节点写变量后宣称整个应用已经支持字号调整。标题、正文和辅助文字都随基础字号保持固定差值变化，间距、按钮高度和图标尺寸保持不变。

首版 UI 字体与字号必须覆盖：

- 主侧边栏、设置侧边栏和标题栏；
- 设置页、调度任务页、插件页和空状态；
- 对话正文、消息元数据、编辑器和输入框；
- 弹窗、菜单、Popover、Tooltip、提示和表单控件；
- 浏览器、文件、审查等工具面板的界面文字；
- 文件树、工具栏和状态文字。

代码字体与字号必须覆盖：

- Markdown 代码块和代码预览；
- 文件内容预览；
- Diff 与审查内容；
- Mermaid 错误中的源码和其他第一方等宽代码内容。

必要适配点包括：

- 将 `.assistant-markdown` 和 `.desktop-markdown-preview` 的固定字体与 `14px` 改为 UI 字体和字号变量；
- 将代码块 Shadow DOM `unsafeCSS` 中的固定 `12px` 和 `20px` 行高改为可继承的代码变量；
- 将文件预览和 Diff 的 Shadow DOM `unsafeCSS` 改为代码变量；
- 将现有第一方桌面组件中的任意像素文字 class 替换为语义层级；
- 让 shadcn/ui 组件使用的标准 `text-xs`、`text-sm`、`text-base` 等层级随 UI 基础字号派生。

集成终端的 xterm 内容明确排除，不读取 `--code-font-size` 或代码字体；终端周围的工具栏、标签和状态文字仍属于 UI 排版范围。

## 强调色解析

预设色提供中性、蓝色、紫色、陶红和绿色。预设 ID 是保存值，实际色值由颜色注册表管理，因此以后可以微调视觉色值而不改变已保存的 ID。

自定义颜色保存用户输入的规范化 HEX。颜色解析器根据当前浅色或深色主题生成以下明确映射：

| 用户颜色影响         | CSS token                      | 处理方式                                                     |
| -------------------- | ------------------------------ | ------------------------------------------------------------ |
| 主要按钮和强操作     | `--primary`                    | 保留用户颜色；只在无法满足控件边界辨识度时调整亮度           |
| 主要按钮文字         | `--primary-foreground`         | 从黑、白中选择对比度更高者                                   |
| 键盘焦点             | `--ring`                       | 针对当前页面背景调整亮度，保持非文字对比度                   |
| 菜单和列表弱选中背景 | `--accent`                     | 将用户颜色与当前背景混合，生成低强度背景，不直接使用原始 HEX |
| 弱选中文字           | `--accent-foreground`          | 针对派生背景独立选择并校验                                   |
| 侧边栏主要状态       | `--sidebar-primary`            | 根据侧边栏背景生成主题专用主色                               |
| 侧边栏主要状态文字   | `--sidebar-primary-foreground` | 针对侧边栏主色独立选择并校验                                 |
| 侧边栏弱选中背景     | `--sidebar-accent`             | 将用户颜色与侧边栏背景混合，不直接使用原始 HEX               |
| 侧边栏弱选中文字     | `--sidebar-accent-foreground`  | 针对侧边栏弱背景独立校验                                     |
| 当前导航选中背景     | `--sidebar-selected`           | 使用比弱 hover 更清楚、但仍保持低强度的主题专用混合色        |

普通文字与背景的对比度至少为 4.5:1；大文字至少为 3:1；焦点指示器、控件边界和其他非文字状态至少为 3:1。颜色推导测试直接断言这些数值，不使用“看起来足够明显”作为通过条件。

前景色优先从黑色和白色中选择。焦点环、弱背景和侧边栏颜色分别针对浅色、深色及其实际表面色推导。派生过程不会覆盖用户保存的原始颜色，也不会把高饱和原色直接写入 shadcn/ui 的弱 `accent` token。

非法或不完整的自定义颜色不会进入 Provider，也不会替换当前有效强调色。

## 页面结构

外观页沿用现有设置页的内容宽度、滚动容器和左右设置行模式。页面顺序为：

1. 标题、作用范围说明、“恢复默认外观”；
2. 主题预览；
3. 颜色；
4. 字体；
5. 动效。

### 主题

使用单选式 `ToggleGroup` 展示“跟随系统、浅色、深色”。每项包含由 CSS 绘制的轻量界面示意，不依赖截图或远程图片。当前项同时显示边框、勾选图标和文字状态。

### 颜色

推荐色使用单选式 `ToggleGroup`。自定义颜色使用带标签和错误信息的 `Field` 与 `Input`，旁边显示颜色预览块。

输入过程中允许出现暂时不完整的文本。只有形成合法的 `#RRGGBB` 后才提交 Provider、预览并保存。非法输入保留在输入框中供用户继续编辑，应用继续使用上一份有效颜色。

### 字体

界面字体和代码字体分别使用 `Select`。选项来自字体注册表，并放入 `SelectGroup`。本机候选在页面加载时完成固定列表检查；不可用项显示“本机未安装”并禁用，随应用打包的字体不做可用性探测。

### 字号

界面字号和代码字号都使用 `Slider` 与数字 `Input` 联动。滑杆用于快速调整，数字框用于精确输入。越界输入在提交时限制到合法范围。

界面字号只调整文字 token，不改变根字号，因此不会把间距、按钮和图标一起缩放。代码字号作用于代码块、Diff 和文件预览等代码内容，不作用于集成终端。

### 动效

使用单选式 `ToggleGroup` 展示“系统、开启、关闭”：

- 系统：读取 `prefers-reduced-motion`；
- 开启：减少非必要动画、平滑滚动和大幅位移动画；
- 关闭：显式覆盖操作系统的减少动态效果偏好并使用完整动画，但保留必要的可访问性保护。

减少动效不移除加载状态和进度变化等必要反馈。

Provider 将三态偏好解析成唯一的 `resolvedReducedMotion: boolean`。系统模式监听 `prefers-reduced-motion`；开启固定解析为 `true`；关闭固定解析为 `false`。CSS 不再通过媒体查询独立做第二次决定。当前无条件的 `@media (prefers-reduced-motion: reduce)` 改为：

```css
:root[data-reduced-motion="true"] *,
:root[data-reduced-motion="true"] *::before,
:root[data-reduced-motion="true"] *::after {
  scroll-behavior: auto !important;
  transition-duration: 0.01ms !important;
  animation-duration: 0.01ms !important;
  animation-iteration-count: 1 !important;
}
```

`MotionConfig` 和所有业务动画逻辑读取同一个最终布尔值，因此 CSS transition、CSS keyframes 和 JavaScript Motion 动画不会出现互相冲突的减少动效状态。

### 保存与恢复默认

每次有效修改都立即预览并自动保存。保存状态通过低干扰的 `aria-live="polite"` 区域短暂显示，不持续占据视觉注意力。

“恢复默认外观”使用 `AlertDialog` 列出将恢复的范围。用户确认后用默认配置一次性替换整份配置。

## 数据流

单项修改的完整流程为：

1. 设置控件产生候选值；
2. 页面组件完成输入态处理，把可提交值交给 Provider；
3. Provider 合并当前配置并运行完整校验；
4. 有效配置序列化为一个 JSON 并同步写入本地存储；
5. Provider 更新 React 状态；
6. DOM class、属性和 CSS 变量随状态更新；
7. 页面通过 `aria-live` 报告保存结果。

`localStorage` 写入是同步操作。先成功写入再发布新状态，可以避免持久化失败时整个应用短暂切换后又回滚。对用户而言，保存和预览发生在同一次交互内。

系统主题或减少动效偏好改变时，只更新解析后的运行状态，不写回用户偏好。`storage` 事件收到另一窗口的配置时，先走相同的解析和修复流程，再应用有效结果。

## 异常处理与配置修复

启动读取采用字段级恢复：

- JSON 无法解析时使用完整默认配置；
- 版本未知时使用完整默认配置；
- 个别字段非法时保留其余合法字段，只恢复问题字段；
- 字段缺失时用对应默认值补齐；
- 修复后的配置重新写回存储，避免每次启动重复修复。

运行时异常处理如下：

- 本地存储写入失败：保留上一份有效配置，在外观页显示页面内 `Alert`；
- 自定义颜色非法：保留输入文本，但不修改应用主题；
- 字体不可用：恢复为对应类别的打包默认字体，并在外观页把不可用候选标为禁用；
- `matchMedia` 或相关系统监听不可用：明暗主题回退为浅色，减少动效回退为开启；
- Provider 卸载时移除媒体查询和存储监听器。

外观异常不得阻止应用启动或导致设置页白屏。

## 响应式与可访问性

- 窄窗口下设置行从左右布局变为上下布局；
- 主题卡片和颜色选项自动换行，不产生页面横向滚动；
- 所有输入使用可读标签和关联错误信息；
- 单选选项可通过键盘方向键切换；
- 当前状态同时使用形状、文字和颜色表达；
- 所有交互元素保留可见焦点；
- 正文和状态颜色满足 WCAG 2.1 AA 对比度要求；
- 对话框有标题和说明；
- 保存结果使用 `aria-live="polite"`，错误使用页面内 `Alert`。

## shadcn/ui 组件使用

优先复用现有 `Card`、`Field`、`Input`、`Select`、`SelectGroup`、`Slider`、`Button`、`Alert` 和 `AlertDialog`。主题、推荐色和减少动效使用 shadcn/ui `ToggleGroup`；如果项目中尚未安装，则通过项目的 shadcn CLI 添加并检查生成文件。

布局使用 Tailwind class，颜色使用语义 token。业务组件不覆盖 shadcn/ui 组件自身的颜色和字体样式。

## 测试与验收

### 纯逻辑单元测试

- 默认配置；
- JSON 解析和字段级恢复；
- 未知版本回退；
- HEX 规范化和非法值拒绝；
- 浅色、深色下的前景色与派生 token；
- 所有颜色 token 的文字和非文字对比度阈值；
- 字体注册表、来源分类、可用性结果与损坏值恢复；
- 字号边界；
- 减少动效解析。

### Provider 测试

- 启动时同步读取；
- `light`、`dark` class 应用；
- CSS 变量和数据属性应用；
- `MotionConfig` 与 `resolvedReducedMotion` 保持一致；
- 系统主题变化；
- 系统减少动效变化；
- `storage` 事件同步；
- 单项更新；
- 恢复默认；
- 写入失败时保持上一份有效配置；
- 卸载时清理监听器。

Provider 测试还要证明新键不存在时直接使用新默认值，不读取 `vykor-desktop-theme`，并证明模块不再导出 `useTheme()` 兼容接口。

### 页面交互测试

- 三种主题选择；
- 推荐色选择；
- 合法和非法自定义色；
- 界面字体与代码字体；
- 不可用本机字体的标记和禁用状态；
- Slider 与数字 Input 联动；
- 三态减少动效；
- 恢复默认确认；
- 保存状态与错误反馈；
- 键盘操作。

### 完成前验证

运行桌面端相关 Vitest、Web 端 TypeScript 类型检查和 lint。测试不能只断言根节点变量已写入，还必须读取导航、设置页、对话正文、输入框、代码块、文件预览和 Diff 的计算后字体与字号，证明设置确实到达主要界面。随后在浅色、深色和窄窗口下进行人工视觉检查，确认设置页没有横向滚动、文本截断、不可见焦点或低对比度状态。本功能不引入新的端到端测试框架。

## 成功标准

- 用户可以在外观页完成所有首版设置，不需要编辑配置文件；
- 每个有效修改立即作用于整个桌面应用，并在重新启动后保留；
- 跟随系统模式会响应操作系统的明暗主题和减少动效变化；
- “关闭减少动态效果”能够覆盖操作系统偏好，CSS 与 JavaScript 动画使用同一最终状态；
- 自定义强调色不会产生不可读的主要按钮文字或不可辨识的焦点状态；
- 调整 UI 字体或字号后，所有列入首版范围的主要界面计算样式都会变化；
- 调整代码字体或字号后，代码块、文件预览和 Diff 的计算样式都会变化；
- 非法或损坏配置不会阻止应用启动；
- 外观设置不会改变项目、daemon 或终端配置；
- 新配置不存在时使用“跟随系统”，不读取旧主题数据；
- 侧边栏主题按钮仍可使用，裸 `D` 主题快捷键和所有旧主题 API 均不存在。
