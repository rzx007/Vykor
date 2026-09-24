# 大文件源码预览后台高亮实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 所有源码预览先立即显示虚拟化纯文本，再由 Pierre WorkerPool 在后台完成 Shiki 高亮，避免大 HTML 阻塞桌面界面。

**架构：** 在 `VirtualizedCodePreview` 外层接入一个单 Worker 的 `WorkerPoolContextProvider`。Pierre 的 `VirtualizedFile` 负责先生成可见区域纯文本、提交后台高亮并自动应用结果；项目只提供稳定的 Worker 配置，不再维护文件阈值或自定义异步状态。

**技术栈：** React 19、Electron Vite 5、Pierre Diffs 1.3.5、Shiki、Vitest、TypeScript

---

## 文件结构

- 创建 `apps/desktop/src/renderer/src/components/desktop/tools/code-preview-worker-options.ts`：集中定义单 Worker 配置和 4,000 字符单行高亮上限。
- 创建 `apps/desktop/src/renderer/src/components/desktop/tools/code-preview-worker-options.test.ts`：验证 Worker 数量、工厂透传和 Shiki 限制。
- 修改 `apps/desktop/src/renderer/src/components/desktop/tools/virtualized-code-preview.tsx`：创建 Pierre Worker，并用 `WorkerPoolContextProvider` 包住现有虚拟化文件预览。
- 修改 `apps/desktop/electron.vite.config.ts`：把 renderer Worker 输出格式设为 ES module，允许 Pierre Worker 按需加载语言资源。

### 任务 1：建立可测试的 Worker 配置

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/desktop/tools/code-preview-worker-options.ts`
- 测试：`apps/desktop/src/renderer/src/components/desktop/tools/code-preview-worker-options.test.ts`

- [ ] **步骤 1：编写失败的配置测试**

```ts
import { describe, expect, it, vi } from "vitest"

import {
  codePreviewHighlighterOptions,
  createCodePreviewWorkerPoolOptions,
} from "./code-preview-worker-options"

describe("code preview worker options", () => {
  it("uses one worker and preserves the supplied factory", () => {
    const worker = {} as Worker
    const workerFactory = vi.fn(() => worker)
    const options = createCodePreviewWorkerPoolOptions(workerFactory)

    expect(options.poolSize).toBe(1)
    expect(options.workerFactory()).toBe(worker)
    expect(workerFactory).toHaveBeenCalledOnce()
  })

  it("runs Shiki with an upper bound for pathological lines", () => {
    expect(codePreviewHighlighterOptions).toMatchObject({
      preferredHighlighter: "shiki-js",
      tokenizeMaxLineLength: 4_000,
    })
  })
})
```

- [ ] **步骤 2：运行测试并确认它因模块不存在而失败**

运行：

```powershell
pnpm --filter @vykor/desktop test -- src/renderer/src/components/desktop/tools/code-preview-worker-options.test.ts
```

预期：FAIL，提示无法解析 `./code-preview-worker-options`。

- [ ] **步骤 3：添加最小配置实现**

```ts
import type {
  WorkerInitializationRenderOptions,
  WorkerPoolOptions,
} from "@pierre/diffs/react"

export const codePreviewHighlighterOptions = {
  preferredHighlighter: "shiki-js",
  tokenizeMaxLineLength: 4_000,
} satisfies WorkerInitializationRenderOptions

export function createCodePreviewWorkerPoolOptions(
  workerFactory: () => Worker
): WorkerPoolOptions {
  return { poolSize: 1, workerFactory }
}
```

- [ ] **步骤 4：运行测试并确认通过**

运行：

```powershell
pnpm --filter @vykor/desktop test -- src/renderer/src/components/desktop/tools/code-preview-worker-options.test.ts
```

预期：2 个测试通过。

- [ ] **步骤 5：提交配置与测试**

```powershell
git add -- apps/desktop/src/renderer/src/components/desktop/tools/code-preview-worker-options.ts apps/desktop/src/renderer/src/components/desktop/tools/code-preview-worker-options.test.ts
git commit -m "perf(desktop): 配置源码高亮 Worker"
```

### 任务 2：将源码预览接入 Pierre WorkerPool

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/virtualized-code-preview.tsx`
- 修改：`apps/desktop/electron.vite.config.ts`

- [ ] **步骤 1：接入 Vite Worker 构造器和 Pierre Provider**

添加导入：

```ts
import PierreDiffsWorker from "@pierre/diffs/worker/worker.js?worker"
import { WorkerPoolContextProvider } from "@pierre/diffs/react"

import {
  codePreviewHighlighterOptions,
  createCodePreviewWorkerPoolOptions,
} from "./code-preview-worker-options"
```

在模块级创建稳定配置：

```ts
const codePreviewWorkerPoolOptions = createCodePreviewWorkerPoolOptions(
  () => new PierreDiffsWorker()
)
```

使用 Provider 包住当前 `Virtualizer`：

```tsx
<WorkerPoolContextProvider
  poolOptions={codePreviewWorkerPoolOptions}
  highlighterOptions={codePreviewHighlighterOptions}
>
  <Virtualizer>{/* 保持现有预览内容 */}</Virtualizer>
</WorkerPoolContextProvider>
```

同时保留 `FileOptions` 中的主题、语言高亮和现有虚拟滚动配置。将 `tokenizeMaxLineLength: 4_000` 加入文件选项，确保 Worker 和回退路径使用同一个限制。

在 `electron.vite.config.ts` 的 `renderer` 配置中加入：

```ts
worker: {
  format: "es",
},
```

Pierre Worker 会按需加载语言模块，ES module 输出允许 Vite 为这些模块生成独立分包；默认 IIFE Worker 不支持该代码分包。

- [ ] **步骤 2：运行桌面端定向测试和类型检查**

运行：

```powershell
pnpm --filter @vykor/desktop test -- src/renderer/src/components/desktop/tools/code-preview-worker-options.test.ts src/renderer/src/components/desktop/tools/virtualized-code-preview.test.ts
pnpm --filter @vykor/desktop typecheck
```

预期：相关测试和 node/web TypeScript 检查全部通过。

- [ ] **步骤 3：构建桌面渲染产物，确认 Worker 被 Vite 正确打包**

运行：

```powershell
pnpm --filter @vykor/desktop build
```

预期：构建成功，输出中包含独立 Worker 资源，且不存在 `?worker` 解析错误。

- [ ] **步骤 4：检查变更边界**

运行：

```powershell
git diff --check
git status --short
```

预期：没有空白错误；只提交本计划涉及的三个源码/测试文件，不包含工作区已有的浏览器和上下文文档改动。

- [ ] **步骤 5：提交集成改动**

```powershell
git add -- apps/desktop/electron.vite.config.ts apps/desktop/src/renderer/src/components/desktop/tools/virtualized-code-preview.tsx docs/superpowers/plans/2026-08-31-large-code-preview-worker.md
git commit -m "perf(desktop): 后台处理源码语法高亮"
```
