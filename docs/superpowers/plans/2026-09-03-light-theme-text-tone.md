# 浅色主题文字色调实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将浅色主题的主文字统一调整为柔和深灰，避免接近纯黑的生硬观感。

**架构：** 只修改 `main.css` 的基础浅色 token。`ui-foreground` 与 `content-foreground` 已引用 `foreground`，所以全局 UI 与内容会同步更新；`card-foreground` 和 `popover-foreground` 显式改为同一 token，避免表面组件保留旧黑色。

**技术栈：** CSS Custom Properties、Tailwind CSS v4、Electron Vite。

---

## 文件结构

- 修改：`apps/desktop/src/renderer/src/assets/main.css` — 定义并复用柔和的浅色主文字 token。
- 验证：`apps/desktop` 的类型检查与生产构建 — 校验 CSS 处理与桌面端打包。

### 任务 1：统一浅色主文字 token

**文件：**
- 修改：`apps/desktop/src/renderer/src/assets/main.css:98-103`

- [ ] **步骤 1：确认 CSS 配置变更的可观察目标**

浅色主题的 `foreground`、`card-foreground`、`popover-foreground` 都必须解析为 `oklch(0.30 0 0)`；深色主题块不修改。此项是静态 CSS token 配置，没有可运行的纯逻辑入口，因此采用构建产物验证而不添加源文本匹配测试。

- [ ] **步骤 2：写入最少实现**

```css
--foreground: oklch(0.3 0 0);
--card-foreground: var(--foreground);
--popover-foreground: var(--foreground);
```

- [ ] **步骤 3：运行桌面端验证**

运行：`pnpm --filter @vykor/desktop typecheck && pnpm --filter @vykor/desktop build`

预期：类型检查与 Electron Vite 生产构建均以退出码 0 完成。
