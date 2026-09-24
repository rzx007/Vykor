# 桌面端长文档渲染性能优化实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 消除桌面端右侧文件与审阅 Panel 在打开长代码、长 Markdown 和大 Diff 时的长时间无响应，同时保留小文件的完整高亮、搜索定位和主题切换体验。

**架构：** 在入口用一次线性扫描判断内容复杂度，超限时默认使用纯文本或暂停 Markdown 预览；正常文件继续使用 `@pierre/diffs`，但接入它的 `Virtualizer` 控制 DOM 数量，并通过共享 Worker Pool 把 Shiki 高亮移出 Electron 渲染线程。文件、Markdown 代码块和 Review Diff 共用策略与主题状态，不再各自观察 DOM 或无条件重新挂载。

**技术栈：** React 19、TypeScript、Electron 39、electron-vite/Vite Worker、`@pierre/diffs` 1.3.5、Streamdown 2.5、Vitest 3、jsdom。

---

## 边界和关键决定

已确认：`tokenizeMaxLength` 在 Pierre 中按行数而非字符数计算；当前 `220_000` 基本不会在 1.25 MB 读取上限内触发。当前也没有挂 Pierre `Virtualizer` 或 `WorkerPoolContextProvider`，所以整份高亮和整份行节点渲染都压在 renderer Main 线程。Markdown 的每个 fenced code block 还会建立独立主题观察器并主动重挂一次。

集中使用以下第一版保护线：

| 场景 | 字符 | 行数 | 最长单行 | 超限行为 |
|---|---:|---:|---:|---|
| 文件 | 200,000 | 5,000 | 10,000 | 虚拟化纯文本，可手动强制高亮 |
| Markdown | 300,000 | 8,000 | 20,000 | 暂停预览，可切源码或手动继续 |
| fenced code | 100,000 | 2,000 | 5,000 | 纯文本代码块 |
| Diff | 300,000 | 10,000 | 10,000 | plain-text diff 或原始 patch |

不做：更换 Monaco/CodeMirror、改变主进程读取上限、把高亮结果持久化、长期挂载所有标签、自己实现增量 Markdown AST。阈值只能集中调整，不能在组件中散落例外数字。

## 文件职责

**创建：**

- `apps/desktop/src/renderer/src/components/desktop/tools/file-preview-policy.ts`：扫描指标和四种场景决策。
- `apps/desktop/src/renderer/src/components/desktop/tools/file-preview-policy.test.ts`：阈值边界测试。
- `apps/desktop/src/renderer/src/components/desktop/tools/large-preview-notice.tsx`：共用降级提示。
- `apps/desktop/src/renderer/src/components/desktop/tools/virtualized-code-preview.tsx`：Pierre Virtualizer、文件渲染和行定位。
- `apps/desktop/src/renderer/src/components/desktop/tools/virtualized-code-preview.test.ts`：模式和定位测试。
- `apps/desktop/src/renderer/src/components/code-renderer-provider.tsx`：共享 Pierre Worker Pool。
- `apps/desktop/src/renderer/src/components/code-renderer-provider.test.ts`：Worker 配置测试。
- `apps/desktop/src/renderer/src/components/desktop/tools/file-preview-performance.ts` 及对应测试：开发态计时。
- `apps/desktop/src/renderer/src/components/desktop/tools/review-tool.test.ts`：Diff 降级测试。
- `docs/performance/desktop-file-preview-benchmark.md`：固定样本与优化前后数据。

**修改：**

- `file-viewer.tsx`、`files-tool.tsx`：文件/Markdown 策略和手动覆盖。
- `code-block.tsx`、`streamdown-renderers.tsx` 及测试：代码块降级，删除重复观察和重挂。
- `review-tool.tsx`：Diff 策略。
- `theme-provider.tsx`：公开稳定的 `resolvedTheme`。
- `main.tsx`：挂载唯一 Worker Provider。
- `renderer-security-policy.test.ts`：锁定 Worker 所需 CSP 不放宽远程脚本。
- `electron.vite.config.ts`：仅在默认 `?worker` 构建失败时调整。

---

### 任务 1：建立统一复杂度策略

**文件：** 创建 `file-preview-policy.ts`、`file-preview-policy.test.ts`

- [ ] **步骤 1：先写失败测试**

```ts
import { describe, expect, it } from "vitest"
import { analyzePreviewContent, resolvePreviewDecision } from "./file-preview-policy"

describe("preview policy", () => {
  it("counts CRLF without including carriage return in line length", () => {
    expect(analyzePreviewContent("a\r\nbbbb\n")).toEqual({
      characterCount: 8,
      lineCount: 3,
      maxLineLength: 4,
    })
  })

  it("keeps small files highlighted and degrades oversized content", () => {
    expect(resolvePreviewDecision("file", "const x = 1\n").mode).toBe("highlighted")
    expect(resolvePreviewDecision("file", "x".repeat(200_001))).toMatchObject({
      mode: "plain",
      reason: "characters",
    })
    expect(resolvePreviewDecision("markdown", "# x\n".repeat(80_000)).mode).toBe("paused")
    expect(resolvePreviewDecision("code-block", "x\n".repeat(2_001)).mode).toBe("plain")
  })
})
```

- [ ] **步骤 2：运行测试确认模块不存在**

```powershell
pnpm --filter @vykor/desktop test -- src/renderer/src/components/desktop/tools/file-preview-policy.test.ts
```

预期：FAIL，无法解析 `./file-preview-policy`。

- [ ] **步骤 3：实现类型、集中常量和单次扫描**

```ts
export type PreviewKind = "file" | "markdown" | "code-block" | "diff"
export type PreviewMode = "highlighted" | "plain" | "paused"
export type PreviewLimitReason = "characters" | "lines" | "line-length"

export interface PreviewMetrics {
  characterCount: number
  lineCount: number
  maxLineLength: number
}

export interface PreviewDecision {
  kind: PreviewKind
  mode: PreviewMode
  reason: PreviewLimitReason | null
  metrics: PreviewMetrics
}

export const previewLimits = {
  file: { characters: 200_000, lines: 5_000, lineLength: 10_000 },
  markdown: { characters: 300_000, lines: 8_000, lineLength: 20_000 },
  "code-block": { characters: 100_000, lines: 2_000, lineLength: 5_000 },
  diff: { characters: 300_000, lines: 10_000, lineLength: 10_000 },
} as const
```

`analyzePreviewContent` 用一个 `for` 循环统计，不使用 `split()` 复制全文。`resolvePreviewDecision` 按字符、行数、最长行顺序返回首个原因；Markdown 超限为 `paused`，其他场景为 `plain`。

- [ ] **步骤 4：补齐空内容、阈值等于/加一、CRLF 和单行超限测试并运行通过**

- [ ] **步骤 5：提交**

```powershell
git add apps/desktop/src/renderer/src/components/desktop/tools/file-preview-policy.ts apps/desktop/src/renderer/src/components/desktop/tools/file-preview-policy.test.ts
git commit -m "perf(desktop): add file preview complexity policy"
```

---

### 任务 2：代码文件安全降级和手动覆盖

**文件：** 创建 `large-preview-notice.tsx`、`virtualized-code-preview.tsx` 及测试；修改 `file-viewer.tsx`、`file-viewer.test.ts`

- [ ] **步骤 1：写失败测试锁定模式**

```ts
export function resolveCodeRenderMode(
  decision: PreviewDecision,
  forceHighlight: boolean
): "highlighted" | "plain" {
  return forceHighlight || decision.mode === "highlighted" ? "highlighted" : "plain"
}
```

测试必须证明大文件默认 `plain`、点击覆盖后 `highlighted`、另一条 path 不继承覆盖。Mock `PierreFile` 验证 plain 模式的 `file.lang === "text"`，高亮模式保留原语言。

- [ ] **步骤 2：运行并确认失败**

```powershell
pnpm --filter @vykor/desktop test -- src/renderer/src/components/desktop/tools/file-viewer.test.ts src/renderer/src/components/desktop/tools/virtualized-code-preview.test.ts
```

- [ ] **步骤 3：实现提示和模式化 FileContents**

`LargePreviewNotice` 接受标题、描述、主次按钮回调。代码文案为“文件较大，已关闭语法高亮”，描述显示实际字符/行数和原因，主按钮为“仍然高亮”。覆盖只保存在 `FileViewer` 的 `Set<string>` 中，不写 localStorage。

```ts
const file: FileContents = {
  name: mode === "plain" ? `${preview.path}.txt` : preview.path,
  contents: preview.content ?? "",
  lang: mode === "plain" ? "text" : normalizeLanguage(preview.language, preview.path),
  cacheKey: `${preview.path}:${preview.size}:${mode}`,
}
```

options 改为 `tokenizeMaxLength: previewLimits.file.lines`、`tokenizeMaxLineLength: previewLimits.file.lineLength`。手动强制只绕过应用级总量判断，最长单行仍受 10,000 限制。

- [ ] **步骤 4：运行测试、类型检查并提交**

```powershell
pnpm --filter @vykor/desktop test -- src/renderer/src/components/desktop/tools/file-preview-policy.test.ts src/renderer/src/components/desktop/tools/file-viewer.test.ts src/renderer/src/components/desktop/tools/virtualized-code-preview.test.ts
pnpm --filter @vykor/desktop typecheck
git add apps/desktop/src/renderer/src/components/desktop/tools/file-viewer.tsx apps/desktop/src/renderer/src/components/desktop/tools/file-viewer.test.ts apps/desktop/src/renderer/src/components/desktop/tools/large-preview-notice.tsx apps/desktop/src/renderer/src/components/desktop/tools/virtualized-code-preview.tsx apps/desktop/src/renderer/src/components/desktop/tools/virtualized-code-preview.test.ts
git commit -m "perf(desktop): degrade oversized code previews safely"
```

---

### 任务 3：启用虚拟化并保持搜索定位

**文件：** 修改 `virtualized-code-preview.tsx` 及测试、`file-viewer.tsx`

- [ ] **步骤 1：写失败测试**

Mock `Virtualizer`、`useVirtualizer`、`PierreFile`。验证 Pierre 位于 Virtualizer 下；搜索第 101 行调用 `scrollTo({ top: 1928, behavior: "smooth" })`；`targetLine=1` 不产生负值；search match 优先于 target line；搜索变化不改变 cache key。

- [ ] **步骤 2：运行失败测试后实现**

```tsx
<Virtualizer
  className="h-full min-w-0 overflow-auto"
  contentClassName="relative min-h-full min-w-max"
  config={{ overscrollSize: 800 }}
>
  <PreviewScrollController top={currentLineTop} />
  <CurrentLineOverlay top={currentLineTop} />
  <PierreFile file={file} options={options} className="desktop-code-file relative z-10" />
</Virtualizer>
```

`PreviewScrollController` 必须在 Context 内调用 `useVirtualizer().scrollTo()`。移除外层纵向 `ScrollArea`，避免双滚动容器；保留 20 px 行高、72 px 顶部偏移和水平滚动。

- [ ] **步骤 3：验证和提交**

```powershell
pnpm --filter @vykor/desktop test -- src/renderer/src/components/desktop/tools/virtualized-code-preview.test.ts
pnpm --filter @vykor/desktop typecheck
pnpm --filter @vykor/desktop lint
git add apps/desktop/src/renderer/src/components/desktop/tools/virtualized-code-preview.tsx apps/desktop/src/renderer/src/components/desktop/tools/virtualized-code-preview.test.ts apps/desktop/src/renderer/src/components/desktop/tools/file-viewer.tsx
git commit -m "perf(desktop): virtualize file preview rows"
```

手动检查 10,000 行首部、中部、末尾定位，当前行背景、行号和文本必须对齐；稳定后 `[data-line]` 节点必须小于 500。

---

### 任务 4：将高亮移入共享 Worker Pool

**文件：** 创建 `code-renderer-provider.tsx` 及测试；修改 `main.tsx`、`renderer-security-policy.test.ts`；条件修改 `electron.vite.config.ts`

- [ ] **步骤 1：写失败测试**

测试 `codeWorkerPoolSize === 2`，高亮配置是 `preferredHighlighter: "shiki-js"`、`tokenizeMaxLineLength: 10_000`。CSP 测试继续断言 `script-src` 不包含 http/https/blob；若产物必须使用 blob Worker，只允许新增 `worker-src 'self' blob:`。

- [ ] **步骤 2：实现 Provider**

```tsx
import PierreWorker from "@pierre/diffs/worker/worker.js?worker"
import { WorkerPoolContextProvider } from "@pierre/diffs/react"

export const codeWorkerPoolSize = 2
export const codeWorkerHighlighterOptions = {
  preferredHighlighter: "shiki-js",
  tokenizeMaxLineLength: 10_000,
} as const

const poolOptions = {
  poolSize: codeWorkerPoolSize,
  workerFactory: () => new PierreWorker(),
}
```

`CodeRendererProvider` 包裹 children，并在 `main.tsx` 中放在 `ThemeProvider` 内、`TooltipProvider` 外。全应用只能挂一个实例，让文件、代码块和 Diff 共享池及 LRU。

- [ ] **步骤 3：验证 Worker 打包和 CSP**

```powershell
pnpm --filter @vykor/desktop test -- src/renderer/src/components/code-renderer-provider.test.ts src/renderer/src/renderer-security-policy.test.ts
pnpm --filter @vykor/desktop typecheck
pnpm --filter @vykor/desktop build
```

确认 `out/renderer/assets` 有独立 Worker 产物，启动后无 CSP/Worker 初始化错误；强制高亮时主要 Shiki 计算位于 Worker 轨道。只有默认 `?worker` 失败时才修改 electron-vite 配置，不使用运行时网络 URL。

- [ ] **步骤 4：提交**

```powershell
git add apps/desktop/src/renderer/src/components/code-renderer-provider.tsx apps/desktop/src/renderer/src/components/code-renderer-provider.test.ts apps/desktop/src/renderer/src/main.tsx apps/desktop/src/renderer/src/renderer-security-policy.test.ts
git commit -m "perf(desktop): move syntax highlighting to worker pool"
```

若实际修改了 `electron.vite.config.ts`，把它加入同一提交；否则不要产生无意义改动。

---

### 任务 5：治理 Markdown 和 fenced code block

**文件：** 修改 `file-viewer.tsx`、`files-tool.tsx`、`code-block.tsx`、`streamdown-renderers.tsx` 及测试、`theme-provider.tsx`；创建 `theme-provider.test.ts`

- [ ] **步骤 1：写失败测试**

覆盖：小 Markdown 挂 Streamdown；超限 Markdown 不挂 Streamdown并显示“完整预览已暂停”；“查看源码”调用 `onViewModeChange("source")`；“仍然预览”只覆盖当前 path。扩展代码围栏测试：2,001 行代码传给 `CodeBlock` 的 `renderMode` 为 `plain`，小块为 `highlighted`。

```ts
it("marks an oversized fenced block as plain text", () => {
  const rendered = StreamdownCodeBlock({
    className: "language-typescript",
    children: "x\n".repeat(2_001),
  })
  expect(rendered.props.renderMode).toBe("plain")
})
```

- [ ] **步骤 2：实现 Markdown 门控和代码块策略**

给 FileViewer 增加 `onViewModeChange`，FilesTool 传现有 `setActiveViewMode`。大 Markdown 在用户确认前完全不创建 Streamdown。`CodeBlockProps` 增加 `renderMode?: "highlighted" | "plain"`；plain 明确使用 `lang: "text"`，cache key 包含模式；阈值读取 `previewLimits["code-block"]`。

- [ ] **步骤 3：集中 resolved theme**

`ThemeProviderState` 增加 `resolvedTheme: "dark" | "light"`，跟随显式主题和系统 color scheme 更新。FileViewer、CodeBlock、ReviewTool 改用 `useTheme().resolvedTheme`，删除各自 MutationObserver 和 `resolveThemeType()`。

- [ ] **步骤 4：删除代码块无条件二次挂载**

删除 `renderPass`、等待 `customElements.whenDefined` 的 effect 和包含 renderPass 的 key。Mock Pierre 计数：首次显示只挂载一次；主题切换只更新 options，不卸载重挂。Mermaid 路径保持原样。

- [ ] **步骤 5：验证和提交**

```powershell
pnpm --filter @vykor/desktop test -- src/renderer/src/components/theme-provider.test.ts src/renderer/src/components/desktop/tools/file-viewer.test.ts src/renderer/src/components/desktop/conversation-page/message/streamdown-renderers.test.ts
pnpm --filter @vykor/desktop typecheck
pnpm --filter @vykor/desktop lint
git add apps/desktop/src/renderer/src/components/theme-provider.tsx apps/desktop/src/renderer/src/components/theme-provider.test.ts apps/desktop/src/renderer/src/components/desktop/tools/file-viewer.tsx apps/desktop/src/renderer/src/components/desktop/tools/files-tool.tsx apps/desktop/src/renderer/src/components/ui/code-block.tsx apps/desktop/src/renderer/src/components/desktop/conversation-page/message/streamdown-renderers.tsx apps/desktop/src/renderer/src/components/desktop/conversation-page/message/streamdown-renderers.test.ts
git commit -m "perf(desktop): bound markdown and code block rendering"
```

手动回归普通 Markdown、未闭合围栏、Mermaid、大小代码块和深浅主题。

---

### 任务 6：保护 Review Diff

**文件：** 修改 `review-tool.tsx`；创建 `review-tool.test.ts`

- [ ] **步骤 1：写失败测试并提取纯函数**

```ts
export function resolveDiffRenderState(patch: string): {
  decision: PreviewDecision
  showNotice: boolean
}
```

测试 300,001 字符或 10,001 行显示提示，小 patch 不显示；主题来自 `useTheme` 而不是 MutationObserver。

- [ ] **步骤 2：实现 Diff 降级**

把 options 改为 `tokenizeMaxLength: previewLimits.diff.lines` 和 `tokenizeMaxLineLength: previewLimits.diff.lineLength`。行数超限时让 Pierre 自身走 plain-text diff；字符超限但行数未超限时，若 PatchDiff 没有安全的强制纯文本 API，就显示虚拟化/可滚动原始 patch `<pre>`，附“仍然渲染 Diff”按钮。禁止直接替换 patch 文件头来伪造 `.txt`，避免破坏解析。

- [ ] **步骤 3：验证 unified/split、四个 review range、主题和大 patch，然后提交**

```powershell
pnpm --filter @vykor/desktop test -- src/renderer/src/components/desktop/tools/review-tool.test.ts
pnpm --filter @vykor/desktop typecheck
pnpm --filter @vykor/desktop lint
git add apps/desktop/src/renderer/src/components/desktop/tools/review-tool.tsx apps/desktop/src/renderer/src/components/desktop/tools/review-tool.test.ts
git commit -m "perf(desktop): protect review panel from oversized diffs"
```

---

### 任务 7：性能测量与硬性验收

**文件：** 创建 `file-preview-performance.ts` 及测试、`docs/performance/desktop-file-preview-benchmark.md`；接入 `virtualized-code-preview.tsx`、`file-viewer.tsx`、`review-tool.tsx`

- [ ] **步骤 1：测试并实现开发态计时器**

```ts
export interface PreviewMeasurement {
  path: string
  kind: PreviewKind
  mode: PreviewMode
  metrics: PreviewMetrics
}

export function startPreviewMeasurement(input: PreviewMeasurement): () => void
```

只有 DEV 且 URL 含 `previewPerf=1` 时使用成对的 `performance.mark/measure`；结束函数幂等；名称前缀固定为 `desktop:file-preview:`；detail 不记录正文。代码结束点用 Pierre `onPostRender`，plain 用 `useLayoutEffect`，Markdown 只记录 React commit，不声称图片/Mermaid 已完成。

- [ ] **步骤 2：运行单测**

```powershell
pnpm --filter @vykor/desktop test -- src/renderer/src/components/desktop/tools/file-preview-performance.test.ts
```

- [ ] **步骤 3：建立固定临时样本并记录基线**

不提交大文件；在临时项目生成：50 KB/约 1,000 行 TS、190 KB/约 4,500 行 TS、1.20 MB/约 25,000 行 TS、1 MB 单行 JSON、400 KB 且含 50 个代码围栏的 Markdown、12,000 行 patch。每项冷启动三次、热启动三次，取中位数。

Benchmark 文档表格：

| 样本 | 模式 | 首次可见 ms | 最大 Main 长任务 ms | 挂载行节点 | renderer 峰值 MB | 切回标签 ms |
|---|---|---:|---:|---:|---:|---:|

记录 CPU、内存、Windows、Electron、是否开 DevTools和基线 commit。

- [ ] **步骤 4：满足全部验收条件**

1. 50 KB、190 KB 文件保持高亮，搜索和目标行定位正确。
2. 1.20 MB 文件默认 300 ms 内出现纯文本/提示，Main 没有超过 100 ms 的连续 Shiki 任务。
3. 1 MB 单行 JSON 默认不高亮，300 ms 内可滚动和切换标签。
4. 25,000 行稳定后，挂载 `[data-line]` 少于 500。
5. 手动强制高亮时窗口仍可操作，主要 Shiki 计算位于 Worker。
6. 热切回首次可见时间不高于冷启动 50%；若 LRU 未命中，至少 Main 不被 Shiki 阻塞。
7. 大 Markdown 默认不挂 Streamdown；继续预览后大代码围栏仍为纯文本。
8. 大 patch 不造成超过 100 ms 的连续 UI 无响应。
9. 主题切换不重挂代码块，也不按代码块数量增加 MutationObserver。
10. 关闭大文件后，经一次空闲 GC，renderer 内存回到打开前上下 20% 范围。

- [ ] **步骤 5：运行完整验证**

```powershell
pnpm --filter @vykor/desktop test
pnpm --filter @vykor/desktop typecheck
pnpm --filter @vykor/desktop lint
pnpm --filter @vykor/desktop build
```

所有命令必须退出码 0。若存在无关既有失败，benchmark 文档记录完整命令和失败项，不得描述为通过。

- [ ] **步骤 6：提交测量与结果**

```powershell
git add apps/desktop/src/renderer/src/components/desktop/tools/file-preview-performance.ts apps/desktop/src/renderer/src/components/desktop/tools/file-preview-performance.test.ts apps/desktop/src/renderer/src/components/desktop/tools/virtualized-code-preview.tsx apps/desktop/src/renderer/src/components/desktop/tools/file-viewer.tsx apps/desktop/src/renderer/src/components/desktop/tools/review-tool.tsx docs/performance/desktop-file-preview-benchmark.md
git commit -m "test(desktop): document file preview performance bounds"
```

---

## 最终审查与回滚

- [ ] 搜索确认三个入口不再出现 `tokenizeMaxLength: 220_000`，所有数字来自 policy。
- [ ] 大文件默认路径不初始化对应语言 grammar；应用中只有一个 Worker Provider、池大小为 2。
- [ ] 代码预览只有一个纵向滚动容器；搜索 1-based 行号和内部 0-based 索引没有偏一。
- [ ] 强制覆盖按 path 隔离且不永久保存；测量不记录正文、不在生产输出。
- [ ] CSP 没有放宽远程脚本/Worker；自动验证和人工 Profile 都有证据。

独立提交允许按边界回滚：Worker/CSP 问题只回滚任务 4；虚拟定位问题只回滚任务 3，保留任务 2 的安全降级；Markdown 和 Diff 分别回滚任务 5、6。阈值过严只改 policy 和边界测试，不在组件加例外。

推荐发布顺序：先合并任务 1～2消除最坏路径；任务 3、任务 4各观察一个版本；稳定后合并任务 5～6；任务 7 的数据和 Profile 完成后才标记整体优化完成。
