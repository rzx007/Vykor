# 生成图片接入附件系统实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 在当前会话中逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 `ImageGeneration` 产物存入正式附件资产库，并在产生它的助手消息中显示为可预览、打开和另存为的图片附件。

**架构：** daemon 向图片 Tool 注入 `AttachmentApplicationService`。Tool 导入图片并在结果元数据中返回资产描述，`SessionTranscriptProjection` 把描述转换为持久的助手附件部件，桌面助手消息复用现有 `MessageAttachment` 渲染。附件引用计数同时覆盖用户输入和消息附件部件。

**技术栈：** TypeScript、Vitest、React、Electron、SQLite、Node.js Fetch/Web Streams。

---

### 任务 1：图片 Tool 导入正式附件资产

**文件：**

- 修改：`packages/server/src/application/visual-tools/daemon-image-generation-tool.ts`
- 修改：`packages/server/src/application/visual-tools/__test__/daemon-image-generation-tool.test.ts`
- 修改：`packages/server/src/application/daemon-application.ts`

- [ ] **步骤 1：编写失败测试**

测试使用完整的 PNG 字节 fixture，向 Tool 注入可观察的附件服务，断言 `b64_json` 被传给 `attachments.import()`，返回结果不含本机图片路径，并包含：

```ts
metadata: {
  generatedImages: [{
    assetId: "att-generated",
    displayName: "generated-image-1.png",
    mediaType: "image/png",
    sizeBytes: 68,
  }],
}
```

增加 URL 用例，注入安全下载函数并断言结果同样进入附件服务；增加第二张图片失败的用例，断言第一张资产调用 `attachments.delete()` 做补偿。

- [ ] **步骤 2：运行测试验证失败**

运行：

```powershell
pnpm --filter @vykor/server exec vitest run src/application/visual-tools/__test__/daemon-image-generation-tool.test.ts
```

预期：创建 Tool 时缺少新的附件服务参数契约，且结果仍返回本机路径。

- [ ] **步骤 3：实现最少代码**

定义 `DaemonImageGenerationToolOptions`，要求注入：

```ts
attachments: Pick<AttachmentApplicationService, "limits" | "import" | "delete">
downloadRemoteImage?: typeof downloadRemoteImage
```

删除 `IMAGES_DIR`、`mkdir`、`writeFile` 和本机路径生成。Base64 分支进行大小预检和媒体类型嗅探，URL 分支调用安全下载器；两者都调用 `attachments.import()`。成功时返回 `metadata.generatedImages`，失败时软删除本轮已导入资产。

- [ ] **步骤 4：完成 daemon 接线**

在 `DaemonApplication` 中改为：

```ts
createDaemonImageGenerationTool({ attachments: this.attachments })
```

- [ ] **步骤 5：运行定向测试验证通过**

运行任务 1 的 Vitest 命令，预期全部通过。

### 任务 2：把生成资产投影为助手消息附件

**文件：**

- 修改：`packages/server/src/application/session/transcript-projection.ts`
- 修改：`packages/server/src/application/session/__test__/transcript-projection.test.ts`

- [ ] **步骤 1：编写失败测试**

发送一个成功的 `tool_use_end`，结果包含两个 `metadata.generatedImages` 条目，断言同一助手消息新增两个 `type: "attachment"` 部件，字段为 `assetId/displayName/mediaType/sizeBytes/intent: "tool_resource"`。

增加重复投影用例，断言稳定 ID `generated-attachment:<toolUseId>:<index>` 不产生重复部件；增加畸形元数据用例，断言不会创建不完整附件。

- [ ] **步骤 2：运行测试验证失败**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/session/__test__/transcript-projection.test.ts
```

预期：现有投影只保存 Tool 部件，没有助手附件部件。

- [ ] **步骤 3：实现最少投影逻辑**

在 `tool_use_end` 分支解析 `metadata.generatedImages`，严格接受非空 `assetId/displayName/mediaType` 和非负安全整数 `sizeBytes`，使用稳定 ID upsert 附件部件并写入来源元数据。

- [ ] **步骤 4：运行投影测试验证通过**

运行任务 2 的 Vitest 命令，预期全部通过。

### 任务 3：让消息附件成为正式引用

**文件：**

- 修改：`packages/services/src/session-runtime/store.ts`
- 修改：`packages/services/src/session-runtime/__test__/store.test.ts`
- 修改：`packages/services/src/attachment/attachment-integrity-service.ts`
- 修改：`packages/services/src/attachment/__test__/attachment-integrity-service.test.ts`

- [ ] **步骤 1：编写失败测试**

在 ready 资产对应的助手消息中创建 `type: "attachment"` 部件，断言 `softDeleteUnreferencedAttachment()` 抛出 `attachment_in_use`。为已软删除但仍被消息附件引用的资产运行 GC，断言它计入 `skipped.referenced` 且 blob 保留。

- [ ] **步骤 2：运行测试验证失败**

```powershell
pnpm --filter @vykor/services exec vitest run src/session-runtime/__test__/store.test.ts src/attachment/__test__/attachment-integrity-service.test.ts
```

预期：现有引用统计只查询 `session_input_attachment`，生成资产被错误视为未引用。

- [ ] **步骤 3：实现统一引用计数**

新增 `countAttachmentReferences(assetId)`，返回输入附件引用与 `session_message_part` 附件引用之和。未引用删除与附件 GC 改用统一计数；保留 `countInputAttachmentReferences()` 给现有调用者使用。

- [ ] **步骤 4：运行 services 定向测试验证通过**

运行任务 3 的 Vitest 命令，预期全部通过。

### 任务 4：在助手消息中显示生成图片

**文件：**

- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/message-render-model.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/message-render-model.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/assistant-message.tsx`

- [ ] **步骤 1：编写失败测试**

向 `buildAssistantContent()` 输入一个助手附件部件，断言输出包含 `type: "attachment"` 单元并保留完整部件；混合 Tool、附件和文本时顺序保持不变。

- [ ] **步骤 2：运行测试验证失败**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/message/message-render-model.test.ts
```

预期：现有内容模型忽略 `attachment` 部件。

- [ ] **步骤 3：实现助手附件渲染**

为 `AssistantContentUnit` 增加 attachment 单元；`AssistantMessage` 将连续附件单元组合进 `AttachmentGroup`，每个部件复用 `MessageAttachment`，从而沿用预览、打开和另存为逻辑。

- [ ] **步骤 4：运行桌面定向测试与类型检查**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/message/message-render-model.test.ts
pnpm --filter @vykor/desktop check-types
```

预期：测试与类型检查通过。

### 任务 5：回归与安全验证

**文件：**

- 检查全部本次修改文件。

- [ ] 运行 `pnpm --filter @vykor/server test`。
- [ ] 运行 `pnpm --filter @vykor/services test`。
- [ ] 运行 `pnpm --filter @vykor/desktop test`。
- [ ] 运行 `pnpm --filter @vykor/server check-types`。
- [ ] 运行 `pnpm --filter @vykor/services check-types`。
- [ ] 运行 `pnpm --filter @vykor/desktop check-types`。
- [ ] 运行 `git diff --check`。
- [ ] 搜索确认生产代码不再写 `~/.vykor/images`，不再直接下载 provider URL，也不返回本机生成图片路径。
- [ ] 检查 `git status` 和目标文件 diff，确认没有覆盖用户已有的无关修改。
