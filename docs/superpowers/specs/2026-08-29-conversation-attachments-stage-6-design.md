# 对话附件阶段 6：文本与代码资源设计

> 状态：历史阶段设计，已实现（2026-08-29）。其中 Docker 附件目录挂载随后被宿主 `attachment://` 工具覆盖取代；当前边界见 [附件能力退出 Agent Runtime](./2026-09-02-attachment-tool-overrides-design.md)。

## 目标与边界

阶段 6 让用户能够把 TXT、Markdown、源代码、JSON、CSV、XML、YAML、日志等文本文件附在一条对话消息中。小文件提供有边界的正文，大文件只提供文件说明和预览；Agent 需要继续查看时，使用现有 `Read` 工具读取 `attachment://` 资源。任何截断都必须明确报告，不能让模型误以为已经看到完整文件。

图片继续使用阶段 4/5 已完成的原生图片和 `ImageToText` 降级路线。本阶段不新增 PDF 能力，不调用 light-ocr 处理 PDF，不增加 Word/Excel/PPT 解析库，不解压 ZIP，不实现文件夹上传，也不让 Provider 猜测自己能否读取某种文档。

## 支持矩阵

| 类型 | 本阶段行为 |
| --- | --- |
| PNG/JPEG/GIF/WebP/BMP | 沿用既有原生图片或 `ImageToText` 路线 |
| TXT/Markdown/代码/日志 | 严格解码后作为文本资源 |
| JSON/JSONL/CSV/XML/YAML/TOML | 严格解码后作为文本资源 |
| PDF | `attachment_document_unsupported`，Provider 调用前阻止 |
| DOC/DOCX/XLS/XLSX/PPT/PPTX/ODT/ODS/ODP | `attachment_document_unsupported`，Provider 调用前阻止 |
| ZIP/7z/RAR/TAR/GZIP | `attachment_archive_unsupported`，不自动解压 |
| 可执行文件、媒体和未知二进制 | `attachment_binary_unsupported` |

“不支持”不是静默忽略。Desktop 在附件卡片上显示原因并禁用发送；daemon 仍做最终校验，任何客户端都无法绕过。

## 运行流程

1. 上传层继续保存原始字节、真实 MIME、哈希、大小和显示名，不依赖用户最初选择文件的绝对路径。
2. 发送前由统一分类器结合文件签名、MIME 和安全扩展名决定 `image`、`text` 或 `unsupported`。扩展名只能把文件列为“文本候选”，不能证明它真是文本。
3. 文本候选必须通过严格解码：允许 UTF-8、带 BOM 的 UTF-8、UTF-16LE 和 UTF-16BE；拒绝 NUL、无效字节序列和解码后仍呈现明显二进制控制字符的内容。
4. 小文本最多内联 16,000 字符，外层加不可信数据边界、附件 ID、显示名、编码和完整性标志。
5. 大文本只内联最多 3,000 字符预览，同时给出 `attachment://<asset-id>/<safe-name>`。提示明确说明预览不完整，Agent 应使用现有 `Read` 工具按行继续读取。
6. `Read` 遇到 `attachment://` 时不走本地路径解析，而是调用宿主提供的附件资源能力。宿主只允许读取当前会话已经引用的 ready asset，并按 `offset`、`limit` 返回带行号的有界文本。
7. PDF、Office、压缩包和其他二进制在路由阶段生成稳定的 blocked decision，Provider 不会收到正文、文件路径或伪造的降级文本。

## 分类与解码

### 文本候选

可信文本 MIME 包括 `text/*`，以及明确的结构化文本 MIME，例如 `application/json`、`application/x-ndjson`、`application/xml`、`application/yaml` 和 `application/toml`。当桌面系统没有提供 MIME 时，可用受限扩展名表把 `.ts`、`.tsx`、`.js`、`.py`、`.rs`、`.go`、`.java`、`.md`、`.log` 等标为候选。

候选文件仍必须读取前缀并完成严格解码。把二进制文件改名成 `.txt` 不会绕过验证。PDF 和 ZIP 等已识别签名永远优先于扩展名。

### 编码

- UTF-8 使用 `TextDecoder("utf-8", { fatal: true })`。
- UTF-8 BOM 在输出前去掉。
- UTF-16LE/BE 只在 BOM 明确存在时接受，避免对任意二进制进行猜测。
- 本阶段不自动猜测 GBK、Shift-JIS 等区域编码；它们返回 `attachment_text_encoding_unsupported`，提示用户另存为 UTF-8 后重试。
- 换行统一为 `\n`，但原始附件字节不修改。

## 附件资源与 Read

新增最小宿主接口 `AgentAttachmentResourceHost`。它只接受 asset ID 和行范围，不接受任意文件路径：

```ts
interface AgentAttachmentResourceHost {
  readText(
    input: { assetId: string; offset: number; limit: number },
    context: { sessionId?: string; signal?: AbortSignal },
  ): Promise<{
    displayName: string
    mediaType: string
    encoding: "utf-8" | "utf-16le" | "utf-16be"
    content: string
    startLine: number
    endLine: number
    hasMore: boolean
  }>
}
```

`Read` 仍是 Agent 唯一需要认识的文件读取工具。普通路径保持现有行为；`attachment://` 由严格解析器提取 asset ID，忽略 URI 中展示用的文件名，权限以 asset ID 和当前 session 的引用关系为准。默认 2,000 行，服务端设置硬上限，负数、非整数和超大范围直接拒绝。

## 只读资源目录

每个会话使用独立的附件资源目录，目录名不含原文件名。Docker 启动时只把该目录挂载为只读资源根，不挂载 Attachment Blob Store 或 daemon 数据目录。路由成功后只把本次运行引用的受支持文本 asset 以硬链接或只读副本物化到资源目录；原始 Blob 不可写。

资源提示以 `attachment://` 为主，避免模型依赖主机绝对路径。沙箱内需要真实文件的受控工具可使用固定资源根。运行结束后移除本次物化条目；清理失败记录审计事件，但不改变已经完成的模型结果。

## 路由与错误语义

阶段 6 新增：

```ts
type AttachmentRoute =
  | "native_image"
  | "image_to_text_tool"
  | "text_inline"
  | "text_resource"
  | "blocked"
```

稳定错误码包括：

- `attachment_document_unsupported`
- `attachment_archive_unsupported`
- `attachment_binary_unsupported`
- `attachment_text_encoding_unsupported`
- `attachment_text_invalid`
- `attachment_resource_unavailable`
- `attachment_resource_access_denied`

路由 decision 和 run metadata 保存实际路线。消息重放不重新猜测旧 decision；同一个 input 的附件顺序保持不变。失败时 transcript 显示哪一个文件阻止了运行以及原因。

## Desktop 表现

- 支持的文本附件卡显示 `TXT`、`MD`、`JSON` 或代码扩展名，以及文件大小。
- PDF/Office/压缩包卡片显示“不支持此文件格式”，发送按钮不可用。
- 编码只有读取后才能确认时，上传可以完成；发送预检失败后卡片显示“请转换为 UTF-8”。
- 大文本不在编辑框展开正文；发送后消息仍只显示附件卡片。
- “添加文件夹”入口继续保留为禁用状态，不在本阶段实现。

## 安全要求

- 附件正文始终标注为用户提供的不可信数据，不得作为系统或开发者指令。
- 不信任声明 MIME、扩展名或原始路径，真实签名和严格解码优先。
- `attachment://` 不允许路径穿越、查询参数覆盖 asset ID 或访问未被当前 session 引用的 asset。
- `Read` 每次返回有硬上限，并明确 `hasMore`；不得先把 100 MiB 文件整体读进 Agent 上下文。
- 日志记录 asset ID、大小、编码、范围、耗时和错误码，不记录正文。

## 验收标准

- UTF-8、UTF-8 BOM、UTF-16LE/BE 文本和常见代码文件能上传、发送和按行继续读取。
- 小文件正文完整且带来源边界；大文件只给预览，并明确提示继续调用 `Read`。
- `Read attachment://...` 只能读取当前会话引用的 ready 文本 asset，范围和 `hasMore` 正确。
- PDF、DOCX、XLSX、PPTX、ZIP、伪装成 `.txt` 的二进制文件都在 Provider 调用前明确阻止。
- 图片原生路线和 `ImageToText` 路线没有回归。
- Docker 只看到会话资源目录的只读挂载，看不到 daemon Attachment Blob Store。
- Desktop、daemon、重放和 transcript 使用同一套稳定 route/error 语义。

## 实现与验收记录

阶段 6 已按上述边界实现：

- 上传后的文本候选使用严格 UTF-8/UTF-16 解码，真实测试包含中文、BOM、大小端 UTF-16、伪装二进制和 5 MiB 日志。
- 路由使用 `text_inline`、`text_resource` 和稳定 blocked decision；大文本上下文只保留 3,000 字符预览。
- 现有 `Read` 已支持 `attachment://`，读取前校验 URI、会话引用、ready 状态、文本类型和行范围。
- Docker 使用 daemon 管理的独立会话目录，只读挂载到 `/mnt/vykor-attachments`；不暴露 Blob Store。使用附件挂载时关闭容器跨会话复用，避免旧挂载泄漏。
- Desktop 在发送前阻止 PDF、Office、压缩包和未知二进制；daemon 仍是最终裁决者。“添加文件夹”入口保持显示且禁用。
- route、完整性和资源 URI 写入运行 metadata 与 transcript transformation metadata，重放不依赖重新猜测文件类型。

最终验收结果：

- 全工作区测试在包级串行模式下 58/58 个 Turbo 任务通过；默认高并发曾触发仓库既有的计时型超时，因此最终验收固定使用串行模式。
- Server 完整测试：52 个测试文件、404 个测试通过；新增真实 HTTP 附件链路测试单独通过。
- Desktop 完整测试：52 个测试文件、336 个测试通过；Frontend 24 个测试文件、141 个测试通过。
- Core、Sandbox、Services、Tools、Agent Runtime 完整测试分别为 104、58、214、188、87 个测试通过；Sandbox 的 11 个 Docker/SRT 环境测试按原条件跳过。
- 全仓类型检查 57/57 个任务通过；文档检查覆盖 110 个 Markdown 文件并通过；`git diff --check` 通过。
- Desktop 生产构建、Windows x64 `win-unpacked` 打包和 OCR 产物闭包检查通过。打包程序启动返回退出码 0；由于当前已有 Vykor 实例，单实例保护让第二个进程正常退出，没有终止现有实例。
- 根 `pnpm lint` 仍因仓库没有 Turbo `lint` 任务而无法运行。对本阶段修改的 5 个 Desktop 文件单独执行 ESLint，结果为 0 error；保留仓库既有的 Prettier/CRLF warning，不做全仓机械格式化。
