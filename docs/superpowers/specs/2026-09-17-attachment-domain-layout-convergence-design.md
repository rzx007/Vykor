# Attachment 领域目录收敛设计

> 日期：2026-09-17
>
> 状态：已实施
>
> 范围：统一 Attachment 在 Services、Server 和 Desktop 中的目录与职责边界；不改变协议、数据库结构、HTTP 行为和用户功能

## 1. 背景

Attachment 目前在同一层出现了多个并列入口：

- `packages/services/src/attachment/`
- `packages/services/src/attachment-processing/`
- `packages/services/src/attachments/`
- `packages/server/src/application/attachment-processing/`
- `packages/server/src/application/attachment-resource/`
- `packages/server/src/application/attachment-routing/`
- `packages/server/src/application/attachment-tools/`

这些目录并不是重复实现，但单数、复数和职责后缀混排，使维护者无法从目录判断模块属于持久化、文件基础设施、内容处理还是 daemon 应用编排。`AttachmentApplicationService` 还位于 Services 包中，实际却负责组合数据库事务与 Blob Store，和当前“应用用例属于 Server application”的边界不一致。

Desktop 的 `attachment-service.ts` 同时承担来源暂存、上传队列、重试取消、预览、打开、另存为、临时文件和远端存储维护代理，已经形成明显的多职责文件。

## 2. 目标

- 每个架构层只有一个清楚的 Attachment 领域入口。
- Services 只提供持久化、文件存储、内容解析和本地处理能力。
- Server application 负责 Attachment 用例编排、运行时路由、资源暴露和工具授权。
- Client 继续只负责远程 Resource。
- Desktop 继续负责本机交互，但拆开上传生命周期与本地文件操作。
- 删除旧目录，不增加转发文件、旧路径 re-export 或兼容别名。
- 移动前后协议、数据库、HTTP、IPC 和用户行为保持不变。

## 3. 不在范围内

- 不创建新的 `@vykor/attachments` workspace 包。
- 不修改 Attachment 协议类型、错误码、HTTP 路由或数据库 schema。
- 不重新设计 OCR、附件路由策略、Blob 格式或上传协议。
- 不因为文件较长就拆分职责仍然单一的 `AttachmentBlobStore`。
- 不在本任务中顺带重组其他业务领域；其他领域使用同一判断规则另行审查。

## 4. 目标目录

### 4.1 Services

```text
packages/services/src/attachments/
├── index.ts
├── attachment-errors.ts
├── content/
│   └── attachment-text.ts
├── persistence/
│   ├── attachment-records.ts
│   ├── attachment-repository.ts
│   └── attachment-transactions.ts
├── processing/
│   ├── image-normalizer.ts
│   ├── light-ocr-engine.ts
│   ├── local-ocr-errors.ts
│   └── local-ocr-service.ts
└── storage/
    ├── attachment-blob-store.ts
    ├── attachment-filename.ts
    ├── attachment-integrity-service.ts
    ├── attachment-media-type.ts
    └── attachment-storage-operation-gate.ts
```

测试跟随被测模块放入对应目录的 `__test__/`，或者沿用该目录已经存在的同级 `*.test.ts` 约定。完成后删除旧的 `attachment/` 和 `attachment-processing/` 目录。

职责规则：

- `persistence/` 只处理 SQLite 记录、Repository 和原子事务。
- `storage/` 只处理内容寻址 Blob、文件安全、完整性检查与存储操作互斥。
- `processing/` 只处理 OCR 和输入图片标准化。
- `content/` 放不依赖存储的内容分类与文本解码。
- 稳定 Attachment 错误放在领域根目录，供上述子模块共同使用。

`packages/services/src/attachments/index.ts` 是 Services 内唯一 Attachment barrel。包根 `src/index.ts` 只从该 barrel 导出，不再暴露多个目录入口。

### 4.2 Server application

```text
packages/server/src/application/attachments/
├── attachment-service.ts
├── resources/
│   ├── compact-attachment-catalog.ts
│   └── session-attachment-resources.ts
├── routing/
│   ├── attachment-capabilities.ts
│   ├── attachment-capability-router.ts
│   └── attachment-routing-types.ts
└── tools/
    ├── attachment-access.ts
    ├── attachment-read-tool.ts
    └── attachment-uri.ts
```

`AttachmentApplicationService` 从 Services 移入这里并更名为 `AttachmentService`。它继续组合 Attachment transaction、Blob Store、限制和存储操作 gate，但成为明确的 daemon 应用用例，而不是 Services 基础能力。

现有 `attachment-processing/safe-remote-image.ts` 只被图片生成工具使用，不属于通用 Attachment processing。它移动为：

```text
packages/server/src/application/visual-tools/remote-image-source.ts
```

完成后删除 Server application 下原来的四个 `attachment-*` 目录。

### 4.3 Client

`packages/client/src/resources/attachment-resource.ts` 保持原位。它已经符合 Client 的领域 Resource 规则，没有同层重复入口，也不承载服务端业务逻辑。

### 4.4 Desktop

`apps/desktop/src/main/features/attachment/` 保持单数命名，因为 Desktop 其他 feature 也统一使用 `session`、`schedule`、`provider` 等单数目录。目录内部调整为：

```text
apps/desktop/src/main/features/attachment/
├── attachment-service.ts
├── attachment-upload-service.ts
├── attachment-file-service.ts
├── ipc.ts
└── 对应测试
```

- `AttachmentUploadService` 拥有来源 token、上传队列、并发控制、进度事件、取消、重试和 draft 清理。
- `AttachmentFileService` 拥有本地路径验证、预览下载、打开、另存为和临时目录清理。
- `DesktopAttachmentService` 变成薄门面，组合两个服务，并代理远端删除、扫描、修复和 GC；IPC 继续只依赖这个门面。

内部类型移动到实际所有者附近，不新增共享 `types.ts` 杂物文件。只有两个子服务都真正依赖的契约才留在门面文件或单独的明确契约文件中。

## 5. 依赖方向

允许的主要依赖方向：

```text
Services attachment content/storage/processing
                    ↓
Services attachment persistence
                    ↓
Server AttachmentService
                    ↓
Server resources/routing/tools and HTTP routes
                    ↓
Client AttachmentResource
                    ↓
Desktop attachment feature
```

更准确地说，Services 的子模块可以共同使用根错误类型；`AttachmentService` 可以组合 persistence 与 storage；Server 的 routing、resources 和 tools 只依赖窄接口，不反向进入 Services 的 HTTP 或 daemon 概念。Client 和 Desktop 不得深度导入 Server 或 Services 源文件。

## 6. 公开 API 与命名

- 删除 `AttachmentApplicationService`，统一使用 `AttachmentService`。
- `@vykor/services` 不再导出应用服务，只导出 Repository、Transaction、Blob Store、完整性检查、OCR 与内容工具等基础能力。
- Server 内部类型从 `application/attachments/attachment-service.ts` 导入；HTTP server 和 routes 使用该 Server 类型。
- 不保留旧类名 alias，也不保留旧目录 re-export。
- 对外 HTTP、Client Resource、Desktop IPC 名称不变，因为本次整理的是代码所有权，不是产品协议。

## 7. 迁移顺序

1. 先建立 Services 的 `attachments/` 子目录结构，移动实现与测试，修正内部导入和唯一 barrel。
2. 将应用服务迁入 Server 并更名，更新 daemon 组合根、HTTP routes、备份、保留策略、运行装配和测试。
3. 将 Server 的 routing、resources、tools 收进单一 `attachments/` 根；将远程图片导入移入 `visual-tools/`。
4. 拆分 Desktop 上传服务和文件服务，保持 IPC 行为不变。
5. 删除所有旧目录和旧导出，执行负向路径搜索。

每一步可以单独提交，但最终状态不得保留新旧目录并行。

## 8. 错误处理与行为保持

- 现有 `AttachmentError`、OCR 错误和 Desktop 公共错误码保持不变。
- 移动过程中不得把存储错误转换成新的协议错误，也不得改变 HTTP 状态映射。
- Desktop 拆分后，取消、重试、owner 隔离、source token 过期和临时文件清理顺序保持不变。
- Server 的 AttachmentService 仍以同一 storage operation gate 协调导入与完整性维护。

## 9. 验证

至少覆盖：

- Services Attachment persistence、storage、processing 和 content 的现有测试。
- Server AttachmentService、resources、routing、tools、HTTP attachment routes 和 daemon application 测试。
- Desktop attachment service、IPC、上传取消/重试、预览、打开、另存为及临时文件测试。
- `@vykor/services`、`@vykor/server`、`@vykor/client` 和 Desktop 类型检查。
- 架构边界与文档检查。
- 负向搜索确认旧目录、`AttachmentApplicationService` 和旧深度导入均不存在。

## 10. 其他领域的后续规则

Attachment 完成后单独执行全仓领域目录一致性审查。审查只处理两类问题：

1. 同一层为同一领域建立多个并列入口；
2. 模块实际职责属于另一层，例如应用用例落在基础 Services 中。

不同层出现同一领域名称是正常现象。例如 Services 的 `channels/`、Server application 的 `channel/` 与 Client 的 `channel-resource.ts` 分别代表持久化、应用用例和远程调用，不应为了目录唯一而合并。当前优先复查候选是 Server 顶层 `permissions/` 与 `application/` 的边界，以及顶层 `session/` 与 `application/session/` 的边界；`session-runtime` 与 sessions/conversations/runs 的组合关系不在没有新证据时重新拆改。
