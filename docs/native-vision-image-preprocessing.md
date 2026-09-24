# 原生视觉图片预处理

> 状态：当前原生视觉图片进入模型前的处理、缓存与失败边界。

这份文档说明用户图片从 `ImageBlock` 进入模型请求前实际发生什么，重点回答：

- 为什么原图不能直接塞进 Provider 请求
- 图片什么时候进入消息历史
- 怎样保证最长边和请求体大小
- 同一张图怎样复用，什么时候清理
- 失败后为什么不会把当前会话持续卡在 413

## 为什么需要这一层

OpenAI、Anthropic 和 Codex 的图片请求最终都包含 base64。base64 通常比原始二进制多约三分之一体积；如果直接读取几十 MiB 的原图并放进 JSON，请求可能先被网关以 HTTP 413 拒绝，还没有到模型。

另一个风险是历史污染。如果图片先进入消息历史，之后才发现无法发送，后续每一轮都会再次带上同一张失败图片，导致会话持续失败。

因此，内置视觉客户端遵守两条顺序约束：

1. 先把当前用户图片准备到受控尺寸和体积。
2. 全部准备成功后，才把当前用户消息写入历史。

## 当前硬限制

- CLI 默认最多接收 4 张图片。
- 单个源图片默认不超过 20 MiB。
- 解码输入默认不超过 4000 万像素。
- 模型实际接收的图片最长边不超过 2000px。
- 模型实际接收的单图 base64 不超过 5 MiB。
- GIF 和动态 WebP 只处理第一帧。
- 图片只缩小，不会把小图放大。
- 准备器不写压缩后的磁盘副本。

`ImageBlock.source.path` 仍指向接入层已经管理的持久原图。CLI 等接入层原本就可能把临时输入导入自己的附件目录；这里的保证是视觉准备器不会再产生一份 JPEG 或 PNG 压缩副本。

## 一次图片请求怎样运行

```text
用户消息
  ↓
QueryEngine 调用客户端 prepareUserContent
  ↓
按原图路径、大小、修改时间等查进程内缓存
  ├─ 命中：刷新最后使用时间
  └─ 未命中：读取并用 Sharp 准备
       ├─ 成功：写入缓存，返回轻量元数据
       └─ 失败：抛错，不写当前用户消息历史
  ↓
QueryEngine 写入带准备元数据的用户消息
  ↓
Provider 构造请求时再次经过同一准备器
  ↓
OpenAI/Codex data URI 或 Anthropic base64 block
```

Provider 发送阶段再次经过准备器不是重复压缩。正常情况下会命中同一个进程内缓存；这样恢复旧会话时，即使旧 `ImageBlock` 没有准备元数据，也不能绕过尺寸和体积限制。

## 历史写入是原子的

直接提交的用户消息会先执行准备，再调用 `messages.push`。准备失败时，历史保持提交前的状态。

steer/follow-up 也遵守同一规则。一批 follow-up 会先并行准备，只有全部成功才一起写入；其中一张图片失败，不会留下半批消息。

`StreamingMessageClient.prepareUserContent` 是可选接口，因此第三方客户端保持源码兼容。上述图片安全保证由实现该接口的内置 OpenAI、Anthropic 和 Codex 客户端提供；第三方客户端如果要提供同等保证，也应实现自己的准备能力。

## 图片怎样缩放和压缩

### 可以原样保留的情况

单帧 PNG、JPEG 或 WebP 同时满足以下条件时，直接复用原始字节：

- 图片方向不需要 EXIF 旋转
- 最长边不超过 2000px
- base64 不超过 5 MiB

输出 MIME 由 Sharp 检测到的真实格式决定，不直接相信文件扩展名或调用方声明。

### 需要重新编码的情况

其余图片先应用 EXIF 方向并按比例缩到最长边 2000px，然后按下面的顺序尝试：

1. PNG
2. JPEG quality 85
3. JPEG quality 75
4. JPEG quality 60

任何一步达到 5 MiB base64 限制就停止。如果仍然太大，宽高同时乘以 0.75，再重复整套编码阶梯，直到成功或已经无法继续缩小。

转成 JPEG 时，如果图片有透明区域，会先铺白色背景，避免透明像素变黑。

## 缓存怎样工作

缓存只存在于当前 Node.js 进程内，不写数据库，也不写准备后的图片文件。每项保存：

- canonical base64
- 输出 MIME
- 输出宽高
- 编码后二进制字节数
- base64 字节数
- 策略版本

缓存键包含规范化路径、源文件大小、修改时间、声明 MIME、策略版本和关键限制。文件发生变化或策略升级后，不会误用旧结果。

默认清理规则：

- 最多 32 项
- base64 总量最多 64 MiB
- 连续 15 分钟未使用就过期
- 每次命中都会刷新空闲时间
- 每分钟执行一次过期清扫
- 超过容量时删除最久未使用的项
- 缓存为空后停止清扫定时器
- 定时器调用 `unref()`，不会阻止进程退出

准备失败不会进入缓存。

## 并发与取消

同一缓存键同时被多个请求使用时，只运行一份 Sharp 准备任务，其他调用方等待同一个结果。

每个调用方的取消相互独立：

- 一个调用方取消，不会让仍在等待的其他调用方失败。
- 所有等待者都取消后，底层任务会停止后续读取或编码步骤。
- 已取消或句柄关闭失败的任务不会发布缓存结果。
- 新请求不会加入一个已经取消、但尚未清理完的旧任务。

## 历史里保存什么

历史不保存 base64，只保存原图引用和轻量元数据：

```text
ImageSource
  type: file
  path: 持久原图路径
  mediaType: 原图声明 MIME
  sizeBytes: 可选源文件大小
  prepared:
    mediaType: 实际输出 MIME
    width: 实际输出宽度
    height: 实际输出高度
    base64Bytes: 实际 base64 字节数
    policyVersion: 准备策略版本
```

这样会话历史保持较小，也不会因为把图片字节写进历史而增加持久化和恢复成本。

## 图片 token 怎样估算

有准备元数据时，`CompactService` 按 28×28 像素 patch 粗估图片 token：

```text
ceil(width / 28) × ceil(height / 28)
```

最后再与文字 token 一起应用全局安全余量。旧历史没有准备元数据时，仍使用每张图片 3072 的基础回退估值，再应用同一安全余量。

这只是触发上下文压缩的本地近似值，不代表 Provider 最终账单。

## 失败类型与用户可见结果

准备器区分四类失败：

- `source_too_large`：源文件超过读取保护上限。
- `invalid_image`：文件损坏、格式无效、缺少尺寸或 Sharp 无法处理。
- `output_too_large`：压缩和缩小后仍无法满足 base64 上限。
- `aborted`：当前请求被取消。

对当前用户消息的共同结果是：错误发生在写历史之前，不会把失败图片留给下一轮重试。

HTTP 413 仍可能来自整次请求的总大小、网关自定义限制或大量其他上下文，但不会再由一张不受控的原图直接进入内置 Provider 请求造成。

## 代码入口

- 历史写入前预检：`packages/core/src/engine/query-engine.ts`
- 图片元数据类型：`packages/core/src/types/messages.ts`
- 可选客户端准备接口：`packages/core/src/types/client.ts`
- 图片 token 估算：`packages/core/src/engine/compact-service.ts`
- Sharp 准备器和缓存：`packages/api/src/providers/vision-image-preparer.ts`
- 共享准备器与历史元数据：`packages/api/src/providers/native-image-payload.ts`
- OpenAI 出口：`packages/api/src/providers/openai.ts`
- Anthropic 出口：`packages/api/src/providers/anthropic.ts`
- Codex 出口：`packages/api/src/providers/codex.ts`
- CLI 源图保护：`apps/cli/src/commands/main.ts`

## 修改后怎样验证

最小回归范围：

```powershell
pnpm --filter @vykor/core test
pnpm --filter @vykor/api test
pnpm --filter @rzx/ohs test
pnpm check-types
pnpm check-docs
```

准备器测试重点覆盖原字节保留、EXIF 方向、2000px、压缩阶梯、真实动画首帧、损坏和超限图片、文件变化竞态、并发去重、独立取消、滑动 TTL、LRU 和缓存字节上限。

## 不在这一层处理的内容

- 不修改 OCR 图片归一化流程。
- 不改变 tool result 图片目前使用占位文本的行为。
- 不持久化准备后的 base64 缓存。
- 不保证整次多图请求一定小于每个外部网关的自定义总请求上限。
