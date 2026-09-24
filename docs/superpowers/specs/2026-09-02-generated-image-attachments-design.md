# 生成图片正式接入附件系统设计

## 目标

`ImageGeneration` 生成或下载的每张图片都必须成为正式的 `attachment_asset`，并在产生它的助手消息中显示为可预览、可打开、可另存为的图片附件。生成图片不再写入独立的 `~/.vykor/images` 目录，也不再把本机绝对路径当作持久标识。

## 不在本次范围内

- 不修改 Agnes 的模型、请求字段和凭据配置规则。
- 不新增图片编辑器、图库或单独的生成历史页面。
- 不自动重试 429 请求。
- 不改造所有 Tool 的二进制输出，只处理 `ImageGeneration`。

## 方案选择

采用“Tool 产出结构化资产元数据，消息投影负责持久关联”的方案：

1. Tool 只负责调用 Agnes、校验图片、导入附件系统并返回结果。
2. `SessionTranscriptProjection` 是 Tool 结果转成消息部件的唯一入口；它根据 `metadata.generatedImages` 创建助手消息的 `attachment` 部件。
3. 桌面端复用现有 `MessageAttachment`，在助手消息中渲染这些部件。

不采用以下方案：

- Tool 直接写 `session_message_part`：会让领域 Tool 依赖会话数据库，破坏现有事件投影边界。
- 桌面端临时解析 Tool 输出：刷新和恢复后缺少正式附件引用，服务端清理也无法判断资产仍被使用。

## Tool 与附件导入

`createDaemonImageGenerationTool` 接收由 daemon 注入的附件服务，能力限定为 `limits`、`import` 和失败补偿所需的 `delete`。daemon 在创建视觉 Tool 时传入已经初始化的 `this.attachments`。

Base64 结果先解码为字节，使用现有媒体类型嗅探识别 PNG、JPEG、GIF 或 WebP，再以字节流调用 `AttachmentApplicationService.import()`。URL 结果复用 `downloadRemoteImage()`，继承公网地址限制、重定向限制、图片 Content-Type 校验和 40 MiB 下载上限，然后同样导入附件服务。

每个成功资产在 Tool 结果中返回：

```ts
metadata: {
  generatedImages: [{
    assetId: string,
    displayName: string,
    mediaType: string,
    sizeBytes: number,
  }]
}
```

Tool 的文本结果只提供简短状态和 `assetId`，不再返回内部 blob 路径。若一批结果在中途失败，Tool 对本次已导入但尚未返回的资产执行软删除补偿，避免留下不可达的 ready 资产。

## 消息投影

收到成功的 `tool_use_end` 后，`SessionTranscriptProjection` 先照常完成 Tool 部件，再严格校验 `metadata.generatedImages`。每张图片创建一个稳定 ID 的助手消息附件部件：

```text
generated-attachment:<toolUseId>:<index>
```

附件部件使用：

```ts
{
  type: "attachment",
  status: "completed",
  intent: "tool_resource",
  assetId,
  displayName,
  mediaType,
  sizeBytes,
  metadata: {
    source: "image_generation",
    toolUseId,
  },
}
```

稳定 ID 保证事件重放和重复投影不会生成重复图片部件。无效或不完整的结构化元数据不会被投影为附件。

## 引用与生命周期

当前“附件是否被会话使用”的判断只统计 `session_input_attachment`。本次将正式引用扩展为两类之和：

- 用户输入引用：`session_input_attachment.asset_id`
- 消息部件引用：`session_message_part.type = 'attachment' AND asset_id = ?`

删除未引用附件和附件垃圾回收都使用统一引用计数。只要生成图片仍出现在助手消息里，就不能被误判为未引用资产。

## 桌面显示

助手消息渲染器从消息部件中提取 `type: "attachment"` 的部件，并使用现有的 `AttachmentGroup` 与 `MessageAttachment` 显示。图片沿用现有预览流程：桌面主进程通过 `assetId` 请求 daemon 的 `/attachments/:id/content`，Renderer 创建临时 Object URL 展示。

同一条助手消息中的多张生成图片组成一个附件组；工具活动和文字回复继续沿用当前显示方式。附件组放在助手消息内容流中 Tool 调用之后，保证生成完成时即可出现。

## 错误与安全

- 非图片 Base64 内容拒绝导入并返回 provider 类错误。
- URL 必须通过现有安全下载器，拒绝本机、内网和非 HTTP(S) 地址。
- 文件大小同时受安全下载器和附件服务上限保护。
- 失败信息继续经过 Agnes key 脱敏。
- 中途失败执行尽力补偿；补偿失败不覆盖原始错误。

## 测试

1. Tool 测试：Base64 和 URL 结果进入附件服务，返回资产元数据，不再创建本地图片路径。
2. Tool 测试：非图片、超限和中途失败触发错误与资产补偿。
3. daemon 接线测试：创建 Tool 时注入同一个附件服务。
4. 投影测试：成功结果生成助手附件部件；重复事件保持幂等；错误或畸形元数据不生成附件。
5. Store 测试：助手附件引用会阻止未引用删除，并被 GC 识别为引用。
6. Renderer 测试：助手内容模型保留附件部件，组件使用现有附件预览卡显示。
7. 完整验证：server、services、desktop 定向测试，相关类型检查，以及 `git diff --check`。
