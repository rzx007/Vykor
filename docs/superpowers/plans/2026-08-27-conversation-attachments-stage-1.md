# 对话附件阶段 1：资产、存储与基础 HTTP API 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 建立由 daemon 拥有的附件资产、内容寻址 Blob Store、流式上传、安全下载、逻辑删除和 Client SDK，为后续消息引用与 OCR 提供不会推翻的稳定底座。

**架构：** `SessionStore` 继续拥有同一 SQLite 数据库中的附件元数据，新的 `AttachmentBlobStore` 只管理数据库旁的不可变字节。`AttachmentApplicationService` 先创建 importing 记录，再把请求体流式写入 staging、计算 SHA-256 和检测 MIME，最后通过同文件系统 hard-link 原子发布 Blob 并把记录置为 ready。HTTP 层只处理协议与错误映射；公共 API 永不暴露磁盘路径或 storage key。

**技术栈：** TypeScript、Node.js 22/24 Web Streams、Node `crypto`/`fs`、SQLite/Drizzle、Hono、Vitest、pnpm workspace。

**执行状态：已完成（2026-08-28）。** 阶段 1 已落地到分支 `codex/conversation-attachments-stage-1`。最终验收覆盖 protocol 31、services 162、server 317、client 62，共 572 个测试；四包类型检查均为 exit 0，全仓库类型任务 57/57 通过，Drizzle migration 检查通过。公开能力为 `features.attachments: 1`，数据库 migration 为 `0013_attachments`，上传模式为 `POST /attachments` 原始请求体 + `X-Vykor-Filename`，capabilities 中公布 `uploadModes: ["single"]` 和实际 limits。

---

## 范围与固定决策

本计划只实现总路线的阶段 1。它不会接 Composer，不会把附件写入 `SessionInput`，不会执行 OCR，也不会引入 `@arcships/light-ocr`。OCR 依赖在阶段 5 引入，但阶段 1 产出的 asset ID、MIME、哈希、Blob 读取接口和限制配置就是它的输入。

固定协议如下：

```http
POST /attachments
Authorization: Bearer <token>
Content-Type: image/png
X-Vykor-Filename: screenshot.png

<raw file bytes>
```

`Content-Length` 是可选的提前校验信息；服务端始终以实际流式计数为准。阶段 1 的单文件上传可接收到 `maxBytesPerFile`，`resumableThresholdBytes` 只是后续 Client 选择传输方式的能力提示，阶段 8 再接入可恢复上传会话。上传成功返回 `201` 和公共 `AttachmentAssetRecord`。

阶段 1 的删除是逻辑删除：记录进入 `deleted`，读取接口返回 404，Blob 暂不物理删除。引用保护和 GC 分别在阶段 2、阶段 7 完成。

## 文件结构

### 新建

- `packages/protocol/src/attachment.ts`：公共 asset/reference/representation/limits 类型与运行时解析函数。
- `packages/protocol/src/attachment.test.ts`：附件限制与公共记录解析测试。
- `packages/services/src/session-runtime/migrations/0013_attachments.sql`：附件资产表和索引。
- `packages/services/src/attachment/attachment-errors.ts`：稳定应用错误码及 HTTP 可映射错误类。
- `packages/services/src/attachment/attachment-media-type.ts`：有限、确定的 magic-byte MIME 检测。
- `packages/services/src/attachment/attachment-filename.ts`：文件名解码、规范化和安全下载名。
- `packages/services/src/attachment/attachment-blob-store.ts`：staging、流式哈希、内容寻址发布、Range 读取和恢复。
- `packages/services/src/attachment/attachment-application-service.ts`：数据库状态机与 Blob Store 编排。
- `packages/services/src/attachment/index.ts`：服务包公共导出。
- `packages/services/src/attachment/__test__/attachment-media-type.test.ts`：签名检测和 MIME 欺骗测试。
- `packages/services/src/attachment/__test__/attachment-blob-store.test.ts`：去重、超限、中断、Range 和 staging 测试。
- `packages/services/src/attachment/__test__/attachment-application-service.test.ts`：importing/ready/failed/deleted 与启动恢复测试。
- `packages/server/src/http/routes/attachment.ts`：上传、元数据、内容和删除路由。
- `packages/server/src/http/routes/attachment.test.ts`：路由协议、鉴权外的 route contract、Range/ETag/Content-Disposition 测试。

### 修改

- `packages/protocol/src/index.ts`：导出附件协议。
- `packages/protocol/src/capabilities.ts`：在 capabilities 中解析可选 attachment limits。
- `packages/protocol/src/capabilities.test.ts`：新能力兼容测试。
- `packages/services/src/session-runtime/schema.ts`：Drizzle `attachmentAsset` schema。
- `packages/services/src/session-runtime/store.ts`：附件元数据 CRUD 和恢复查询。
- `packages/services/src/session-runtime/__test__/store.test.ts`：migration、状态转换和旧库升级测试。
- `packages/services/src/session-runtime/migrations/meta/_journal.json`：登记 `0013_attachments`。
- `packages/services/src/index.ts`：导出附件服务。
- `packages/server/src/application/daemon-application.ts`：装配并暴露 `AttachmentApplicationService`，把恢复并入 ready 生命周期。
- `packages/server/src/http/server.ts`：挂载 `/attachments` 路由。
- `packages/server/src/http/routes/system.ts`：公布 `features.attachments=1` 和实际限制。
- `packages/server/src/http/support.ts`：CORS 放行附件文件名 header，暴露下载响应 headers。
- `packages/server/src/http/__test__/http.test.ts`：端到端鉴权、capabilities、重启和上传下载测试。
- `packages/client/src/types/index.ts`：SDK 上传/下载输入类型。
- `packages/client/src/transport/http-client.ts`：附件上传、读取、下载和删除方法。
- `packages/client/src/transport/__test__/http-client.test.ts`：请求 header/body、Range 和错误测试。
- `packages/client/src/index.ts`：导出附件 Client 类型。

## 领域约束

```ts
export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxFilesPerPrompt: 20,
  maxBytesPerFile: 100 * 1024 * 1024,
  maxBytesPerPrompt: 250 * 1024 * 1024,
  maxSessionReferencedBytes: 2 * 1024 * 1024 * 1024,
  resumableThresholdBytes: 25 * 1024 * 1024,
  uploadSessionTtlMs: 24 * 60 * 60 * 1_000,
  stagingTtlMs: 24 * 60 * 60 * 1_000,
};
```

- ready asset 必须有 `sha256`、`sizeBytes` 和 `mediaType`。
- Blob 路径只由 64 位小写十六进制 SHA-256 推导：`blobs/<前两位>/<完整哈希>`。
- Client 提交的文件名只用于展示，不参与路径计算。
- `mediaType` 是服务端检测结果；`declaredMediaType` 仅作诊断。
- 空文件允许导入，类型为 `application/octet-stream`。
- 阶段 1 明确识别 JPEG、PNG、GIF、WebP、PDF、ZIP；无匹配签名时，仅当前缀是无 NUL 的合法 UTF-8 且声明为 `text/*` 时保留规范化后的 text MIME，否则使用 `application/octet-stream`。
- Blob 发布使用 `link(staging, final)`；`EEXIST` 表示内容已存在，然后删除 staging。这样不会覆盖已经发布的 Blob，也不会让读取方看见半文件。

### 任务 1：定义附件公共协议和能力协商

**文件：**
- 创建：`packages/protocol/src/attachment.ts`
- 创建：`packages/protocol/src/attachment.test.ts`
- 修改：`packages/protocol/src/index.ts`
- 修改：`packages/protocol/src/capabilities.ts`
- 修改：`packages/protocol/src/capabilities.test.ts`

- [x] **步骤 1：编写失败的附件协议测试**

在 `attachment.test.ts` 写出以下行为：默认限制能通过解析；负数、浮点数、缺字段失败；ready asset 缺哈希失败；公共投影不接受 `storageKey`。

```ts
it("parses a ready attachment asset without storage details", () => {
  expect(parseAttachmentAssetRecord({
    id: "att_1",
    displayName: "截图.png",
    declaredMediaType: "image/png",
    mediaType: "image/png",
    sizeBytes: 8,
    sha256: "a".repeat(64),
    status: "ready",
    createdAt: 10,
    updatedAt: 11,
  })).toEqual(expect.objectContaining({ id: "att_1", status: "ready" }));
});
```

在 `capabilities.test.ts` 增加：旧响应没有 `attachments` 仍可解析；新响应解析 `features.attachments` 和 limits；错误限制被拒绝。

- [x] **步骤 2：运行测试并确认失败原因准确**

运行：`pnpm --filter @vykor/protocol test -- attachment.test.ts capabilities.test.ts`

预期：FAIL，原因是 `attachment.ts`、解析函数和 `ServerCapabilities.attachments` 尚不存在，而不是已有测试失败。

- [x] **步骤 3：实现类型和严格解析**

在 `attachment.ts` 定义并实现：

```ts
export type AttachmentAssetStatus = "importing" | "ready" | "failed" | "deleted";
export type AttachmentIntent = "auto" | "vision" | "ocr" | "document" | "tool_resource" | "workspace_reference";
export type AttachmentRepresentationStatus = "pending" | "running" | "completed" | "failed";
export type AttachmentRepresentationKind = "thumbnail" | "ocr_text" | "plain_text" | "pdf_text" | "pdf_page_image" | "archive_manifest" | "directory_manifest";

export interface AttachmentAssetRecord {
  id: string;
  displayName: string;
  declaredMediaType?: string;
  mediaType?: string;
  sizeBytes?: number;
  sha256?: string;
  status: AttachmentAssetStatus;
  failureCode?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface AttachmentLimits {
  maxFilesPerPrompt: number;
  maxBytesPerFile: number;
  maxBytesPerPrompt: number;
  maxSessionReferencedBytes: number;
  resumableThresholdBytes: number;
  uploadSessionTtlMs: number;
  stagingTtlMs: number;
}
```

同时定义 `AttachmentReferenceRecord` 和 `AttachmentRepresentationRecord`，但不在阶段 1 建表。解析器必须复制白名单字段，不能用对象 spread 把 `storageKey` 透传。ready 状态额外校验哈希格式、非负大小和非空 MIME。

把 `ServerCapabilities` 扩展为：

```ts
attachments?: {
  limits: AttachmentLimits;
  uploadModes: readonly ["single"] | readonly ["single", "resumable"];
};
```

`parseServerCapabilities()` 对缺失字段保持兼容，对存在字段调用 `parseAttachmentLimits()`。

- [x] **步骤 4：运行协议测试和类型检查**

运行：

```powershell
pnpm --filter @vykor/protocol test -- attachment.test.ts capabilities.test.ts
pnpm --filter @vykor/protocol check-types
```

预期：全部 PASS。

- [x] **步骤 5：提交该独立变更**

```powershell
git add packages/protocol/src/attachment.ts packages/protocol/src/attachment.test.ts packages/protocol/src/index.ts packages/protocol/src/capabilities.ts packages/protocol/src/capabilities.test.ts
git commit -m "feat(protocol): define attachment assets and limits"
```

### 任务 2：持久化附件资产状态机

**文件：**
- 创建：`packages/services/src/session-runtime/migrations/0013_attachments.sql`
- 修改：`packages/services/src/session-runtime/migrations/meta/_journal.json`
- 修改：`packages/services/src/session-runtime/schema.ts`
- 修改：`packages/services/src/session-runtime/store.ts`
- 修改：`packages/services/src/session-runtime/__test__/store.test.ts`

- [x] **步骤 1：先写 Store 状态转换测试**

测试应创建临时数据库并覆盖：创建 importing；完成 ready；按 ID 读取；按 hash 查 ready；失败记录；逻辑删除；重复完成或删除后再完成被拒绝；关闭旧数据库后重新打开自动得到新表。

```ts
const importing = store.createImportingAttachment({
  id: "att_1",
  displayName: "a.png",
  declaredMediaType: "image/png",
  stagingName: "att_1.part",
  createdAt: 100,
});
const ready = store.markAttachmentReady("att_1", {
  sha256: "b".repeat(64),
  sizeBytes: 8,
  mediaType: "image/png",
  updatedAt: 101,
});
expect(ready.status).toBe("ready");
expect(store.findReadyAttachmentByHash("b".repeat(64))?.id).toBe("att_1");
```

- [x] **步骤 2：运行 Store 测试确认失败**

运行：`pnpm --filter @vykor/services test -- session-runtime/__test__/store.test.ts`

预期：FAIL，缺少附件表和 Store 方法。

- [x] **步骤 3：增加 migration 和 Drizzle schema**

`0013_attachments.sql` 创建：

```sql
CREATE TABLE `attachment_asset` (
  `id` text PRIMARY KEY NOT NULL,
  `display_name` text NOT NULL,
  `declared_media_type` text,
  `media_type` text,
  `size_bytes` integer,
  `sha256` text,
  `status` text NOT NULL,
  `staging_name` text,
  `failure_code` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `deleted_at` integer
);
CREATE INDEX `attachment_asset_hash_status_idx` ON `attachment_asset` (`sha256`,`status`);
CREATE INDEX `attachment_asset_status_updated_idx` ON `attachment_asset` (`status`,`updated_at`);
```

在 journal 增加 idx 13、tag `0013_attachments`，`when` 使用实现当天的 Unix 毫秒且严格大于前一条。`schema.ts` 使用完全相同的列名和索引。

- [x] **步骤 4：实现 SessionStore 附件方法**

实现下列同步方法，并沿用现有 `better-sqlite3` transaction/row mapping 风格：

```ts
createImportingAttachment(input: CreateImportingAttachmentInput): AttachmentAssetRecord;
markAttachmentReady(id: string, input: MarkAttachmentReadyInput): AttachmentAssetRecord;
failAttachmentImport(id: string, failureCode: string, updatedAt?: number): AttachmentAssetRecord;
getAttachment(id: string, options?: { includeDeleted?: boolean }): AttachmentAssetRecord | undefined;
findReadyAttachmentByHash(sha256: string): AttachmentAssetRecord | undefined;
listImportingAttachments(): Array<AttachmentAssetRecord & { stagingName: string }>;
softDeleteAttachment(id: string, deletedAt?: number): AttachmentAssetRecord;
```

所有 UPDATE 都带期望前置状态，例如 ready 更新使用 `WHERE id = ? AND status = 'importing'`；`changes !== 1` 时抛出明确状态冲突。公共 mapper 不返回 `staging_name`，只有恢复查询返回内部字段。

- [x] **步骤 5：验证 migration 和状态机**

运行：

```powershell
pnpm --filter @vykor/services test -- session-runtime/__test__/store.test.ts
pnpm --filter @vykor/services db:check
pnpm --filter @vykor/services check-types
```

预期：全部 PASS，旧库 fixture 能迁移到 0013。

- [x] **步骤 6：提交持久化变更**

```powershell
git add packages/services/src/session-runtime
git commit -m "feat(services): persist attachment asset lifecycle"
```

### 任务 3：实现安全文件名和确定性 MIME 检测

**文件：**
- 创建：`packages/services/src/attachment/attachment-errors.ts`
- 创建：`packages/services/src/attachment/attachment-filename.ts`
- 创建：`packages/services/src/attachment/attachment-media-type.ts`
- 创建：`packages/services/src/attachment/__test__/attachment-media-type.test.ts`

- [x] **步骤 1：编写签名与文件名失败测试**

覆盖 PNG/JPEG/GIF/WebP/PDF/ZIP；声明 `image/png` 但内容是 PDF 时结果必须是 PDF；声明 text 但含 NUL 时必须是 octet-stream；`%E6%88%AA%E5%9B%BE.png` 正确解码；`../a\0.png`、只有控制字符和超过 255 字符的名称被拒绝或安全化。

```ts
expect(sniffAttachmentMediaType(
  Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]),
  "image/png",
)).toBe("application/pdf");
expect(decodeAttachmentFilename("%E6%88%AA%E5%9B%BE.png")).toBe("截图.png");
```

- [x] **步骤 2：运行单测确认失败**

运行：`pnpm --filter @vykor/services test -- attachment-media-type.test.ts`

预期：FAIL，三个模块尚不存在。

- [x] **步骤 3：实现无依赖检测器与稳定错误**

定义错误码 `attachment_invalid_request`、`attachment_too_large`、`attachment_not_found`、`attachment_not_ready`、`attachment_storage_failed` 和 `attachment_aborted`。`AttachmentError` 携带 `code`、`retryable`、安全 message，不携带正文或绝对路径。

MIME 检测只读取最多 4,100 bytes，按签名优先级返回。WebP 必须同时验证 `RIFF` 和 offset 8 的 `WEBP`。文本回退使用 fatal `TextDecoder("utf-8", { fatal: true })`，并拒绝 NUL。文件名先 `decodeURIComponent`，再 `normalize("NFC")`，剥离路径组件和控制字符，trim 后限制到 255 个 Unicode code point；空结果报 `attachment_invalid_request`。

- [x] **步骤 4：运行附件工具测试与类型检查**

运行：

```powershell
pnpm --filter @vykor/services test -- attachment-media-type.test.ts
pnpm --filter @vykor/services check-types
```

预期：全部 PASS。

- [x] **步骤 5：提交验证组件**

```powershell
git add packages/services/src/attachment
git commit -m "feat(services): validate attachment names and media types"
```

### 任务 4：实现内容寻址 Blob Store

**文件：**
- 创建：`packages/services/src/attachment/attachment-blob-store.ts`
- 创建：`packages/services/src/attachment/__test__/attachment-blob-store.test.ts`

- [x] **步骤 1：编写 Blob Store 失败测试**

使用 `mkdtempSync` 和分块 `ReadableStream` 覆盖：流式 SHA-256；相同内容只产生一个 blob；超过上限立刻取消 reader 并删除 staging；AbortSignal 中断；Range `[start,end]` 返回正确字节；过期 staging 被清理，新 staging 保留；恶意 hash 不能形成路径。

```ts
const first = await blobs.import({
  uploadId: "att_1",
  content: streamOf([bytes("hello"), bytes(" world")]),
  declaredMediaType: "text/plain",
  maxBytes: 32,
});
expect(first.sha256).toBe(createHash("sha256").update("hello world").digest("hex"));
expect(first.sizeBytes).toBe(11);
```

- [x] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @vykor/services test -- attachment-blob-store.test.ts`

预期：FAIL，`AttachmentBlobStore` 不存在。

- [x] **步骤 3：实现目录和流式导入**

构造函数接收 `{ root: string; now?: () => number }`。`initialize()` 创建 `blobs` 和 `staging`。`import()`：

1. 用 `open(stagingPath, "wx")` 创建 `<uploadId>.part`；
2. 从 Web `ReadableStream<Uint8Array>` reader 逐块读取；
3. 每块先计数并检查 `maxBytes`，再写文件、更新 SHA-256，并保留最多 4,100 bytes 的检测前缀；
4. 在 `finally` 释放 reader、关闭 handle；失败时删除该明确 staging 文件；
5. 成功后计算 MIME，创建 `blobs/<hash[0..2]>`；
6. `link(stagingPath, finalPath)`，`EEXIST` 视为去重成功；最后删除 staging；
7. 返回 `{ sha256, sizeBytes, mediaType, deduplicated }`。

不要使用用户文件名拼路径。hash 入参必须匹配 `/^[a-f0-9]{64}$/`。读取先异步打开文件并核对它是普通文件且大小与数据库一致，通过后再从 `FileHandle` 创建读取流并转换为 Web stream；底层读取错误统一改写为不包含真实路径的存储错误。

- [x] **步骤 4：实现 staging 恢复**

```ts
recoverStaging(options: {
  activeNames: ReadonlySet<string>;
  olderThan: number;
}): Promise<{
  removed: string[];
  retained: string[];
  recoverable: string[];
}>;
```

只枚举 `staging` 的直接普通文件；删除 mtime 小于阈值且不在 activeNames 的 `.part`。`recoverable` 只包含仍存在且未过期的普通 `.part` 文件。符号链接、目录和无法识别项只报告 `retained`，不进入 `recoverable`，也不递归处理。

- [x] **步骤 5：运行 Blob Store 测试**

运行：

```powershell
pnpm --filter @vykor/services test -- attachment-blob-store.test.ts
pnpm --filter @vykor/services check-types
```

预期：全部 PASS，并且测试结束后临时目录中没有 `.part`。

- [x] **步骤 6：提交 Blob Store**

```powershell
git add packages/services/src/attachment/attachment-blob-store.ts packages/services/src/attachment/__test__/attachment-blob-store.test.ts
git commit -m "feat(services): add content-addressed attachment blobs"
```

### 任务 5：实现 AttachmentApplicationService 和恢复

**文件：**
- 创建：`packages/services/src/attachment/attachment-application-service.ts`
- 创建：`packages/services/src/attachment/__test__/attachment-application-service.test.ts`
- 创建：`packages/services/src/attachment/index.ts`
- 修改：`packages/services/src/index.ts`

- [x] **步骤 1：编写服务状态机失败测试**

覆盖成功导入、Blob 失败后数据库为 failed、ready 查询、deleted 隐藏、重复内容共享 hash、启动时 importing 记录转 failed、过期 staging 清理。注入可控 Blob Store 失败，断言错误 message 不含原始字节和绝对 root。

```ts
const asset = await attachments.import({
  displayName: "a.txt",
  declaredMediaType: "text/plain",
  content: streamOf([bytes("hello")]),
});
expect(asset).toMatchObject({ status: "ready", mediaType: "text/plain", sizeBytes: 5 });
expect(attachments.getContent(asset.id).sha256).toBe(asset.sha256);
```

- [x] **步骤 2：运行服务测试确认失败**

运行：`pnpm --filter @vykor/services test -- attachment-application-service.test.ts`

预期：FAIL，应用服务尚不存在。

- [x] **步骤 3：实现服务编排**

构造参数为：

```ts
interface AttachmentApplicationServiceOptions {
  store: SessionStore;
  blobs: AttachmentBlobStore;
  limits?: Partial<AttachmentLimits>;
  now?: () => number;
  id?: () => string;
}
```

合并 limits 后再次调用 `parseAttachmentLimits`。`import()` 先生成 `att_<uuid>` 和 staging name，创建 importing 记录，再调用 Blob Store。成功调用 `markAttachmentReady`；失败调用 `failAttachmentImport` 并重新抛出规范化 `AttachmentError`。`get()`、`openContent()`、`delete()` 对不存在或 deleted 统一抛 `attachment_not_found`，避免泄露历史状态。

`recover()` 先取 `listImportingAttachments()`；其 staging 文件已经过 TTL 或不存在时标记 `attachment_storage_failed`，仍存在且未过 TTL 的记录也标记 `attachment_aborted`，因为 daemon 重启后没有可信上传连接可继续；随后调用 `recoverStaging()` 清除无活跃所有者的过期临时文件。

- [x] **步骤 4：验证服务和公共导出**

运行：

```powershell
pnpm --filter @vykor/services test -- attachment-application-service.test.ts
pnpm --filter @vykor/services test -- attachment-blob-store.test.ts
pnpm --filter @vykor/services check-types
```

预期：全部 PASS。

- [x] **步骤 5：提交应用服务**

```powershell
git add packages/services/src/attachment packages/services/src/index.ts
git commit -m "feat(services): orchestrate attachment imports and recovery"
```

### 任务 6：增加附件 HTTP API

**文件：**
- 创建：`packages/server/src/http/routes/attachment.ts`
- 创建：`packages/server/src/http/routes/attachment.test.ts`
- 修改：`packages/server/src/http/support.ts`

- [x] **步骤 1：编写 route contract 失败测试**

用内存 Hono app 和 fake service 覆盖：缺文件名 400；空 body 导入为零字节 asset；超大 `Content-Length` 提前 413；POST 传入原始 stream 并返回 201；GET metadata；GET content 200；`Range: bytes=2-5` 返回 206 和 Content-Range；非法/多段 Range 返回 416；If-None-Match 返回 304；DELETE 返回逻辑删除记录。

```ts
const response = await app.request("/", {
  method: "POST",
  headers: {
    "content-type": "image/png",
    "x-vykor-filename": encodeURIComponent("截图.png"),
  },
  body: Uint8Array.from([1, 2, 3]),
});
expect(response.status).toBe(201);
```

- [x] **步骤 2：运行 route 测试确认失败**

运行：`pnpm --filter @vykor/server test -- routes/attachment.test.ts`

预期：FAIL，route factory 尚不存在。

- [x] **步骤 3：实现请求解析和错误映射**

导出 `createAttachmentRoutes(attachments)`。POST 使用 `c.req.raw.body`，不调用 `formData()`、`arrayBuffer()` 或 `parseBody()`；body 为 null 时传入一个立即关闭的空 `ReadableStream`，使零字节文件仍可导入。解析可选 `Content-Length`；非整数、负数返回 400，超过 `maxBytesPerFile` 返回 413。文件名由 `decodeAttachmentFilename()` 处理，声明 MIME 取规范化的 `Content-Type` 基础类型。

错误映射固定为：invalid request 400、too large 413、not found 404、not ready 409、aborted 408、storage failed 500。响应 body 使用现有 `errorResponse`，不返回磁盘异常原文。

- [x] **步骤 4：实现安全下载响应**

ready asset 的 ETag 为 `"sha256-<hash>"`。无 Range 返回 200；单个闭区间、开放尾端和 suffix range 均支持；越界返回 416 并带 `Content-Range: bytes */<size>`。下载 header 至少包含：

```ts
{
  "accept-ranges": "bytes",
  "cache-control": "private, immutable",
  "content-type": asset.mediaType,
  "content-length": String(length),
  "content-disposition": contentDisposition(asset.displayName),
  etag: `"sha256-${asset.sha256}"`,
  "x-content-type-options": "nosniff",
}
```

`contentDisposition()` 同时生成安全 ASCII fallback 和 RFC 5987 `filename*=UTF-8''...`，并移除 CR/LF，防止 header 注入。

- [x] **步骤 5：运行 route 测试和类型检查**

运行：

```powershell
pnpm --filter @vykor/server test -- routes/attachment.test.ts
pnpm --filter @vykor/server check-types
```

预期：全部 PASS。

- [x] **步骤 6：提交 HTTP route**

```powershell
git add packages/server/src/http/routes/attachment.ts packages/server/src/http/routes/attachment.test.ts packages/server/src/http/support.ts
git commit -m "feat(server): expose attachment upload and download routes"
```

### 任务 7：装配 daemon、capabilities 和端到端鉴权

**文件：**
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/application/default-node-application.ts`
- 修改：`packages/server/src/http/server.ts`
- 修改：`packages/server/src/http/routes/system.ts`
- 修改：`packages/server/src/http/__test__/http.test.ts`

- [x] **步骤 1：编写端到端失败测试**

测试真实临时 SQLite 和 Blob root：未授权 POST/GET 为 401；带 token 上传后可读取；另一个相同内容 asset 只产生一个 Blob；`/capabilities` 无鉴权可见 `features.attachments=1` 和限制；关闭并重建 server 后 asset 仍可读取；遗留 importing 记录在 `ready()` 后成为 failed。

- [x] **步骤 2：运行 HTTP 集成测试确认失败**

运行：`pnpm --filter @vykor/server test -- http/__test__/http.test.ts`

预期：新增用例 FAIL，现有 HTTP 用例保持通过。

- [x] **步骤 3：在应用根装配服务**

给 `DaemonApplicationOptions` 增加：

```ts
attachmentRoot?: string;
attachmentLimits?: Partial<AttachmentLimits>;
attachments?: AttachmentApplicationService;
```

默认 root 是 `join(dirname(store.path), "attachments")`。外部注入 attachments 时不再自行创建。`DurableAgentApplication` 和 `DaemonApplication` 暴露只读 `attachments`。把 `attachments.recover()` 合并进现有 `startupRecovery`，使 HTTP server 在 `application.ready()` 完成前不会接收上传。

- [x] **步骤 4：挂载路由并公布实际限制**

在鉴权 middleware 之后挂载：

```ts
this.app.route("/attachments", createAttachmentRoutes(this.application.attachments));
```

`createSystemRoutes` 接收实际 limits，并返回：

```ts
features: { ...existingFeatures, attachments: 1 },
attachments: { limits, uploadModes: ["single"] },
```

`CORS_HEADERS` 增加 `x-vykor-filename, range, if-none-match`；`Access-Control-Expose-Headers` 增加 `content-range, content-disposition, etag, accept-ranges`，同时保留 trace header。

- [x] **步骤 5：运行服务器全套验证**

运行：

```powershell
pnpm --filter @vykor/server test
pnpm --filter @vykor/server check-types
```

预期：全部 PASS；测试日志不出现附件正文或临时绝对路径。

- [x] **步骤 6：提交装配变更**

```powershell
git add packages/server/src/application packages/server/src/http
git commit -m "feat(server): wire durable attachment service"
```

### 任务 8：实现 Client SDK

**文件：**
- 修改：`packages/client/src/types/index.ts`
- 修改：`packages/client/src/transport/http-client.ts`
- 修改：`packages/client/src/transport/__test__/http-client.test.ts`
- 修改：`packages/client/src/index.ts`

- [x] **步骤 1：编写 SDK 请求失败测试**

注入 fake fetch，覆盖：上传使用原始 body、Bearer、Content-Type 和编码文件名；不手工设置浏览器禁止设置的 Content-Length；GET metadata 解析公共类型；download 透传 Range 并返回 Response；DELETE；413 仍转换为 `VykorApiError`。

```ts
await client.uploadAttachment({
  displayName: "截图.png",
  mediaType: "image/png",
  body: new Blob([Uint8Array.from([1, 2, 3])]),
});
expect(request.headers.get("x-vykor-filename")).toBe(encodeURIComponent("截图.png"));
expect(request.headers.has("content-length")).toBe(false);
```

- [x] **步骤 2：运行 Client 测试确认失败**

运行：`pnpm --filter @vykor/client test -- http-client.test.ts`

预期：FAIL，附件 SDK 方法不存在。

- [x] **步骤 3：定义 SDK 类型和方法**

```ts
export interface UploadAttachmentInput {
  displayName: string;
  mediaType?: string;
  body: Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>;
  signal?: AbortSignal;
}

export interface DownloadAttachmentOptions {
  range?: { start?: number; end?: number; suffixBytes?: number };
  signal?: AbortSignal;
}
```

实现：

```ts
uploadAttachment(input: UploadAttachmentInput): Promise<AttachmentAssetRecord>;
getAttachment(id: string, options?: { signal?: AbortSignal }): Promise<AttachmentAssetRecord>;
downloadAttachment(id: string, options?: DownloadAttachmentOptions): Promise<Response>;
deleteAttachment(id: string, options?: { signal?: AbortSignal }): Promise<AttachmentAssetRecord>;
```

上传直接调用注入 fetch，并设置 `duplex: "half"` 仅用于 `ReadableStream`；通过局部 Node-compatible `RequestInit & { duplex?: "half" }` 类型实现，不改变公共 API。下载不调用 `.json()`，让调用方流式读取 `response.body`。Range builder 必须拒绝同时设置 suffix 和 start/end、负数及 end < start。

- [x] **步骤 4：运行 Client 测试和类型检查**

运行：

```powershell
pnpm --filter @vykor/client test -- http-client.test.ts
pnpm --filter @vykor/client check-types
```

预期：全部 PASS。

- [x] **步骤 5：提交 SDK**

```powershell
git add packages/client/src
git commit -m "feat(client): add attachment transfer APIs"
```

### 任务 9：阶段 1 交叉验证和文档收口

**文件：**
- 修改：`docs/superpowers/specs/2026-08-27-conversation-attachments-roadmap-design.md`
- 修改：`docs/superpowers/plans/2026-08-27-conversation-attachments-stage-1.md`

- [x] **步骤 1：运行相关 package 的完整测试**

```powershell
pnpm --filter @vykor/protocol test
pnpm --filter @vykor/services test
pnpm --filter @vykor/server test
pnpm --filter @vykor/client test
```

预期：全部 PASS，不能只记录新增测试结果。

- [x] **步骤 2：运行所有相关类型和数据库检查**

```powershell
pnpm --filter @vykor/protocol check-types
pnpm --filter @vykor/services check-types
pnpm --filter @vykor/services db:check
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/client check-types
```

预期：全部 exit 0。

- [x] **步骤 3：执行文档和差异检查**

```powershell
node scripts/check-docs.mjs
git diff --check
git status --short
```

预期：文档检查通过，diff 无空白错误；status 只包含阶段 1 已知文件。

- [x] **步骤 4：执行人工安全抽查**

使用一个 Unicode 文件名和一个声明为 PNG、实际为 PDF 的文件走真实 HTTP server，确认：返回 MIME 为 PDF；数据库不含 Client 绝对路径；响应不含 storage key；Range 下载字节正确；删除后 metadata/content 均为 404；Blob 仍保留等待阶段 7 GC。

- [x] **步骤 5：更新路线状态**

只有上述命令全部通过后，才在总路线阶段 1 标记“已完成”，记录 migration `0013`、feature version `attachments: 1`、上传协议和验证日期。若有任一失败，保留阶段 1 为“进行中”并在本计划对应步骤记录失败命令和错误摘要。

- [x] **步骤 6：提交阶段收口**

```powershell
git add docs/superpowers/specs/2026-08-27-conversation-attachments-roadmap-design.md docs/superpowers/plans/2026-08-27-conversation-attachments-stage-1.md
git commit -m "docs: record attachment stage one completion"
```

## 阶段 1 验收矩阵

| 要求 | 自动证据 | 通过条件 |
|---|---|---|
| 内容去重 | Blob Store + HTTP 集成测试 | 两个 asset、一个 hash 路径 |
| 上传不整块缓冲 | route 禁止 `arrayBuffer/formData`，Blob 分块测试 | 分块流可导入，超限在读取中终止 |
| 中断和失败收束 | Blob/Application Service 测试 | 无 `.part`，asset 非 ready |
| 重启恢复 | application ready 集成测试 | importing 变 failed，旧 ready 可读 |
| MIME 欺骗 | media type + HTTP 测试 | magic bytes 胜过 header |
| 路径安全 | filename/hash 测试 | 文件名不参与磁盘路径，恶意 hash 被拒绝 |
| 远程鉴权 | HTTP 集成测试 | 无 token 401，有 token 成功 |
| 安全下载 | route 测试 | Range、ETag、nosniff、Content-Disposition 正确 |
| 兼容性 | protocol capabilities 测试 | 旧 capabilities 可解析，新 limits 严格校验 |
| 逻辑删除 | service + HTTP 测试 | 删除后不可读，Blob 不立即物理删除 |

## 不进入阶段 1 的工作

- `SessionInput.attachments`、消息引用、SSE 和 transcript：阶段 2。
- Composer、拖放、粘贴、预览 UI：阶段 3。
- Provider 原生图片 content block：阶段 4。
- `@arcships/light-ocr`、`LocalOcrService`、`ImageToText` 改造：阶段 5。
- PDF document engine、文本/代码 extractor、Agent mount：阶段 6。
- GC 与备份 manifest：阶段 7。
- resumable upload、配额预留和文件夹上传：阶段 8。

这些边界不代表先做一个临时附件方案；阶段 1 的资产 ID、Blob 路径、公开投影、错误码、limits 和 HTTP 读取语义会被后续阶段直接复用。
