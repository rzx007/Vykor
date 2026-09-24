# 对话附件阶段 4：结构化运行时与原生图片能力设计

**状态：已完成（2026-08-28）。**

## 背景

阶段 1 已经提供 daemon 所有的附件资产、内容寻址 Blob、单文件流式上传和安全下载；阶段 2 已把有序附件引用接入 Prompt admission、持久化、Snapshot、SSE、queue、retry、edit、fork 和 restart；阶段 3 已完成 Desktop 选择、上传、草稿、发送和历史卡片。

当前缺口在执行端：`SessionRunExecutor` 仍只把 `admitted.content` 传给 Agent，附件只存在于 durable input 和 transcript 中，没有进入 Core `ContentBlock[]`。OpenAI 与 Codex 已有文件图片到 Provider 请求的转换代码，但没有完整执行链路；Anthropic 仍把内部块错误强转为 `TextBlockParam[]`。

阶段 4 只打通模型原生图片输入。当前模型不支持图片或能力未知时，运行在 Provider 请求之前明确失败，不丢图片、不发送纯文本、不调用 `ImageToText`。`ImageToText` 的本地 OCR 改造属于阶段 5。

## 目标

1. 把 durable ordered attachment refs 在运行时转换成有序的 Core `ContentBlock[]`。
2. 用同一套 capability model 判断模型、Provider adapter 和图片媒体类型是否同时支持。
3. 打通 OpenAI Chat Completions、Codex Responses 和 Anthropic Messages 的合法图片请求。
4. 不支持、未知、文件缺失或格式不合法时，在任何 Provider 请求前阻止整条 run。
5. 把路由判断、稳定错误码和 direct transformation 写入现有运行记录与 transcript。
6. 模型在排队期间发生变化时，按真正执行时的模型重新判断。
7. 不把绝对路径、Base64、Data URL、鉴权信息或图片内容写入数据库、SSE 和日志。

## 非目标

- 不实现 OCR，不调用或修改 `ImageToText`。
- 不处理 PDF、Office、文本、代码、压缩包和任意文件资源；这些属于阶段 6。
- 不做 BMP、TIFF、SVG、AVIF 等图片转码。
- 不实现 Provider 失败后的动态降级或能力自动学习。
- 不开放生产附件 feature gate；阶段 5 验收后再决定默认开启。
- 不改变已发送消息的附件编辑边界，不实现文件夹上传。

## 已确认的产品决策

1. 采用中央 `AttachmentCapabilityRouter`；Provider adapter 只声明能力并转换请求。
2. 模型或 adapter 的图片能力为 `unsupported` 或 `unknown` 时都明确阻止运行。
3. 多附件采用全有或全无：任一附件不能发送，整条消息不调用 Provider。
4. `intent: auto` 在本阶段只尝试原生视觉；失败时不自动 OCR。
5. `intent: vision` 必须走原生图片；`ocr`、`document`、`tool_resource` 和 `workspace_reference` 在本阶段明确不可用。
6. 能力判断发生在队列真正执行时，而不是 Prompt admission 时。
7. 路由失败保留用户输入和附件卡片，run 进入 failed；用户可切模型、编辑移除附件或重试。
8. 被预检阻止的 run 不创建 Provider attempt，因为没有发生 Provider 调用。

## 总体运行流程

```text
SessionRunExecutor
  → 读取 session / input / run
  → 读取执行时 runtime.provider + runtime.model
  → AttachmentCapabilityRouter 评估整批附件
  → AttachmentApplicationService 解析 ready asset
  → AttachmentBlobStore 返回验证过的内部只读路径
  → 生成 [TextBlock?, ImageBlock...]，保持附件顺序
  → 写 run.metadata + direct transformation
  → 获取 Agent、setModel、submitMessage
  → QueryEngine 维护多轮历史
  → Provider adapter 转成各自请求
```

路由不通过时，流程在获取 Agent 前停止，Provider SDK 调用次数必须为零。

## 能力模型

### 统一类型

能力类型放在可被 API、Server 和设置层复用的位置：

```ts
export type InputSupport = "native" | "unsupported" | "unknown";

export interface ModelInputCapabilities {
  image: InputSupport;
}

export interface ProviderInputCapabilities {
  image: InputSupport;
  imageMediaTypes: readonly string[];
}
```

`native` 表示这层能正确处理图片；`unsupported` 表示明确不能；`unknown` 表示没有足够证据。只有模型和 adapter 都是 `native`，并且 MIME 在 adapter 白名单中时才允许发送。

### 内置模型

model catalog 的映射规则固定为：

- `modalities.input` 包含 `image`：`native`；
- 明确存在 `modalities.input` 但不包含 `image`：`unsupported`；
- 没有输入模态信息：`unknown`。

不再用模型 ID、显示名或厂商关键词猜视觉能力。现有 `vision` 可暂时作为展示兼容字段，但路由只读取新的 `inputCapabilities.image`。

### 自定义 Provider 模型

`CustomProviderModelSettings` 和对应 Desktop 表单增加显式字段：

```ts
imageInputSupport: "native" | "unsupported" | "unknown";
```

新建模型默认 `unknown`，用户可以明确选择“支持图片”或“不支持图片”。旧设置缺少字段时按 `unknown` 读取，不根据模型名补值，也不进行数据迁移。

### Adapter 声明

- OpenAI compatible adapter：`image=native`，允许 PNG、JPEG、GIF、WebP。
- Codex adapter：`image=native`，允许 PNG、JPEG、GIF、WebP。
- Anthropic adapter：`image=native`，按当前 SDK 类型允许 PNG、JPEG、GIF、WebP。
- 未声明图片能力的 adapter：`image=unknown`。

OpenAI compatible 只表示适配器能构造标准图片请求，不保证任意兼容网关都实现图片输入；实际拒绝归类为 `provider_capability_mismatch`。

## 路由器边界

`packages/server/src/application/attachment-routing/` 新建纯判断和物化模块：

```ts
interface RouteAttachmentBatchInput {
  provider?: string;
  model: string;
  modelCapabilities: ModelInputCapabilities;
  providerCapabilities: ProviderInputCapabilities;
  content: string;
  attachments: SessionInputAttachmentRecord[];
  signal: AbortSignal;
}

interface NativeAttachmentRouteResult {
  status: "native";
  content: ContentBlock[];
  decisions: AttachmentRouteDecision[];
}
```

路由分两步：

1. 纯判断检查 intent、附件 kind、模型能力、adapter 能力和 MIME 白名单；
2. 只有整批判断通过后才物化文件，验证资产为 ready、Blob 为普通文件且大小一致，然后生成 `ImageBlock`。

全部判断与物化成功后才返回 `ContentBlock[]`。文字非空时位于第一块；图片按 input attachment `seq` 排序。纯附件消息不补空文本块。

## Blob 路径与生命周期

现有 `AttachmentBlobStore.open()` 适合 HTTP 流式下载，但 QueryEngine 会在后续轮次重用历史中的 `ImageBlock.source.path`，因此不能使用一次性临时文件。

阶段 4 增加窄方法 `resolveReadOnlyPath(sha256, expectedSizeBytes)`：

- 校验 SHA-256 格式；
- 路径只能由固定 `blobsRoot/<前两位>/<sha256>` 生成；
- 打开并校验是普通文件且大小一致；
- 返回 daemon 内容寻址 Blob 的稳定路径；
- 不接受任意调用方路径，不返回 staging 路径。

`AttachmentApplicationService.resolveReadyContentPath(assetId)` 先校验资产存在且为 ready，再调用 Blob Store。原文件路径和 `originalPath` 永远不进入 Core block。

Blob 当前不可变且阶段 1 不做物理 GC，路径可在热 Agent 的多轮历史中稳定重用。durable transcript 仍只保存 `assetId` 和安全快照；运行时路径只存在于内存消息中。

## Core 输入结构

沿用现有 `TextBlock | ImageBlock`，收紧 `ImageBlock` 来源语义：

```ts
interface ImageBlock {
  type: "image";
  source: {
    type: "file";
    mediaType: string;
    path: string;
    sizeBytes?: number;
  };
}
```

不再生成 `originalPath`。Server 只把自己管理的 Blob 路径传给 Core。`QueryEngine.submitMessage()`、历史压缩与 follow-up 必须保留结构化块，不能把图片转成 `[image]` 或丢弃。

## Provider 转换

### OpenAI Chat Completions

`TextBlock` 转为 `{ type: "text", text }`；`ImageBlock` 读取内部 Blob 并转为 `{ type: "image_url", image_url: { url: "data:<mime>;base64,..." } }`。无图片时继续发送普通字符串，避免无意义的请求形状变化。

### Codex Responses

`TextBlock` 转为 `{ type: "input_text", text }`；`ImageBlock` 转为 `{ type: "input_image", image_url: "data:<mime>;base64,..." }`。用户图片不得替换成 `[image]`。阶段 4 不扩展图片型 tool result。

### Anthropic Messages

删除当前 `msg.content as Anthropic.TextBlockParam[]`。`convertMessages()` 改成异步转换，图片生成：

```ts
{
  type: "image",
  source: {
    type: "base64",
    media_type: "image/png",
    data: "..."
  }
}
```

`media_type` 严格收窄为当前 `@anthropic-ai/sdk@0.40.1` 接受的 `image/jpeg | image/png | image/gif | image/webp`。非法格式在请求前失败。

三种 adapter 都只负责格式转换，不做 OCR、不删除块、不根据请求错误重发纯文本。Data URL/Base64 只在请求内存中存在。

## 运行记录、attempt 与 transformation

### Run metadata

路由结果合并写入现有 `SessionRunRecord.metadata.attachmentRouting`：

```ts
{
  version: 1,
  status: "native" | "blocked",
  provider?: string,
  model: string,
  evaluatedAt: number,
  errorKind?: AttachmentRoutingErrorCode,
  attachments: Array<{
    assetId: string;
    intent: AttachmentIntent;
    mediaType: string;
    route: "native" | "blocked";
    errorKind?: AttachmentRoutingErrorCode;
  }>;
}
```

更新时保留原有 trace、恢复和来源 metadata。这里不写路径和图片字节。

### Attempt

预检失败没有 Provider 请求，因此不创建 `SessionRunAttemptRecord`。路由通过后继续由现有 Agent 事件创建 attempt。Provider 实际拒绝图片时，失败 attempt 使用 `errorKind=provider_capability_mismatch`。

### Transformation

成功物化的图片写入 `kind=direct`、`status=completed`、`processor=native-image-router@1` 的 transformation part。它表示图片准备完成，不表示模型回答成功。

预检失败时，为直接相关的附件写 failed transformation 和稳定 `transformationError`。因同批其他附件失败而未发送的正常附件不能标成 completed。

## 错误与结算

稳定错误码为：

- `attachment_model_capability_unknown`
- `attachment_model_unsupported`
- `attachment_provider_capability_unknown`
- `attachment_provider_unsupported`
- `attachment_kind_unsupported`
- `attachment_intent_unavailable`
- `attachment_media_type_unsupported`
- `attachment_content_unavailable`
- `attachment_content_invalid`
- `provider_capability_mismatch`

路由错误带 `code`、安全用户文案、相关 `assetIds` 和 `retryable`。`SessionRunExecutor` 在同一事务中写 transformation、`session.run.error`、run metadata、run failed 和未完成 part 结算，然后发布 SSE。

Executor 记录是否已经获取 Agent。预检失败时不调用 `agentPool.close()`，避免一条不支持的图片消息销毁现有热 Agent；获取 Agent 后发生的执行失败继续按现有规则关闭。

中断优先于能力错误：路由和文件校验都接收 `AbortSignal`。信号已取消时 run 进入 interrupted，不写误导性的附件能力错误。

## Desktop 行为

阶段 4 不重做 Composer。历史中的 attachment 卡片继续保留；direct transformation 用现有 transformation 槽位展示。

运行被阻止时显示标准错误和可执行建议：切换支持图片的模型、编辑并移除附件、重试。不得出现“忽略图片继续”“自动 OCR”或“只发送文字”。重试必须重新读取执行时能力。

自定义 Provider 模型表单增加图片能力选择，默认“未知（会阻止图片运行）”。模型选择器可显示图片支持状态，但不能把展示状态当作第二套能力来源。

生产附件入口继续受现有 feature gate 控制；本阶段只允许开发和测试验证完整原生图片链路。

## 安全要求

1. 路由器只接受 durable asset ID，不接受客户端路径或 URL。
2. Blob 路径只能由验证过的 SHA-256 在 daemon 固定目录内生成。
3. 物化前验证 ready 状态、普通文件和精确大小。
4. Provider 转换不读取 `originalPath`，不进行网络图片抓取，避免 SSRF。
5. MIME 白名单同时由中央路由和具体 adapter 类型收窄保护。
6. Base64、Data URL、路径和图片字节不进入 metadata、SSE、错误文案和日志。
7. 多附件整批判断通过后才调用 Provider，不允许部分发送。
8. AbortSignal 贯穿路由、文件校验和 Provider 请求。

## 测试策略

### 单元与 contract test

- capability 三态交集矩阵；
- 内置 catalog modality 映射和自定义模型显式配置；
- intent、MIME、纯附件、多附件顺序和全有或全无；
- Blob 路径越界、非法 SHA、文件缺失、非普通文件、大小不符；
- OpenAI、Codex、Anthropic 精确请求结构；
- Anthropic 合法 base64 source 和四种 MIME 收窄；
- blocked 路径 Provider 调用次数为零；
- Data URL、绝对路径和原始路径不出现在持久记录与事件中。

### 集成与回归

- `SessionRunExecutor` 从 durable refs 构造 ordered `ContentBlock[]`；
- 排队期间切换模型后使用执行时能力；
- 多轮 QueryEngine 能继续读取上一轮稳定 Blob 路径；
- retry、edit、fork 和 restart 后仍按 ordered refs 重新物化；
- 预检失败不获取/关闭 Agent，不创建 attempt，run 和 part 正确结算；
- Provider mismatch 正确落到失败 attempt；
- interrupt 在预检和 Provider 请求阶段都正确终止；
- 纯文本消息行为完全不变。

### 验证命令

实施阶段至少执行：

```powershell
pnpm --filter @vykor/services test
pnpm --filter @vykor/api test
pnpm --filter @vykor/server test
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/desktop test -- --maxWorkers=1
pnpm --filter @vykor/services check-types
pnpm --filter @vykor/api check-types
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/agent-runtime check-types
pnpm --filter @vykor/desktop typecheck
pnpm check-docs
git diff --check
```

最终还要运行全仓 `pnpm check-types`。全仓 lint 若仍受既有 Desktop 基线影响，必须对本阶段改动文件执行 scoped ESLint，并明确记录全量基线，不得把新错误混入旧基线。

## 验收标准

1. 支持图片的模型通过 OpenAI、Codex 或 Anthropic 收到真实图片块和正确顺序。
2. 模型/adapter 不支持或未知时，run 在 Provider 请求前明确失败，调用次数为零。
3. 任一附件不合法时整条消息不发送，没有图片或文本被静默丢弃。
4. Anthropic 不再使用错误类型断言，发送 SDK 接受的 base64 image source。
5. run metadata 能解释每个附件的 route；失败使用稳定错误码。
6. blocked run 不创建 attempt、不关闭已有 Agent；Provider mismatch 才产生失败 attempt。
7. 排队切模、retry、edit、fork、restart 和多轮历史均使用 daemon Blob，不依赖原文件。
8. 数据库、SSE 和日志中没有 Base64、Data URL、原始路径或 Blob 绝对路径。
9. 纯文本会话和现有工具调用没有回归。
10. 生产附件 feature gate 保持关闭，`ImageToText` 没有被调用或修改。

## 实施边界

阶段 4 完成后，系统已经具备可靠的原生图片路径，但不把“不支持图片时的体验”伪装成成功。阶段 5 再把 `ImageToText` 改为本地 OCR 工具，并由主 Agent 在不支持图片时主动调用；这两个阶段之间保持清晰边界。

## 实施结果与验证证据

阶段 4 已按本设计落地：

- 内置模型从 catalog 输入模态得到 `native | unsupported | unknown`；自定义模型在设置页显式选择，缺省严格为 `unknown`。
- `AttachmentBlobStore` 只返回 SHA-256 内容寻址目录中的普通文件，并校验精确大小；路由器先判断整批 intent、MIME 和能力，再按 `seq` 物化。
- OpenAI Chat Completions、Codex Responses 与 Anthropic Messages 都有真实文件字节和顺序 contract test；Anthropic 已改成合法 base64 image source。
- `SessionRunExecutor` 在获取 Agent 前完成附件预检。blocked run 不获取或关闭 Agent、不产生 Provider attempt，并写入稳定错误码、run metadata、事件和 failed transformation。
- direct 路由提交 `[TextBlock?, ...ImageBlock[]]`，纯文本仍沿用原字符串输入；Desktop 展示 direct 状态和可操作的中文阻止原因。
- Provider 返回明确的图片能力 400 拒绝时，归一化为 `provider_capability_mismatch`，不进行纯文本重发或动态改写模型配置。

2026-08-28 的新鲜验证结果：

- API：8 个测试文件、68 个测试通过；Provider 定向合同与错误分类为 32 个测试通过。
- Agent Runtime：11 个测试文件、87 个测试通过。
- Server：48 个测试文件、367 个测试通过。
- Services：附件定向 14 个测试通过；全量 180 个测试中 179 个通过，唯一失败仍是 Windows 上既有的“停止 shell 时清理孙进程”超时，和本阶段无关，实施前基线也可稳定复现。
- Desktop：本阶段新增/相关定向 10 个测试通过；全量 305 个测试中 304 个通过，另有一个既有 5,000 文件枚举超时；`session-service.test.ts` 因隔离工作树 Electron postinstall 未完整执行而无法收集，和本阶段源码无关。
- Core、API、Services、Server、Desktop Node、Desktop Web、CLI 的直接 TypeScript 检查均通过。

生产附件入口仍由 `VYKOR_DESKTOP_ATTACHMENTS=1` 控制，默认未开放。`packages/tools/src/media/image-to-text.ts` 没有改动，也没有被接成自动降级；本地 OCR 继续归阶段 5。
