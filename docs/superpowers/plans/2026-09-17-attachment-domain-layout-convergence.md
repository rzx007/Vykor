# Attachment 领域目录收敛实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。
>
> **完成记录：** 任务 1–4 已在 `codex/attachment-domain-convergence` 落地：
> `e6c05146` `f165a8f8` `5a0b3c76` `e3ebcef9`。任务 5 提交本门禁与文档。

**目标：** 将 Attachment 在 Services、Server 和 Desktop 中的多个并列入口收敛为每层一个领域根目录，并把应用编排从 Services 迁回 Server，同时保持协议、数据库、HTTP、IPC 和用户行为不变。

**架构：** Services 的 `attachments/` 只保留 persistence、storage、processing、content 等基础能力；Server 的 `application/attachments/` 统一拥有应用服务、routing、resources 和 tools；Desktop 继续使用 `features/attachment/`，但把上传生命周期与本地文件操作从门面服务中拆开。旧路径、旧类名和转发导出全部删除，不提供兼容层。

**技术栈：** TypeScript、Vitest、Node.js、pnpm workspace、SQLite/better-sqlite3、Electron、现有架构边界脚本。

---

## 文件结构

### Services 最终结构

```text
packages/services/src/attachments/
├── index.ts
├── attachment-errors.ts
├── content/
│   ├── attachment-text.ts
│   └── __test__/attachment-text.test.ts
├── persistence/
│   ├── attachment-records.ts
│   ├── attachment-repository.ts
│   ├── attachment-transactions.ts
│   └── attachment-transactions.test.ts
├── processing/
│   ├── image-normalizer.ts
│   ├── light-ocr-engine.ts
│   ├── local-ocr-errors.ts
│   ├── local-ocr-service.ts
│   └── __test__/*
└── storage/
    ├── attachment-blob-store.ts
    ├── attachment-filename.ts
    ├── attachment-integrity-service.ts
    ├── attachment-media-type.ts
    ├── attachment-storage-operation-gate.ts
    └── __test__/*
```

删除：

- `packages/services/src/attachment/`
- `packages/services/src/attachment-processing/`

### Server 最终结构

```text
packages/server/src/application/attachments/
├── attachment-service.ts
├── __test__/attachment-service.test.ts
├── resources/
│   ├── compact-attachment-catalog.ts
│   ├── session-attachment-resources.ts
│   └── __test__/*
├── routing/
│   ├── attachment-capabilities.ts
│   ├── attachment-capability-router.ts
│   ├── attachment-routing-types.ts
│   └── __test__/*
└── tools/
    ├── attachment-access.ts
    ├── attachment-read-tool.ts
    ├── attachment-uri.ts
    └── __test__/*

packages/server/src/application/visual-tools/
└── remote-image-source.ts
```

删除：

- `packages/server/src/application/attachment-processing/`
- `packages/server/src/application/attachment-resource/`
- `packages/server/src/application/attachment-routing/`
- `packages/server/src/application/attachment-tools/`

### Desktop 最终结构

```text
apps/desktop/src/main/features/attachment/
├── attachment-service.ts
├── attachment-upload-service.ts
├── attachment-file-service.ts
├── ipc.ts
├── attachment-service.test.ts
├── attachment-upload-service.test.ts
├── attachment-file-service.test.ts
└── ipc.test.ts
```

## 执行约束

- 这是纯重构：不得修改协议、migration、数据库表、HTTP path、IPC channel 或稳定错误码。
- 不创建旧路径转发文件，不保留 `AttachmentApplicationService` alias。
- 文件移动使用 `git mv`，随后用 `apply_patch` 修改内容和导入。
- 按任务完成代码迁移，任务 5 再统一运行测试；中间只做负向搜索、`git diff --check` 和必要的定向类型检查，避免重复运行大测试集。
- 主工作区的未跟踪文件不属于本任务，不得加入提交。

## 任务 1：把 Attachment 应用服务迁回 Server

**文件：**

- 创建：`packages/server/src/application/attachments/attachment-service.ts`
- 创建：`packages/server/src/application/attachments/__test__/attachment-service.test.ts`
- 删除：`packages/services/src/attachment/attachment-application-service.ts`
- 删除：`packages/services/src/attachment/__test__/attachment-application-service.test.ts`
- 修改：`packages/services/src/attachment/index.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/http/server.ts`
- 修改：`packages/server/src/http/routes/attachment.ts`
- 修改：`packages/server/src/application/attachment-resource/session-attachment-resources.ts`
- 修改：`packages/server/src/application/attachment-tools/attachment-access.ts`
- 修改：`packages/server/src/application/session/session-run-executor-assembly.ts`
- 修改：`packages/server/src/application/visual-tools/daemon-image-generation-tool.ts`
- 修改：`packages/server/src/application/__test__/durable-agent-application.test.ts`
- 修改：`packages/server/src/application/attachment-resource/__test__/session-attachment-resources.test.ts`

- [ ] **步骤 1：移动实现和测试并立即更名**

运行：

```powershell
New-Item -ItemType Directory -Force packages/server/src/application/attachments/__test__
git mv packages/services/src/attachment/attachment-application-service.ts packages/server/src/application/attachments/attachment-service.ts
git mv packages/services/src/attachment/__test__/attachment-application-service.test.ts packages/server/src/application/attachments/__test__/attachment-service.test.ts
```

在新实现中执行以下准确变更：

```ts
// 从 @vykor/services 获取基础能力，而不是深度导入 Services 源文件。
import {
  AttachmentBlobStore,
  AttachmentError,
  AttachmentStorageOperationGate,
  decodeAttachmentText,
  isAttachmentError,
  type AttachmentBlobRange,
  type AttachmentTextEncoding,
  type AttachmentTransactions,
} from "@vykor/services";

export interface AttachmentServiceOptions { /* 保留原字段和窄 store Pick */ }
export class AttachmentService { /* 保留原方法与执行顺序 */ }
```

把原来的 `AttachmentApplicationServiceOptions`、`AttachmentApplicationService` 分别更名为 `AttachmentServiceOptions`、`AttachmentService`。其他公开 input/result 类型名保持不变。

- [ ] **步骤 2：更新 Server 组合根与窄消费者**

所有 Server 文件从 `./attachments/attachment-service.js` 或相应相对路径导入 `AttachmentService`。具体替换：

```text
AttachmentApplicationService -> AttachmentService
AttachmentApplicationServiceOptions -> AttachmentServiceOptions
attachmentApplication: Pick<AttachmentApplicationService, ...>
-> attachmentService: Pick<AttachmentService, ...>
```

`DaemonApplication` 的公共属性仍命名为 `attachments`，构造逻辑改成：

```ts
this.attachments = options.attachments ?? new AttachmentService({
  store: this.store.attachments,
  blobs: attachmentBlobs,
  limits: options.attachmentLimits,
});
```

`DaemonApplicationOptions.attachments`、HTTP server options 和 route factory 参数类型全部改为 `AttachmentService`，不要改变运行时字段名、路由或方法调用。

- [ ] **步骤 3：更新测试导入和构造器名称**

新测试从 `../attachment-service.js` 导入 `AttachmentService`；仍从 `@vykor/services` 导入 `AttachmentBlobStore` 和 `SessionStore`。Server 其他测试只替换类名和导入位置，不修改断言。

- [ ] **步骤 4：删除 Services 的应用服务导出并做静态检查**

从 `packages/services/src/attachment/index.ts` 删除：

```ts
export * from "./attachment-application-service.js";
```

运行：

```powershell
rg -n "AttachmentApplicationService|attachment-application-service" packages apps scripts
git diff --check
```

预期：第一条无匹配；第二条退出码为 0。

- [ ] **步骤 5：提交任务 1**

```powershell
git add packages/services/src/attachment packages/server/src/application packages/server/src/http
git commit -m "refactor(server): own attachment application service"
```

## 任务 2：把 Services 收敛到唯一 `attachments/` 领域根

**文件：**

- 移动：`packages/services/src/attachments/attachment-*.ts`
- 移动：`packages/services/src/attachment/attachment-*.ts`
- 移动：`packages/services/src/attachment-processing/*.ts`
- 修改：`packages/services/src/attachments/index.ts`
- 修改：`packages/services/src/index.ts`
- 修改：`packages/services/src/session-runtime/store.ts`
- 修改：`packages/services/src/session-runtime/prompt-attachments.ts`
- 修改：`packages/services/src/conversations/conversation-transactions.ts`

- [ ] **步骤 1：建立四个职责目录并移动 persistence**

运行：

```powershell
New-Item -ItemType Directory -Force packages/services/src/attachments/persistence
New-Item -ItemType Directory -Force packages/services/src/attachments/storage/__test__
New-Item -ItemType Directory -Force packages/services/src/attachments/content/__test__
New-Item -ItemType Directory -Force packages/services/src/attachments/processing/__test__
git mv packages/services/src/attachments/attachment-records.ts packages/services/src/attachments/persistence/attachment-records.ts
git mv packages/services/src/attachments/attachment-repository.ts packages/services/src/attachments/persistence/attachment-repository.ts
git mv packages/services/src/attachments/attachment-transactions.ts packages/services/src/attachments/persistence/attachment-transactions.ts
git mv packages/services/src/attachments/attachment-transactions.test.ts packages/services/src/attachments/persistence/attachment-transactions.test.ts
```

修正 persistence 内部相对导入：错误类型使用 `../attachment-errors.js`，同目录 records/repository 继续使用 `./...js`。

- [ ] **步骤 2：移动 storage、content 和测试**

运行精确的 `git mv`：

```powershell
git mv packages/services/src/attachment/attachment-errors.ts packages/services/src/attachments/attachment-errors.ts
git mv packages/services/src/attachment/attachment-text.ts packages/services/src/attachments/content/attachment-text.ts
git mv packages/services/src/attachment/__test__/attachment-text.test.ts packages/services/src/attachments/content/__test__/attachment-text.test.ts
git mv packages/services/src/attachment/attachment-blob-store.ts packages/services/src/attachments/storage/attachment-blob-store.ts
git mv packages/services/src/attachment/attachment-filename.ts packages/services/src/attachments/storage/attachment-filename.ts
git mv packages/services/src/attachment/attachment-integrity-service.ts packages/services/src/attachments/storage/attachment-integrity-service.ts
git mv packages/services/src/attachment/attachment-media-type.ts packages/services/src/attachments/storage/attachment-media-type.ts
git mv packages/services/src/attachment/attachment-storage-operation-gate.ts packages/services/src/attachments/storage/attachment-storage-operation-gate.ts
git mv packages/services/src/attachment/__test__/attachment-blob-store.test.ts packages/services/src/attachments/storage/__test__/attachment-blob-store.test.ts
git mv packages/services/src/attachment/__test__/attachment-integrity-service.test.ts packages/services/src/attachments/storage/__test__/attachment-integrity-service.test.ts
git mv packages/services/src/attachment/__test__/attachment-media-type.test.ts packages/services/src/attachments/storage/__test__/attachment-media-type.test.ts
git mv packages/services/src/attachment/__test__/attachment-storage-operation-gate.test.ts packages/services/src/attachments/storage/__test__/attachment-storage-operation-gate.test.ts
```

`attachment-filename.ts`、`attachment-blob-store.ts` 从 `../attachment-errors.js` 导入错误；storage 内彼此引用仍使用同目录相对路径。`attachment-integrity-service.ts` 的测试不得反向依赖 Server。将原 fixture 中的 `attachments.import()` 替换为本地辅助函数：

```ts
async function importReadyAttachment(
  store: SessionStore,
  blobs: AttachmentBlobStore,
  id: string,
  displayName: string,
  value: string,
) {
  store.attachments.createImportingAttachment({
    id,
    displayName,
    stagingName: `${id}.part`,
    createdAt: 1,
  });
  const imported = await blobs.import({
    uploadId: id,
    content: content(value),
    maxBytes: 1024 * 1024,
  });
  return store.attachments.markAttachmentReady(id, {
    sha256: imported.sha256,
    sizeBytes: imported.sizeBytes,
    mediaType: imported.mediaType,
    updatedAt: 2,
  });
}
```

各测试用固定 id 调用该函数，并删除 fixture 中的 `AttachmentApplicationService` 与 id 队列。

- [ ] **步骤 3：移动 processing 和测试**

```powershell
git mv packages/services/src/attachment-processing/image-normalizer.ts packages/services/src/attachments/processing/image-normalizer.ts
git mv packages/services/src/attachment-processing/light-ocr-engine.ts packages/services/src/attachments/processing/light-ocr-engine.ts
git mv packages/services/src/attachment-processing/local-ocr-errors.ts packages/services/src/attachments/processing/local-ocr-errors.ts
git mv packages/services/src/attachment-processing/local-ocr-service.ts packages/services/src/attachments/processing/local-ocr-service.ts
git mv packages/services/src/attachment-processing/__test__/* packages/services/src/attachments/processing/__test__/
```

删除已经为空的旧目录。不要保留旧 `index.ts`。

- [ ] **步骤 4：建立唯一 barrel 并修正内部导入**

`packages/services/src/attachments/index.ts` 最终明确导出：

```ts
export * from "./attachment-errors.js";
export * from "./content/attachment-text.js";
export * from "./storage/attachment-blob-store.js";
export * from "./storage/attachment-filename.js";
export * from "./storage/attachment-integrity-service.js";
export * from "./storage/attachment-media-type.js";
export * from "./storage/attachment-storage-operation-gate.js";
export * from "./processing/image-normalizer.js";
export * from "./processing/light-ocr-engine.js";
export * from "./processing/local-ocr-errors.js";
export * from "./processing/local-ocr-service.js";
export * from "./persistence/attachment-records.js";
export { AttachmentRepository } from "./persistence/attachment-repository.js";
export {
  AttachmentTransactions,
  type AttachmentTransactionsOptions,
} from "./persistence/attachment-transactions.js";
```

`packages/services/src/index.ts` 只保留：

```ts
export * from "./attachments/index.js";
```

修正 `session-runtime/store.ts`、`prompt-attachments.ts`、`conversation-transactions.ts` 的相对路径，禁止引用旧目录。

- [ ] **步骤 5：执行旧路径负向搜索并提交**

```powershell
rg -n 'src/(attachment|attachment-processing)/|\.\./attachment/|\.\./attachment-processing/' packages apps scripts --glob '*.ts' --glob '*.tsx' --glob '*.mjs'
git diff --check
git add packages/services packages/server/src/application/attachments
git commit -m "refactor(services): converge attachment domain layout"
```

预期：搜索无匹配；提交包含 Services 移动及任务 1 新 Server service 因导入路径变化产生的必要调整。

## 任务 3：收敛 Server application 的 Attachment 目录

**文件：**

- 移动：`packages/server/src/application/attachment-resource/**`
- 移动：`packages/server/src/application/attachment-routing/**`
- 移动：`packages/server/src/application/attachment-tools/**`
- 移动并更名：`packages/server/src/application/attachment-processing/safe-remote-image.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/application/session/session-run-executor.ts`
- 修改：`packages/server/src/application/session/session-run-executor-assembly.ts`
- 修改：`packages/server/src/application/session/transcript-projection.ts`
- 修改：`packages/server/src/application/agent/agent-pool.ts`
- 修改：`packages/server/src/application/visual-tools/daemon-image-to-text-tool.ts`
- 修改：`packages/server/src/application/visual-tools/daemon-image-generation-tool.ts`
- 移动：`packages/server/src/application/attachment-resource/__test__/*`
- 移动：`packages/server/src/application/attachment-routing/__test__/*`
- 移动：`packages/server/src/application/attachment-tools/__test__/*`
- 移动并更名：`packages/server/src/application/attachment-processing/__test__/safe-remote-image.test.ts`

- [ ] **步骤 1：移动 resources、routing 和 tools**

```powershell
New-Item -ItemType Directory -Force packages/server/src/application/attachments/resources
New-Item -ItemType Directory -Force packages/server/src/application/attachments/routing
New-Item -ItemType Directory -Force packages/server/src/application/attachments/tools
git mv packages/server/src/application/attachment-resource/* packages/server/src/application/attachments/resources/
git mv packages/server/src/application/attachment-routing/* packages/server/src/application/attachments/routing/
git mv packages/server/src/application/attachment-tools/* packages/server/src/application/attachments/tools/
```

PowerShell 的 `*` 不会移动隐藏文件；这些目录当前只有已跟踪 TypeScript 文件和 `__test__`，移动后用 `git status --short` 核对所有文件均显示 rename。移除空旧目录。

- [ ] **步骤 2：修正 Server 内部导入**

采用以下唯一映射：

```text
application/attachment-resource/... -> application/attachments/resources/...
application/attachment-routing/...  -> application/attachments/routing/...
application/attachment-tools/...    -> application/attachments/tools/...
```

同一 `attachments/` 根内部优先使用相对导入，例如 resources 到 routing 使用 `../routing/attachment-routing-types.js`。其他 application 模块使用完整相对路径，不新增 Server application 的公共 barrel。

- [ ] **步骤 3：把远程图片来源移到 visual-tools**

```powershell
git mv packages/server/src/application/attachment-processing/safe-remote-image.ts packages/server/src/application/visual-tools/remote-image-source.ts
git mv packages/server/src/application/attachment-processing/__test__/safe-remote-image.test.ts packages/server/src/application/visual-tools/__test__/remote-image-source.test.ts
```

保留 `importRemoteImageSource`、`isPublicAddress` 和现有安全限制的行为；只更新文件名、测试描述和 `daemon-image-generation-tool.ts` 的导入：

```ts
import { importRemoteImageSource } from "./remote-image-source.js";
```

- [ ] **步骤 4：检查旧 Server 目录和深度导入**

```powershell
rg -n 'attachment-(processing|resource|routing|tools)' packages/server packages/services apps --glob '*.ts' --glob '*.tsx'
Get-ChildItem packages/server/src/application -Directory | Where-Object Name -Match '^attachment-'
git diff --check
```

预期：前两条无输出；diff 检查通过。

- [ ] **步骤 5：提交任务 3**

```powershell
git add packages/server
git commit -m "refactor(server): converge attachment application modules"
```

## 任务 4：拆分 Desktop Attachment 多职责服务

**文件：**

- 创建：`apps/desktop/src/main/features/attachment/attachment-upload-service.ts`
- 创建：`apps/desktop/src/main/features/attachment/attachment-file-service.ts`
- 创建：相应测试文件
- 修改：`apps/desktop/src/main/features/attachment/attachment-service.ts`
- 修改：`apps/desktop/src/main/features/attachment/attachment-service.test.ts`
- 修改：`apps/desktop/src/main/features/attachment/ipc.ts`
- 修改：`apps/desktop/src/main/features/attachment/ipc.test.ts`

- [ ] **步骤 1：提取上传生命周期服务**

`AttachmentUploadService` 移入并独占以下状态：

```ts
export class AttachmentUploadService {
  private readonly sources = new Map<string, SourceRecord>();
  private readonly tasks = new Map<string, UploadTask>();
  private readonly queue: UploadTask[] = [];
  private readonly failedSources = new Map<string, SourceRecord>();
  private readonly idleWaiters = new Set<() => void>();
  private running = 0;

  stagePaths(ownerId: number, paths: readonly string[]): Promise<DesktopAttachmentCandidate[]>;
  startUpload(ownerId: number, input: StartAttachmentUploadInput): Promise<{ taskId: string }>;
  uploadMemory(ownerId: number, input: UploadMemoryAttachmentInput): Promise<{ taskId: string }>;
  cancelUpload(ownerId: number, taskId: string): Promise<void>;
  retryUpload(ownerId: number, draftId: string, taskId: string): Promise<{ taskId: string }>;
  discardDraft(ownerId: number, draftId: string): Promise<void>;
  disposeOwner(ownerId: number): Promise<void>;
  whenIdle(): Promise<void>;
}
```

把 `stagePath`、`pumpQueue`、`runUpload`、`emit`、`resolveIdleIfNeeded`、`enqueue`、task/draft key 和上传错误转换一并移动。来源路径验证继续使用注入的 `AttachmentFileSystem`，不要改变 symlink、可读性、大小和 owner 检查顺序。

- [ ] **步骤 2：提取本地文件服务**

`AttachmentFileService` 拥有临时目录集合和以下方法：

```ts
export class AttachmentFileService {
  private readonly managedTemporaryDirectories = new Set<string>();

  readPreview(assetId: string): Promise<{ bytes: ArrayBuffer; mediaType: string }>;
  openAttachment(assetId: string): Promise<void>;
  saveAs(assetId: string): Promise<{ saved: boolean }>;
  cleanupTemporaryFiles(): Promise<void>;
}
```

同时移动安全预览 media type、限定大小读取、文件名清理、媒体类型推断、临时目录创建/回收和精确 `ArrayBuffer` 转换。它通过注入的 `getClient` 下载内容，不拥有上传队列。

- [ ] **步骤 3：把原服务改为薄门面**

`DesktopAttachmentService` 构造函数创建或接收两个子服务，公开方法按以下规则委派：

```ts
stagePaths/startUpload/uploadMemory/cancelUpload/retryUpload/discardDraft/disposeOwner/whenIdle
  -> AttachmentUploadService

readPreview/openAttachment/saveAs/cleanupTemporaryFiles
  -> AttachmentFileService

deleteUnreferenced/scanStorage/repairStorage/gcStorage
  -> getClient().attachments
```

`createAttachmentService()` 和 IPC 面向的 `DesktopAttachmentService` API 保持不变。不要让 IPC 同时持有三个服务。

- [ ] **步骤 4：按所有权移动测试而不改断言语义**

- 上传候选、token、队列、并发、取消、重试、owner 清理测试移到 `attachment-upload-service.test.ts`。
- 预览、打开、另存为、临时文件测试移到 `attachment-file-service.test.ts`。
- 门面测试只验证委派和远端 maintenance/delete。
- IPC 测试保持原 channel 与 payload 断言。

禁止通过删除断言来缩短测试；共享 fixture 可提取为 `__test__/attachment-test-fixtures.ts`，但仅在至少两个测试文件实际复用时创建。

- [ ] **步骤 5：做静态检查并提交**

```powershell
rg -n 'private readonly (sources|tasks|queue|failedSources|managedTemporaryDirectories)' apps/desktop/src/main/features/attachment/attachment-service.ts
git diff --check
git add apps/desktop/src/main/features/attachment
git commit -m "refactor(desktop): split attachment main-process services"
```

预期：第一条无匹配，说明门面不再拥有子服务状态；diff 检查通过。

## 任务 5：增加长期目录门禁并统一验证

**文件：**

- 修改：`scripts/architecture-boundaries.mjs`
- 修改：`scripts/architecture-boundaries.test.mjs`
- 修改：`docs/session-runtime-storage-architecture.md`
- 修改：`packages/services/README.md`
- 修改：`docs/superpowers/specs/2026-09-17-attachment-domain-layout-convergence-design.md`
- 修改：本计划的执行状态

- [ ] **步骤 1：为最终布局添加可测试的结构门禁**

在 `scripts/architecture-boundaries.mjs` 增加纯函数：

```js
export function checkAttachmentLayout(path, source) {
  const errors = [];
  const normalized = path.replaceAll("\\", "/");
  if (/packages\/services\/src\/(?:attachment|attachment-processing)(?:\/|$)/.test(normalized)) {
    errors.push(`${normalized} uses a retired Services attachment root`);
  }
  if (/packages\/server\/src\/application\/attachment-(?:processing|resource|routing|tools)(?:\/|$)/.test(normalized)) {
    errors.push(`${normalized} uses a retired Server attachment root`);
  }
  if (/\bAttachmentApplicationService\b/.test(source)) {
    errors.push("AttachmentApplicationService is retired; use Server AttachmentService");
  }
  return errors;
}
```

在 `architecture-boundaries.test.mjs` 添加测试，分别传入一个旧 Services 路径、一个旧 Server 路径和旧类名，断言对应错误；再传最终路径与 `AttachmentService`，断言返回空数组。

在 `collectArchitectureErrors()` 的现有生产源循环中对每个 `rel` 和 `content` 调用 `checkAttachmentLayout(rel, content)`。确保 `boundaryFiles` 额外包含整个 `packages/services/src/attachments`，不要扫描历史 `docs/superpowers`，历史计划必须保留当时路径。

- [ ] **步骤 2：更新当前文档，不改写历史材料**

在当前文档中记录：

- `packages/services/src/attachments/` 是唯一 Services Attachment 根。
- persistence、storage、processing、content 的放置规则。
- `packages/server/src/application/attachments/attachment-service.ts` 是应用用例入口。
- Client Resource 和 Desktop Feature 的位置。

把设计规格状态改为“已实施”，在计划顶部记录完成提交。不要批量替换 8 月和 9 月的历史计划路径。

- [ ] **步骤 3：运行全部定向测试**

```powershell
pnpm --filter @vykor/services exec vitest run src/attachments
pnpm --filter @vykor/server exec vitest run src/application/attachments src/application/visual-tools src/http/routes/attachment.test.ts src/application/__test__/durable-agent-application.test.ts
pnpm --filter @vykor/desktop exec vitest run src/main/features/attachment
node --test scripts/architecture-boundaries.test.mjs
```

预期：全部退出码为 0；测试数量以当时输出为准，不写死数量。

- [ ] **步骤 4：运行类型检查与仓库门禁**

```powershell
pnpm --filter @vykor/services check-types
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/desktop typecheck:node
node scripts/architecture-boundaries.mjs
node scripts/check-docs.mjs
git diff --check
```

预期：全部退出码为 0。若 pnpm 因 registry 或 launcher 环境失败，先修复依赖环境再继续，不把未运行描述为通过。

- [ ] **步骤 5：执行最终负向搜索**

```powershell
rg -n 'AttachmentApplicationService|packages/services/src/attachment/|packages/services/src/attachment-processing/|packages/server/src/application/attachment-(processing|resource|routing|tools)/' packages apps README.md docs/README.md docs/session-runtime-storage-architecture.md packages/services/README.md -g '!**/*.test.*' -g '!**/*.spec.*'
Get-ChildItem packages/services/src -Directory | Where-Object Name -Match '^attachment'
Get-ChildItem packages/server/src/application -Directory | Where-Object Name -Match '^attachment'
```

预期：第一条无匹配；Services 与 Server 各只列出一个 `attachments` 目录。历史 `docs/superpowers` 不纳入负向搜索。

- [ ] **步骤 6：提交最终门禁和文档**

```powershell
git add scripts/architecture-boundaries.mjs scripts/architecture-boundaries.test.mjs docs/session-runtime-storage-architecture.md packages/services/README.md docs/superpowers/specs/2026-09-17-attachment-domain-layout-convergence-design.md docs/superpowers/plans/2026-09-17-attachment-domain-layout-convergence.md
git commit -m "chore: guard attachment domain boundaries"
git status --short
```

预期：提交成功，工作区干净。

## 任务 6：独立审查与集成准备

**文件：**

- 复查：本计划涉及的所有文件
- 修订范围：审查发现问题时，只修改本计划已经列出的 Attachment 边界、导入、测试或文档文件

- [ ] **步骤 1：审查职责是否真正归位**

逐项确认：

- Services 不再导出或实现 daemon 应用用例。
- Server 只有一个 `application/attachments/` 根。
- `remote-image-source.ts` 只服务 visual tools。
- Desktop 门面不再持有上传队列或临时目录状态。
- 不存在旧类名 alias、旧路径 barrel 或兼容转发文件。

- [ ] **步骤 2：审查行为保持证据**

检查最终 diff，确认没有修改协议文件、migration、HTTP path、IPC channel 或错误码。重点比较移动前后的：

```text
AttachmentService import/delete/recovery 顺序
AttachmentIntegrityService scan/repair/gc 顺序
Desktop upload cancel/retry/owner cleanup 顺序
Desktop preview/open/save 临时文件清理顺序
```

- [ ] **步骤 3：在修订后重跑受影响检查**

仅重跑审查修订直接影响的定向测试，然后再次运行：

```powershell
node scripts/architecture-boundaries.mjs
node scripts/check-docs.mjs
git diff --check
git status --short
```

预期：全部通过且工作区干净，随后进入分支集成流程。
