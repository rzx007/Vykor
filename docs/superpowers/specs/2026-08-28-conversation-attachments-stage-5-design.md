# 对话附件阶段 5：本地 OCR 与 ImageToText 设计

> 状态：已实现并验收（2026-08-28）。本文把总路线中已经确认的阶段 5 边界细化为可实现规格；不重新引入远程视觉模型，也不兼容旧的 `ImageToText` 输入或结果。

## 目标与边界

阶段 5 完成两条图片路径：支持图片的模型继续收到原生图片；不支持图片或能力未知的模型收到附件身份、文件信息和明确的 `ImageToText` 调用提示，由主 Agent 自己发起正常工具调用。本地 OCR 只提取可见文字，不描述人物、物体、颜色、图表含义或空间关系。

本阶段不做 PDF/Word/代码提取、文件夹遍历和任意文件挂载，这些仍属于阶段 6。旧 `ImageToText` 的 `prompt`、远程 Provider 请求、Data URL、`visionModel` 和自由 URL 直传全部删除，不提供兼容层。

## 运行流程

1. `SessionRunExecutor` 取得运行时真实模型能力和该 Agent 实际可见的工具目录。
2. `AttachmentCapabilityRouter` 对每个图片决定 `native_image` 或 `image_to_text_tool`。原生路径保持阶段 4 行为；OCR 路径生成纯文本资源说明，包含附件 ID、文件名、MIME、大小和只能调用 `ImageToText` 提取文字的边界提示。
3. OCR 路径只有在 `ImageToText` 实际可见、附件是受支持图片且 OCR 宿主已安装时才允许运行。工具被 allow/deny 排除时，在调用 Provider 前明确失败。
4. 主 Agent 调用 `ImageToText({ attachment_id })`。工具本身只校验输入并调用宿主能力，不读取设置、密钥或模型信息。
5. 宿主将 `attachment_id`、`image_path` 或 `image_url` 统一变成 Attachment Service 中的 ready asset，再交给 `LocalOcrService`。路径按会话 cwd 解析；URL 仅允许 HTTP(S)，逐次解析 DNS、阻止私网/环回/链路本地地址、限制重定向、响应大小、MIME 和总超时。
6. `LocalOcrService` 通过资产哈希、处理器版本、模型档位、locale、归一化版本和有效参数生成缓存键。命中 completed representation 直接复用；否则创建 running representation，读取只读 Blob，归一化图片并调用长生命周期 light-ocr engine。
7. 工具结果作为正常 `tool_use/tool_result` 出现在 transcript；结果 metadata 带 asset ID、representation ID 和 processor。零行结果返回 `no_text_detected` 成功状态，绝不补写图片描述。

## 组件边界

### `LightOcrEngine`

`packages/services/src/attachment-processing/light-ocr-engine.ts` 是 `@arcships/light-ocr@0.5.7` 的唯一适配层。它懒加载并复用一个 engine，队列容量固定且可配置，把 `AbortSignal` 传给 `recognizeEncoded`，在 daemon 关闭时显式 `close()`。单次任务有宿主超时，engine 的稳定错误码映射成 Vykor OCR 错误；初始化失败和推理失败不能伪装成无文字。

### 图片归一化

JPEG、PNG 在通过签名、尺寸和像素上限检查后直接识别。GIF、WebP、BMP 使用 `sharp` 解码第一帧、自动方向修正并输出受限 PNG；禁止动画逐帧 OCR。归一化后的字节只在内存中存在，缓存仍记录原始 asset 和归一化版本。默认上限为 40 MiB encoded、40 MP pixels、边长 16,384，超限返回 `ocr_resource_limit_exceeded`。

### representation 存储

新增 `attachment_representation` 表，保存状态、缓存键、文字、结构化 metadata、错误码和时间。`(asset_id, kind, cache_key)` 唯一；相同缓存键并发请求只允许一个执行者，其他调用等待或复用终态。失败记录可重试，但不会覆盖旧 completed 结果。缓存键不包含 Provider、主模型或 API 凭证。

### Agent OCR 宿主

Core 定义最小 `AgentImageToTextHost`，QueryEngine 只把宿主引用放入 `ToolContext`。Agent Runtime 仅在宿主存在时注册 `ImageToText`，因此工具目录反映真实可执行能力。daemon 用 Attachment Service、LocalOcrService 和安全来源导入器实现宿主；子 Agent 继承同一宿主和权限边界。

## 工具契约

输入三选一，禁止未知字段：

```ts
type ImageToTextInput =
  | { attachment_id: string }
  | { image_path: string }
  | { image_url: string }
```

输出使用一段有明确来源边界的文本给模型，同时在 result metadata 保存结构化信息：

```ts
interface ImageToTextMetadata {
  status: "completed" | "no_text_detected"
  assetId: string
  representationId: string
  processor: "light-ocr"
  processorVersion: "0.5.7"
  cached: boolean
  lineCount: number
  durationMs: number
}
```

文字按 reading order 用换行连接并限制为 100,000 字符；完整行坐标、置信度、页码和 timing 保存在 representation metadata。OCR 文本被标为不可信附件数据，不能覆盖系统或开发者指令。

## 路由和失败语义

- `auto`：模型和 Provider 都原生支持时走 `native_image`，否则走 `image_to_text_tool`。
- `vision`：原生支持时直传；不支持时允许 OCR 降级，但提示模型只能获得文字，不能声称理解完整视觉内容。
- `ocr`：无论主模型是否多模态，都走 `image_to_text_tool`。
- 非图片 intent 和 PDF 仍明确阻止，留给阶段 6。
- OCR 工具不可见、宿主缺失、格式不支持、资源超限、下载受阻、取消、超时、包加载和推理失败都有稳定错误码。只有明确的瞬时 `inference_failed` 可在同一次工具调用中重试一次；损坏图片、策略拒绝和资源超限不重试。

## 生命周期与审计

daemon 拥有一个 `LocalOcrService`，启动不预热，首次调用才创建 engine；关闭顺序在 Store 关闭前停止接单、取消等待者并释放 engine。OCR 记录次数、缓存命中、耗时、像素和错误码，不记录正文、base64、URL 查询参数、路径内容或 Provider token。interrupt 通过 run signal 一直传到下载、Blob 读取、归一化和 light-ocr worker。

## UI 与发布

原生路径继续显示“已作为原生图片输入”。OCR 路由不创建虚假的系统 transformation；真正调用后，现有工具卡显示 `ImageToText`，并补充“已使用本地 OCR 提取文字”或“未检测到文字”。附件级失败显示可重试文案。

阶段 5 验收后，打包版默认开放附件交互，不再依赖 `VYKOR_DESKTOP_ATTACHMENTS=1`；环境变量只保留显式关闭用途。发布清单包含 light-ocr、runtime、当前平台原生包、模型、Apache-2.0 NOTICE，以及 sharp 的许可证和 Electron asar unpack/签名检查。支持 Windows/macOS/Linux 的 x64/arm64 组合以依赖声明和打包 smoke test 为准。

## 验收标准

- 自定义模型声明图片支持时仍走阶段 4 原生路径；声明不支持或未知时走 OCR 工具提示。
- 被 allow/deny 排除的 `ImageToText` 在 Provider 请求前阻止运行并给出可诊断错误。
- 工具源码和运行测试证明它不读取模型/Provider 配置，也不发起远程视觉请求。
- attachment ID、本地路径和安全 URL 最终调用同一个 `LocalOcrService`。
- engine 初始化、并发、缓存、取消、关闭、错误映射、零文字和 normalization 都有测试。
- tool use/result 关联 representation；retry、fork、replay 复用相同缓存。
- Desktop 打包入口默认可用，OCR 状态文案和重试入口可见，阶段 4 原生图片与纯文本不回归。

## 验收记录（2026-08-28）

- 真实 `@arcships/light-ocr@0.5.7` 冒烟测试使用 Sharp 动态生成确定性图片，识别出文字、坐标和置信度；测试不下载模型，也不调用远程视觉服务。
- 全仓 `pnpm test` 首次暴露运行时打包后的 `createRequire` 重名，修复后真实 daemon + SSE 用例单独通过；最终全仓测试重新执行并以零失败为完成门槛。
- `pnpm check-types` 为 57/57 个任务通过；`pnpm check-docs` 检查 108 个 Markdown 文件通过。根 `pnpm lint` 因仓库没有任何 Turbo `lint` 任务而无法运行，改用定向静态检查和 `git diff --check`，不把脚本缺失描述成 lint 通过。
- Desktop production build 和 Windows x64 `electron-builder --dir` 通过；解包产物验证确认模型 manifest、light-ocr runtime、`light_ocr_node.node`、PDFium 原生模块、Sharp 原生模块及许可文件均存在。
- 生产附件入口默认开放；设置 `VYKOR_DESKTOP_ATTACHMENTS=0` 时明确关闭。“添加文件夹”图标和禁用菜单项保留。
