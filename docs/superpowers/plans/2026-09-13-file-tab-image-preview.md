# 文件 tab 图片预览实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 Desktop 右侧文件 tab 安全预览不超过 50 MB 的 PNG、JPEG、GIF、WebP、BMP 和 AVIF，同时保留现有文本、Markdown、普通二进制和对话附件行为。

**架构：** 扩展现有 `workspace.readFile` 结果，由 Electron Main 在既有允许根校验之后识别候选位图、应用 50 MB 大小门并校验文件头。Renderer 只把 Main 返回的安全字节转换成 `blob:` URL；文件 tab 继续只持久化路径，恢复时重新读取。

**技术栈：** Electron 39、React 19、TypeScript、Vitest、JSDOM、Tailwind CSS

---

## 文件结构

- 创建 `apps/desktop/src/shared/safe-image-preview.ts`：安全位图扩展名、MIME 和文件头校验的纯函数。
- 创建 `apps/desktop/src/shared/safe-image-preview.test.ts`：覆盖六类安全位图、扩展名映射和伪装内容。
- 修改 `apps/desktop/src/shared/workspace-types.ts`：增加图片预览字节、MIME 和失败原因契约。
- 修改 `apps/desktop/src/main/features/attachment/attachment-service.ts`：复用共享文件头校验，附件 10 MB 限制不变。
- 修改 `apps/desktop/src/main/features/attachment/attachment-service.test.ts`：证明抽取后安全边界不变。
- 修改 `apps/desktop/src/main/features/workspace/workspace-service.ts`：增加图片分支、50 MB 门和读取后大小复核。
- 修改 `apps/desktop/src/main/features/workspace/workspace-service.test.ts`：覆盖合法图片、边界、伪装图片、SVG、文本回归和 extra-root。
- 修改 `apps/desktop/src/renderer/src/components/desktop/tools/file-viewer-model.ts`：集中管理文件 tab 类型分类。
- 修改 `apps/desktop/src/renderer/src/components/desktop/tools/file-viewer-model.test.ts`：覆盖图片与原有类型分类。
- 创建 `apps/desktop/src/renderer/src/components/desktop/tools/file-image-preview.tsx`：创建/撤销 Blob URL，并渲染自适应图片和解码失败占位。
- 创建 `apps/desktop/src/renderer/src/components/desktop/tools/file-image-preview.test.tsx`：覆盖 Blob、URL 生命周期、布局和失败回退。
- 修改 `apps/desktop/src/renderer/src/components/desktop/tools/file-viewer.tsx`：增加 `image` tab 分支和 Main 失败状态文案。
- 修改 `apps/desktop/src/renderer/src/components/desktop/tools/file-viewer.test.ts`：补齐新增必填字段并保留 tab 合并回归。
- 修改 `apps/desktop/src/renderer/src/components/desktop/tools/files-tool.tsx`：调用集中分类函数，不重复判断安全格式。
- 修改 `docs/superpowers/specs/2026-09-13-file-tab-image-preview-design.md`：实现完成后把状态改为“已实现”，补充验证证据。

## 任务 1：抽取安全位图识别并保持附件行为

**文件：**
- 创建：`apps/desktop/src/shared/safe-image-preview.ts`
- 测试：`apps/desktop/src/shared/safe-image-preview.test.ts`
- 修改：`apps/desktop/src/main/features/attachment/attachment-service.ts`
- 测试：`apps/desktop/src/main/features/attachment/attachment-service.test.ts`

- [ ] **步骤 1：先写共享函数失败测试**

测试公开两个入口：

```ts
import { describe, expect, it } from "vitest"

import {
  safeImageMediaTypeFromName,
  validateSafeImageBytes,
} from "./safe-image-preview"

describe("safe image preview", () => {
  it.each([
    ["a.png", "image/png"],
    ["a.jpg", "image/jpeg"],
    ["a.jpeg", "image/jpeg"],
    ["a.gif", "image/gif"],
    ["a.webp", "image/webp"],
    ["a.bmp", "image/bmp"],
    ["a.avif", "image/avif"],
  ])("maps %s to %s", (name, mediaType) => {
    expect(safeImageMediaTypeFromName(name)).toBe(mediaType)
  })

  it("does not classify SVG or ICO as a safe bitmap", () => {
    expect(safeImageMediaTypeFromName("active.svg")).toBeNull()
    expect(safeImageMediaTypeFromName("icon.ico")).toBeNull()
  })

  it("accepts a matching PNG signature and rejects active content", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const svg = new TextEncoder().encode('<svg onload="alert(1)"></svg>')

    expect(validateSafeImageBytes(png, "image/png")).toBe("image/png")
    expect(validateSafeImageBytes(svg, "image/png")).toBeNull()
  })
})
```

同一文件补齐 JPEG、GIF87a/GIF89a、WebP、BMP、AVIF 的最小签名样本，并验证扩展名匹配大小写不敏感。

- [ ] **步骤 2：运行共享测试，确认因模块不存在而失败**

运行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/shared/safe-image-preview.test.ts
```

预期：FAIL，提示无法解析 `./safe-image-preview`。

- [ ] **步骤 3：实现最小共享安全函数**

定义受限 MIME 联合类型，避免调用方传入任意字符串：

```ts
export type SafeImageMediaType =
  | "image/avif"
  | "image/bmp"
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp"

export function safeImageMediaTypeFromName(name: string): SafeImageMediaType | null

export function validateSafeImageBytes(
  bytes: Uint8Array,
  expectedMediaType: SafeImageMediaType
): SafeImageMediaType | null
```

`safeImageMediaTypeFromName` 只接受设计中的七个扩展名；`validateSafeImageBytes` 搬入附件服务现有签名规则，并保留所有长度检查。

- [ ] **步骤 4：运行共享测试确认通过**

运行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/shared/safe-image-preview.test.ts
```

预期：共享安全函数测试全部通过。

- [ ] **步骤 5：先补附件回归断言**

在 `attachment-service.test.ts` 的安全位图测试中增加至少一个 JPEG 或 WebP 成功样本，并保留以下已有断言：

- 非图片 MIME 不发起下载；
- SVG/HTML 字节伪装为安全 MIME 时拒绝；
- 超过附件自身上限时不发起下载。

- [ ] **步骤 6：让附件服务改用共享校验**

在 `attachment-service.ts`：

- 用 `SafeImageMediaType` 约束 `SAFE_PREVIEW_MEDIA_TYPES`；
- `readPreview` 在集合判断后调用 `validateSafeImageBytes`；
- 删除文件内的 `hasExpectedBitmapSignature`、`startsWithBytes`、`startsWithAscii`、`asciiAt`；
- 保留 `readResponseBytes`、`exactArrayBuffer` 和附件预览大小计算原样。

- [ ] **步骤 7：运行共享与附件测试**

运行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/shared/safe-image-preview.test.ts src/main/features/attachment/attachment-service.test.ts
```

预期：全部通过；附件 10 MB 行为没有改成文件 tab 的 50 MB。

- [ ] **步骤 8：提交本任务**

```powershell
git add apps/desktop/src/shared/safe-image-preview.ts apps/desktop/src/shared/safe-image-preview.test.ts apps/desktop/src/main/features/attachment/attachment-service.ts apps/desktop/src/main/features/attachment/attachment-service.test.ts
git commit -m "refactor(desktop): share safe image validation"
```

## 任务 2：扩展 Workspace 读取契约和 50 MB 图片门

**文件：**
- 修改：`apps/desktop/src/shared/workspace-types.ts`
- 修改：`apps/desktop/src/main/features/workspace/workspace-service.ts`
- 测试：`apps/desktop/src/main/features/workspace/workspace-service.test.ts`

- [ ] **步骤 1：先扩展测试辅助函数并写失败测试**

在 `workspace-service.test.ts` 增加位图字节和临时文件辅助函数：

```ts
function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
}

function bytesOf(buffer: ArrayBuffer | null): number[] | null {
  return buffer ? [...new Uint8Array(buffer)] : null
}
```

新增用例并断言完整字段组合：

```ts
it("returns validated PNG bytes for file tab preview", async () => {
  const rootPath = await createTemporaryDirectory()
  await writeFile(join(rootPath, "image.png"), pngBytes())

  const result = await workspaceService.readFile({ rootPath, path: "image.png" })

  expect(result).toMatchObject({
    binary: true,
    content: null,
    mediaType: "image/png",
    imagePreviewError: null,
  })
  expect(bytesOf(result.previewBytes)).toEqual([...pngBytes()])
})
```

继续增加：

- `.png` 中是 SVG/HTML 字节：`previewBytes: null`、`mediaType: null`、`imagePreviewError: "image_unsupported"`；
- `.svg` 仍返回文本，三个新增字段均为 `null`；
- 普通文本结果新增字段均为 `null`；
- extra-root 内合法 PNG 返回图片字节。

- [ ] **步骤 2：运行 Workspace 测试，确认类型或断言失败**

运行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/main/features/workspace/workspace-service.test.ts
```

预期：FAIL，返回结果没有图片字段。

- [ ] **步骤 3：增加共享结果契约**

在 `workspace-types.ts` 增加：

```ts
export type WorkspaceImagePreviewError = "image_too_large" | "image_unsupported"

export interface WorkspaceReadFileResult {
  // 保留现有字段
  previewBytes: ArrayBuffer | null
  mediaType: SafeImageMediaType | null
  imagePreviewError: WorkspaceImagePreviewError | null
}
```

从 `safe-image-preview.ts` 导入 `SafeImageMediaType`。这些字段保持必填，所有返回分支必须明确构造。

- [ ] **步骤 4：实现图片读取分支**

在 `workspace-service.ts` 定义：

```ts
const maxTextFileBytes = 1_250_000
export const maxImagePreviewBytes = 50 * 1024 * 1024
```

`readFile` 的顺序改为：

1. `resolveAllowedFile`、`stat`、普通文件检查；
2. `safeImageMediaTypeFromName(resolved.absolutePath)`；
3. 候选图片大于 `maxImagePreviewBytes` 时，不调用 `readFile`，返回 `image_too_large`；
4. 候选图片读取后再次检查 `buffer.byteLength`；
5. 调用 `validateSafeImageBytes`，失败返回 `image_unsupported`；
6. 通过时返回精确长度的 `ArrayBuffer`；
7. 非候选图片才应用原有 1.25 MB 门与文本/二进制逻辑。

将 `toReadResult` 改为接收一个图片字段对象，或建立以下三个小构造函数，确保没有非法字段组合：

```ts
toTextReadResult(...)
toImageReadResult(...)
toImageFailureResult(...)
```

复制 Buffer 内容到新 `Uint8Array` 后返回其 `.buffer`，不能直接返回 Node `Buffer.buffer`，避免把底层池中多余字节带进 IPC。

- [ ] **步骤 5：运行 Workspace 测试确认基础图片流程通过**

运行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/main/features/workspace/workspace-service.test.ts
```

预期：合法图片、伪装图片、SVG、文本和 extra-root 用例通过。

- [ ] **步骤 6：补 50 MB 边界失败测试**

使用 `node:fs/promises` 的 `open` 与 `truncate` 创建稀疏临时文件：

```ts
async function createSizedPng(path: string, size: number): Promise<void> {
  const handle = await open(path, "w")
  try {
    await handle.write(pngBytes(), 0, pngBytes().byteLength, 0)
    await handle.truncate(size)
  } finally {
    await handle.close()
  }
}
```

分别验证：

- `maxImagePreviewBytes + 1`：不返回字节，错误为 `image_too_large`；
- `maxImagePreviewBytes`：允许走图片读取并通过签名校验。

边界用例设置合理的单测超时。测试结束继续由现有临时目录清理释放文件。

- [ ] **步骤 7：运行 Workspace 边界测试确认通过**

运行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/main/features/workspace/workspace-service.test.ts
```

预期：50 MB 等于边界成功，大于边界失败，文本 1.25 MB 行为不变。

- [ ] **步骤 8：运行 Node 类型检查**

运行：

```powershell
pnpm --filter @vykor/desktop typecheck:node
```

预期：通过。

- [ ] **步骤 9：提交本任务**

```powershell
git add apps/desktop/src/shared/workspace-types.ts apps/desktop/src/main/features/workspace/workspace-service.ts apps/desktop/src/main/features/workspace/workspace-service.test.ts
git commit -m "feat(desktop): return safe workspace image previews"
```

## 任务 3：集中分类文件 tab 类型

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/file-viewer.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/file-viewer-model.ts`
- 测试：`apps/desktop/src/renderer/src/components/desktop/tools/file-viewer-model.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/files-tool.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/file-viewer.test.ts`

- [ ] **步骤 1：先写分类失败测试**

在 `file-viewer-model.test.ts` 为测试结果建立完整工厂：

```ts
function preview(
  overrides: Partial<WorkspaceReadFileResult> = {}
): WorkspaceReadFileResult {
  return {
    path: "file.ts",
    name: "file.ts",
    language: "typescript",
    size: 4,
    binary: false,
    content: "code",
    scope: "project",
    relativePath: "file.ts",
    rootLabel: "",
    previewBytes: null,
    mediaType: null,
    imagePreviewError: null,
    ...overrides,
  }
}
```

新增断言：

```ts
expect(
  fileViewerTypeForPreview(
    preview({
      path: "a.png",
      name: "a.png",
      binary: true,
      content: null,
      previewBytes: new Uint8Array([1]).buffer,
      mediaType: "image/png",
    })
  )
).toBe("image")
```

同时覆盖：

- 只有字节或只有 MIME：`document`；
- `image_too_large` / `image_unsupported`：`document`；
- Markdown：`markdown`；
- PDF、Office、普通二进制：`document`；
- TypeScript：`code`。

- [ ] **步骤 2：运行模型测试确认失败**

运行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/tools/file-viewer-model.test.ts
```

预期：FAIL，`fileViewerTypeForPreview` 尚不存在且 `image` 还不在联合类型中。

- [ ] **步骤 3：实现集中分类**

把 `FileViewerTab["type"]` 扩展为：

```ts
type: "code" | "document" | "image" | "markdown"
```

在 `file-viewer-model.ts` 增加 `fileViewerTypeForPreview(preview)`，严格按以下顺序返回：

1. `previewBytes !== null && mediaType !== null` → `image`；
2. Markdown 路径 → `markdown`；
3. `binary`、`content === null`、PDF/Office 扩展 → `document`；
4. 其他 → `code`。

在 `files-tool.tsx` 的 `toFileViewerTab` 中调用该函数，删除本地 `isDocumentFile`，不在 Renderer 重复安全格式判断。

- [ ] **步骤 4：补齐所有结果工厂的新增必填字段**

更新 `file-viewer.test.ts` 和搜索到的其他 `WorkspaceReadFileResult` 字面量，统一补：

```ts
previewBytes: null,
mediaType: null,
imagePreviewError: null,
```

不要把契约字段改成可选来绕过测试工厂。

- [ ] **步骤 5：运行分类和 tab 合并测试**

运行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/tools/file-viewer-model.test.ts src/renderer/src/components/desktop/tools/file-viewer.test.ts
```

预期：新分类和原有 tab 合并用例全部通过。

- [ ] **步骤 6：提交本任务**

```powershell
git add apps/desktop/src/renderer/src/components/desktop/tools/file-viewer.tsx apps/desktop/src/renderer/src/components/desktop/tools/file-viewer-model.ts apps/desktop/src/renderer/src/components/desktop/tools/file-viewer-model.test.ts apps/desktop/src/renderer/src/components/desktop/tools/files-tool.tsx apps/desktop/src/renderer/src/components/desktop/tools/file-viewer.test.ts
git commit -m "refactor(desktop): classify image file tabs"
```

## 任务 4：渲染图片并管理 Blob URL 生命周期

**文件：**
- 创建：`apps/desktop/src/renderer/src/components/desktop/tools/file-image-preview.tsx`
- 测试：`apps/desktop/src/renderer/src/components/desktop/tools/file-image-preview.test.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/file-viewer.tsx`

- [ ] **步骤 1：先写图片组件失败测试**

测试文件使用 `// @vitest-environment jsdom`，按项目现有 React 19 测试模式创建 root，并在 `beforeEach` 中模拟：

```ts
Object.defineProperty(URL, "createObjectURL", {
  configurable: true,
  value: vi.fn((blob: Blob) => `blob:${blob.type}:${blob.size}`),
})
Object.defineProperty(URL, "revokeObjectURL", {
  configurable: true,
  value: vi.fn(),
})
```

覆盖：

1. `new Uint8Array([1, 2, 3]).buffer` 与 `image/png` 产生 `blob:image/png:3`；
2. `<img alt="preview.png">` 且类名包含 `object-contain`、`max-h-full`、`max-w-full`；
3. 重新渲染不同字节时撤销旧 URL；
4. root 卸载时撤销当前 URL；
5. 图片触发 `error` 时撤销 URL，并显示“无法显示这张图片。”。

- [ ] **步骤 2：运行组件测试确认失败**

运行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/tools/file-image-preview.test.tsx
```

预期：FAIL，组件模块不存在。

- [ ] **步骤 3：实现 `FileImagePreview`**

组件接口固定为：

```ts
type FileImagePreviewProps = {
  bytes: ArrayBuffer
  mediaType: SafeImageMediaType
  name: string
}
```

实现要求：

- `useEffect` 根据 `bytes` 和 `mediaType` 创建 URL；
- effect cleanup 总是撤销本次创建的 URL；
- 解码失败状态按当前 URL 重置，新图片不能继承旧图片的失败状态；
- 外层 `flex h-full min-h-0 items-center justify-center overflow-auto bg-muted/30 p-4`；
- 图片使用 `max-h-full max-w-full object-contain`；
- 失败占位使用 `DesktopEmptyState` 和 `FileImage` 图标，标题为文件名。

- [ ] **步骤 4：运行组件测试确认通过**

运行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/tools/file-image-preview.test.tsx
```

预期：Blob URL、布局和生命周期测试全部通过。

- [ ] **步骤 5：把图片和 Main 失败状态接入 `FileViewer`**

在 `FileViewer` 的渲染分支中保持 loading 最高优先级，然后：

```tsx
activeTab?.type === "image" &&
activeTab.preview.previewBytes &&
activeTab.preview.mediaType ? (
  <FileImagePreview
    bytes={activeTab.preview.previewBytes}
    mediaType={activeTab.preview.mediaType}
    name={activeTab.preview.name}
  />
) : activeTab?.type === "document" ? (
  <DocumentPlaceholder preview={activeTab.preview} />
)
```

`DocumentPlaceholder` 根据 `imagePreviewError` 映射：

```ts
image_too_large   -> "图片超过 50 MB，无法直接预览。"
image_unsupported -> "无法安全预览这张图片。"
null              -> "这类文件的预览后续接入，这里先保留标签页占位。"
```

不要让图片进入 `VirtualizedCodePreview`，不要改 Markdown 切换、文件搜索和 HTML 浏览器按钮逻辑。

- [ ] **步骤 6：运行 Renderer 定向测试**

运行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/tools/file-image-preview.test.tsx src/renderer/src/components/desktop/tools/file-viewer-model.test.ts src/renderer/src/components/desktop/tools/file-viewer.test.ts src/renderer/src/renderer-security-policy.test.ts
```

预期：全部通过，CSP 继续允许 `blob:` 且拒绝远程图片源。

- [ ] **步骤 7：运行 Web 类型检查**

运行：

```powershell
pnpm --filter @vykor/desktop typecheck:web
```

预期：通过。

- [ ] **步骤 8：提交本任务**

```powershell
git add apps/desktop/src/renderer/src/components/desktop/tools/file-image-preview.tsx apps/desktop/src/renderer/src/components/desktop/tools/file-image-preview.test.tsx apps/desktop/src/renderer/src/components/desktop/tools/file-viewer.tsx
git commit -m "feat(desktop): preview images in file tabs"
```

## 任务 5：完成整体回归与文档收尾

**文件：**
- 修改：`docs/superpowers/specs/2026-09-13-file-tab-image-preview-design.md`
- 验证：本计划涉及的全部 Desktop 文件

- [ ] **步骤 1：运行完整定向测试**

运行：

```powershell
pnpm --filter @vykor/desktop exec vitest run src/shared/safe-image-preview.test.ts src/main/features/attachment/attachment-service.test.ts src/main/features/workspace/workspace-service.test.ts src/renderer/src/components/desktop/tools/file-viewer-model.test.ts src/renderer/src/components/desktop/tools/file-image-preview.test.tsx src/renderer/src/components/desktop/tools/file-viewer.test.ts src/renderer/src/renderer-security-policy.test.ts
```

预期：全部通过，0 个失败。

- [ ] **步骤 2：运行 Desktop 双端类型检查**

运行：

```powershell
pnpm --filter @vykor/desktop typecheck
```

预期：Node 与 Web 类型检查都通过。

- [ ] **步骤 3：运行改动文件 lint**

运行：

```powershell
pnpm --filter @vykor/desktop exec eslint src/shared/safe-image-preview.ts src/shared/safe-image-preview.test.ts src/shared/workspace-types.ts src/main/features/attachment/attachment-service.ts src/main/features/attachment/attachment-service.test.ts src/main/features/workspace/workspace-service.ts src/main/features/workspace/workspace-service.test.ts src/renderer/src/components/desktop/tools/file-viewer.tsx src/renderer/src/components/desktop/tools/file-viewer-model.ts src/renderer/src/components/desktop/tools/file-viewer-model.test.ts src/renderer/src/components/desktop/tools/file-image-preview.tsx src/renderer/src/components/desktop/tools/file-image-preview.test.tsx src/renderer/src/components/desktop/tools/files-tool.tsx src/renderer/src/components/desktop/tools/file-viewer.test.ts
```

预期：0 error。

- [ ] **步骤 4：做一次 Desktop 人工验收**

运行：

```powershell
pnpm --filter @vykor/desktop dev
```

检查：

- 文件树打开 PNG/JPEG/GIF/WebP/BMP/AVIF 后在右侧完整居中显示；
- 透明图片在 muted 背景上可辨认；
- 快速切换图片、源码和 Markdown 不出现旧图闪回；
- 关闭并恢复图片 tab 后重新读取成功；
- 大于 50 MB、伪装 PNG 和普通 PDF 分别显示正确占位；
- 图片 tab 上 `Ctrl+F` 不打开搜索，Markdown 切换按钮不出现；
- extra-root 图片与项目内图片显示一致。

停止开发进程后继续。

- [ ] **步骤 5：更新规格状态和验证证据**

把设计文档状态改为：

```markdown
> 状态：已实现（2026-09-13）。
```

在文档开头增加“实现结果与验证证据”，记录实际通过的测试文件、测试数量、类型检查和人工验收结果。只能写本轮命令真实输出，不预填成功数字。

- [ ] **步骤 6：运行文档与空白检查**

运行：

```powershell
pnpm check-docs
git diff --check
```

预期：文档检查通过，`git diff --check` 无输出。

- [ ] **步骤 7：请求代码审查**

使用 `requesting-code-review` 技能，要求审查者对照本设计重点检查：

- 50 MB 与 1.25 MB 两道大小门是否顺序正确；
- 文件头校验是否在 Main 且附件安全边界未退化；
- IPC 是否只传精确图片字节；
- Blob URL 是否在输入变化和卸载时撤销；
- 是否误开放 SVG、`file://` 或远程图片。

修复所有必须修复项，并重新运行受影响的验证命令。

- [ ] **步骤 8：提交文档与审查修复**

```powershell
git add docs/superpowers/specs/2026-09-13-file-tab-image-preview-design.md
git commit -m "docs: record file tab image preview verification"
```

提交前用 `git status --short` 确认没有把用户现有的其他未提交文件带入提交。
