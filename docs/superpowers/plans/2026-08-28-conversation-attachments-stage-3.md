# 对话附件阶段 3 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 Desktop 中完整接通附件选择、拖放、粘贴、流式上传、草稿隔离、发送、消息展示、打开和下载，同时保持生产默认关闭且不提前接入模型图片或 OCR。

**架构：** Renderer 只保存按 Composer scope 隔离的安全草稿状态，Electron Main 持有真实路径、source token、上传流和取消控制，daemon 继续作为资产与消息引用的唯一真实来源。发送时从 ready 草稿生成不可变 ordered refs 快照，optimistic transcript 与权威 Snapshot/SSE 通过 input ID 收敛。

**技术栈：** TypeScript、Electron 39、React 19、Lexical、Zustand、Tailwind CSS、Vykor Client、Vitest、pnpm/Turbo。

---

## 实施边界

设计依据：`docs/superpowers/specs/2026-08-28-conversation-attachments-stage-3-design.md`。

本计划只实现阶段 3。不要把附件转换成 Provider 图片输入，不要调用或修改 `ImageToText`，不要执行 OCR、PDF/Word/文本提取、文件挂载、分片上传、Blob GC 或文件夹遍历。最近一条带附件消息只能改文字，附件只读。开发模式和测试走完整链路，生产构建默认不开放真实附件发送。

用户已要求内联执行，不使用子代理；执行本计划时选择 `superpowers:executing-plans`。

## 文件结构与职责

### 新建文件

- `apps/desktop/src/shared/attachment-types.ts`：Desktop 附件 capability、候选文件、草稿、上传事件、错误和 IPC 输入输出类型。
- `apps/desktop/src/main/features/attachment/attachment-service.ts`：source token、上传任务、进度、取消、预览、打开、另存为和窗口清理。
- `apps/desktop/src/main/features/attachment/attachment-service.test.ts`：流式上传、窗口隔离、竞态、清理和安全错误测试。
- `apps/desktop/src/main/features/attachment/ipc.ts`：附件 IPC contribution。
- `apps/desktop/src/renderer/src/stores/desktop-session/composer-draft-state.ts`：按 scope 共同管理文字与附件草稿及其纯状态转移。
- `apps/desktop/src/renderer/src/stores/desktop-session/composer-draft-state.test.ts`：文字/附件 scope 隔离、重试和迟到事件测试。
- `apps/desktop/src/renderer/src/stores/desktop-session/attachment-actions.ts`：picker、drop、clipboard、上传、取消、重试、移除和事件订阅。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer-attachments.tsx`：横向附件卡片和操作。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer-attachments.test.tsx`：卡片状态、操作和可访问性测试。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/message-attachment.tsx`：历史附件卡片、缩略图生命周期、打开和下载。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/message-attachment.test.tsx`：安全预览、降级和 URL 释放测试。

### 修改文件

- `apps/desktop/src/shared/session-types.ts`：Desktop input、part、send/edit 和 bootstrap 附件字段。
- `apps/desktop/src/shared/desktop-api-contract.ts`：增加窄附件 API。
- `apps/desktop/src/shared/ipc-channels.ts`：附件 invoke/event channel 和强类型映射。
- `apps/desktop/src/preload/desktop-api.ts`：桥接附件命令、上传事件和 drop 文件路径提取。
- `apps/desktop/src/main/features/index.ts`：注册附件 contribution。
- `apps/desktop/src/main/features/session/session-service.ts`：capability 投影、有序 refs 发送、纯附件校验和文字编辑时保留原 refs。
- `apps/desktop/src/main/features/session/session-service.test.ts`：Desktop → Client prompt/edit 附件契约测试。
- `apps/desktop/src/renderer/src/stores/desktop-session/types.ts`：draft state/actions、发送附件快照和 action 签名。
- `apps/desktop/src/renderer/src/stores/desktop-session/initial-state.ts`：初始化内存草稿容器。
- `apps/desktop/src/renderer/src/stores/desktop-session/store.ts`：装配附件 actions 和上传事件订阅。
- `apps/desktop/src/renderer/src/stores/desktop-session/prompt-actions.ts`：已有会话的附件发送快照和失败恢复。
- `apps/desktop/src/renderer/src/stores/desktop-session/prompt-actions.test.ts`：纯附件、顺序、失败重试和 SSE 竞态。
- `apps/desktop/src/renderer/src/stores/desktop-session/session-actions.ts`：新会话 scope 迁移和首条附件发送。
- `apps/desktop/src/renderer/src/stores/desktop-session/session-actions.test.ts`：create/open/send 失败时草稿归属与复用。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/optimistic-transcript.ts`：投影附件 parts。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/optimistic-transcript.test.ts`：纯附件与权威消息收敛。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer.tsx`：附件区、菜单、drop target 和发送门槛。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/rich-prompt-input.tsx`：二进制优先的 paste 入口，保留纯文本粘贴。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx`：已有会话 scope 接线。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/new-conversation-start.tsx`：新会话 scope 接线。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/message-block.tsx`：用户消息附件、只读编辑卡片。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/transcript.tsx`：打开、下载附件回调。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/transcript.test.ts`：typed attachment/transformation 展示。
- `apps/desktop/src/renderer/src/components/ui/attachment.tsx`：进度条和只读状态所需的小幅样式扩展。
- `apps/desktop/src/renderer/src/stores/desktop-session/README.md`：说明附件草稿与发送数据流。
- `docs/superpowers/specs/2026-08-27-conversation-attachments-roadmap-design.md`：完成后更新阶段 3 状态和证据。
- `docs/superpowers/specs/2026-08-28-conversation-attachments-stage-3-design.md`：完成后更新实现状态和验证结果。

## 任务 1：建立 Desktop 附件契约与 capability 门槛

**交付物：** Main、preload 和 renderer 共用严格类型；Desktop bootstrap 能判断 daemon 是否支持附件以及当前构建是否允许交互；Session view 能保留阶段 2 的 attachment/transformation part。

**文件：**

- 创建：`apps/desktop/src/shared/attachment-types.ts`
- 修改：`apps/desktop/src/shared/session-types.ts`
- 修改：`apps/desktop/src/shared/desktop-api-contract.ts`
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 修改：`apps/desktop/src/main/features/session/session-service.ts`
- 测试：`apps/desktop/src/main/features/session/session-service.test.ts`

- [ ] **步骤 1：写失败的类型和 bootstrap 测试**

在 `session-service.test.ts` 增加 Client capability 投影：

```ts
expect(await service.bootstrap()).toMatchObject({
  attachments: {
    daemonSupported: true,
    interactionEnabled: true,
    uploadModes: ["single"],
    limits: { maxFilesPerPrompt: 20, maxBytesPerFile: 104857600 },
  },
});
```

再固定旧 daemon 和 production gate：capability 缺失时 `daemonSupported: false`；`app.isPackaged === true` 且没有测试/开发开关时 `interactionEnabled: false`。

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @vykor/desktop test -- src/main/features/session/session-service.test.ts`

预期：FAIL，bootstrap 尚无 `attachments`，Desktop part 仍不接受 `attachment`。

- [ ] **步骤 3：定义共享类型**

在 `attachment-types.ts` 定义并由 `session-types.ts` 引用：

```ts
export interface DesktopAttachmentSupport {
  daemonSupported: boolean;
  interactionEnabled: boolean;
  uploadModes: readonly ("single" | "resumable")[];
  limits: AttachmentLimits | null;
}

export type DesktopAttachmentDraftStatus =
  | "uploading"
  | "ready"
  | "failed"
  | "cancelled";

export interface DesktopPromptAttachmentInput {
  assetId: string;
  intent: "auto";
  displayName: string;
}
```

`DesktopBootstrapData.attachments` 必填；`DesktopSessionInput.attachments` 必填；`SendDesktopPromptInput.attachments` 必填。把 `DesktopSessionPart` 改为判别联合类型，加入协议已经存在的 `attachment` 与 `transformation` 字段，不能继续用一个全可选的大接口掩盖非法组合。

- [ ] **步骤 4：投影 daemon capability 并固定 feature gate**

`DesktopSessionService.bootstrap()` 与 settings/models/sessions 一起调用 `client.capabilities()`。使用纯函数：

```ts
resolveDesktopAttachmentSupport(capabilities, {
  isPackaged: app.isPackaged,
  forceEnable: process.env.VYKOR_DESKTOP_ATTACHMENTS === "1",
});
```

开发或测试允许 `interactionEnabled`；production 默认 false。不得以当前模型的 `vision` 字段开启阶段 3，因为模型路由属于阶段 4。

- [ ] **步骤 5：运行 Desktop 测试与类型检查**

运行：`pnpm --filter @vykor/desktop test -- src/main/features/session/session-service.test.ts`

运行：`pnpm --filter @vykor/desktop typecheck`

预期：全部 PASS。

- [ ] **步骤 6：提交契约**

```bash
git add apps/desktop/src/shared apps/desktop/src/main/features/session/session-service.ts apps/desktop/src/main/features/session/session-service.test.ts
git commit -m "feat(desktop): define attachment contracts"
```

## 任务 2：实现 Main 流式上传服务

**交付物：** 真实路径只在 Main 中存在；source token 按窗口隔离；文件以流上传并报告进度；取消、重试和窗口关闭都能收束任务。

**文件：**

- 创建：`apps/desktop/src/main/features/attachment/attachment-service.ts`
- 创建：`apps/desktop/src/main/features/attachment/attachment-service.test.ts`

- [ ] **步骤 1：先写 source token 与任务隔离失败测试**

使用注入的 `stat/openReadStream/client/sendEvent`，固定以下行为：

```ts
const candidates = await service.stagePaths(11, [fixturePath]);
await expect(service.startUpload(12, {
  draftId: "draft-1",
  sourceToken: candidates[0]!.sourceToken,
})).rejects.toMatchObject({ code: "attachment_source_forbidden" });

await service.disposeOwner(11);
await expect(service.startUpload(11, {
  draftId: "draft-1",
  sourceToken: candidates[0]!.sourceToken,
})).rejects.toMatchObject({ code: "attachment_source_expired" });
```

覆盖目录、符号链接、不可读文件、token 一次性消费和过期。

- [ ] **步骤 2：运行服务测试确认失败**

运行：`pnpm --filter @vykor/desktop test -- src/main/features/attachment/attachment-service.test.ts`

预期：FAIL，附件服务不存在。

- [ ] **步骤 3：实现候选文件和 source token**

`stagePaths(ownerId, paths)` 对每个路径执行 `lstat + realpath + stat`，只接受普通文件；返回：

```ts
interface DesktopAttachmentCandidate {
  draftId: string;
  sourceToken: string;
  displayName: string;
  declaredMediaType: string;
  sizeBytes: number;
}
```

任务表键使用 `${ownerId}:${taskId}`，source token 记录 `ownerId`、绝对路径、安全展示名、大小和过期时间。Renderer 永远不接收路径。

- [ ] **步骤 4：写流式进度、取消和迟到完成测试**

模拟分块读取并断言 progress 单调、完成事件包含 `assetId`。取消后 `AbortSignal.aborted === true`，且晚到的 Client resolve 不能再发 success。重试使用新 taskId。一次加入 5 个文件时断言同时读取不超过 3 个，其余任务排队且取消排队任务不会打开文件。

- [ ] **步骤 5：实现上传任务**

使用 `Readable.toWeb(createReadStream(path))` 外包一层计数流：

```ts
const body = countedReadableStream(fileStream, ({ bytesRead }) => {
  emitProgress({ ownerId, draftId, taskId, bytesRead, totalBytes });
});
const asset = await client.uploadAttachment({
  displayName,
  mediaType: declaredMediaType,
  body,
  signal: controller.signal,
});
```

progress 节流到约 100ms；success/failure 不节流。服务内部使用并发上限 3 的 FIFO 队列，窗口销毁时同时移除排队任务和取消运行任务。取消先标记 task cancelled，再 abort，最后关闭流。错误映射成稳定 `DesktopAttachmentError`，不返回路径和堆栈。

- [ ] **步骤 6：实现 preview、delete、open 和 saveAs 的服务方法**

`readPreview` 仅允许安全位图白名单且受 `maxBytesPerFile`/预览上限约束；返回 `Uint8Array + mediaType`。`open` 下载到 `app.getPath("temp")` 下由应用管理的随机目录并调用注入的 `shell.openPath`；记录临时文件并在应用退出或安全 TTL 后删除，测试固定清理只发生在该管理目录。`saveAs` 使用保存对话框；`deleteUnreferenced` 把 `attachment_in_use` 规范化为幂等成功结果。

- [ ] **步骤 7：运行服务测试与 node 类型检查**

运行：`pnpm --filter @vykor/desktop test -- src/main/features/attachment/attachment-service.test.ts`

运行：`pnpm --filter @vykor/desktop typecheck:node`

预期：全部 PASS。

- [ ] **步骤 8：提交 Main 服务**

```bash
git add apps/desktop/src/main/features/attachment
git commit -m "feat(desktop): add streamed attachment service"
```

## 任务 3：接通附件 IPC 与 preload 安全桥

**交付物：** Renderer 只能调用附件专用命令；picker、drop、clipboard、进度订阅和窗口销毁都接到 Main 服务，完整路径不会跨出 preload/Main 边界。

**文件：**

- 创建：`apps/desktop/src/main/features/attachment/ipc.ts`
- 修改：`apps/desktop/src/main/features/index.ts`
- 修改：`apps/desktop/src/shared/desktop-api-contract.ts`
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 修改：`apps/desktop/src/preload/desktop-api.ts`
- 测试：`apps/desktop/src/main/features/attachment/attachment-service.test.ts`

- [ ] **步骤 1：写 IPC 映射失败测试**

测试 picker 用 `event.sender.id` 作为 owner，上传/取消不能接受 renderer 自报 ownerId。验证 progress 只发送给所属且未销毁的 `webContents`。

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @vykor/desktop test -- src/main/features/attachment/attachment-service.test.ts`

预期：FAIL，尚无 IPC contribution 和 owner 路由。

- [ ] **步骤 3：增加强类型 channel**

新增 invoke channel：`attachmentPickFiles`、`attachmentPickImages`、`attachmentStageDropped`、`attachmentUploadMemory`、`attachmentStartUpload`、`attachmentCancelUpload`、`attachmentDeleteUnreferenced`、`attachmentReadPreview`、`attachmentOpen`、`attachmentSaveAs`；新增 event：`attachmentUploadEvent`。

`IpcInvokeMap` 为每个 channel 固定输入和结果。`DesktopAPI.attachments` 不提供通用 `readFile(path)`。

- [ ] **步骤 4：实现 preload 桥**

preload 内部使用 `webUtils.getPathForFile(file)` 提取真实 drop 路径，并立即通过 IPC 交给 Main；返回 renderer 的仍是 candidate，不含路径：

```ts
stageDroppedFiles: (files: readonly File[]) =>
  invoke(IpcChannels.attachmentStageDropped,
    files.map((file) => webUtils.getPathForFile(file)).filter(Boolean)),
```

没有路径的 clipboard 位图只允许 `ArrayBuffer`，并在 Main 端按 capability limit 再校验。上传事件订阅返回卸载函数。

- [ ] **步骤 5：注册 contribution 和窗口清理**

把 `attachmentIpcContribution` 加入 `allIpcContributions`。首次使用 owner 时注册 `webContents.once("destroyed")`，调用 `disposeOwner(id)`；不要依赖 renderer 主动清理。

- [ ] **步骤 6：验证契约没有路径泄漏**

运行：`rg -n "path: string|filePath|absolutePath" apps/desktop/src/shared/attachment-types.ts apps/desktop/src/shared/desktop-api-contract.ts`

预期：公开 candidate/draft/upload event 中没有真实路径字段；只允许 `saveAs` 结果中不返回目标路径。

运行：`pnpm --filter @vykor/desktop test -- src/main/features/attachment/attachment-service.test.ts && pnpm --filter @vykor/desktop typecheck`

预期：全部 PASS。

- [ ] **步骤 7：提交 IPC 桥**

```bash
git add apps/desktop/src/shared apps/desktop/src/preload apps/desktop/src/main/features/index.ts apps/desktop/src/main/features/attachment
git commit -m "feat(desktop): bridge attachment uploads safely"
```

## 任务 4：建立按 Composer scope 隔离的文字与附件草稿

**交付物：** `new-conversation` 和每个 session 各有独立的内存文字与附件草稿；选择、进度、完成、失败、取消、重试和移除都通过可测试的状态转移完成。

**文件：**

- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/composer-draft-state.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/composer-draft-state.test.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/attachment-actions.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/types.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/initial-state.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/store.ts`

- [ ] **步骤 1：先写纯状态失败测试**

固定 scope 和迟到事件：

```ts
const state = setDraftText(addCandidates(emptyDrafts(), "session:a", [candidate]), "session:a", "A 的文字");
const retried = beginRetry(state, "session:a", candidate.draftId, "task-new");
expect(applyUploadEvent(retried, {
  draftId: candidate.draftId,
  taskId: "task-old",
  type: "failed",
  error: retryableError,
})).toBe(retried);
expect(selectDrafts(retried, "session:b")).toEqual([]);
expect(selectDraftText(retried, "session:a")).toBe("A 的文字");
expect(selectDraftText(retried, "session:b")).toBe("");
```

覆盖文字互不串用、附件顺序不变、ready 元数据、remove 单项、scope 迁移和 reset 只清空目标 scope。

- [ ] **步骤 2：运行纯状态测试确认失败**

运行：`pnpm --filter @vykor/desktop test -- src/renderer/src/stores/desktop-session/composer-draft-state.test.ts`

预期：FAIL，状态模块不存在。

- [ ] **步骤 3：实现状态模型**

在 store 增加：

```ts
interface DesktopComposerDraft {
  text: string;
  attachments: DesktopAttachmentDraft[];
}

interface ComposerDraftState {
  composerDraftsByScope: Record<string, DesktopComposerDraft>;
}

const NEW_CONVERSATION_SCOPE = "new-conversation";
const sessionAttachmentScope = (sessionId: string) => `session:${sessionId}`;
```

所有 mutation 返回新对象/数组；事件同时匹配 `scope + draftId + taskId` 才生效。`setComposerDraftText(scope, text)` 与附件 action 写入同一个 scope。状态不加入现有 persistence，因此应用重启后文字和未发送附件都不恢复。

- [ ] **步骤 4：写 action 失败测试并实现副作用**

stub `window.desktop.attachments`，验证 `pickFiles/pickImages/addDropped/addClipboard/start/cancel/retry/remove`。ready 移除调用 `deleteUnreferenced`；清理失败不还原卡片。failed/cancelled 移除不请求删除 asset。

- [ ] **步骤 5：装配上传事件生命周期**

仿照 `attachDesktopSessionEvents()` 增加引用计数订阅。组件首次挂载时注册一次 `onUploadEvent`，最后卸载时解除；事件按 draft 所属 scope 路由，找不到当前 taskId 时忽略。

- [ ] **步骤 6：运行 store 测试和 web 类型检查**

运行：`pnpm --filter @vykor/desktop test -- src/renderer/src/stores/desktop-session/composer-draft-state.test.ts src/renderer/src/stores/desktop-session/store.integration.test.ts`

运行：`pnpm --filter @vykor/desktop typecheck:web`

预期：全部 PASS。

- [ ] **步骤 7：提交草稿状态**

```bash
git add apps/desktop/src/renderer/src/stores/desktop-session
git commit -m "feat(desktop): isolate attachment drafts by composer"
```

## 任务 5：实现 Composer 横向卡片、选择、拖放和粘贴

**交付物：** 新旧 Composer 共用 A 方案附件区；三种添加入口形成同一种草稿；文件夹入口保留但禁用；上传状态和键盘/辅助技术标签完整。

**文件：**

- 创建：`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer-attachments.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer-attachments.test.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/rich-prompt-input.tsx`
- 修改：`apps/desktop/src/renderer/src/components/ui/attachment.tsx`

- [ ] **步骤 1：写卡片状态和菜单失败测试**

渲染 uploading/ready/failed 卡片，断言：文件名纯文本、进度可读、取消/重试/移除按钮分别出现；“添加文件夹”存在、disabled、辅助文案为“后续版本开放”。

- [ ] **步骤 2：运行组件测试确认失败**

运行：`pnpm --filter @vykor/desktop test -- src/renderer/src/components/desktop/conversation-page/composer-attachments.test.tsx`

预期：FAIL，卡片组件不存在，PlusMenu 没有附件 handler/disabled 状态。

- [ ] **步骤 3：实现横向附件卡片**

复用 `AttachmentGroup`，映射状态：`uploading → uploading`、`ready → done`、`failed/cancelled → error`。卡片描述显示格式、大小或错误；底部进度使用 `role="progressbar"`，失败消息使用适度的 `aria-live="polite"`。

图片 draft 在 ready 前不从本地路径预览；ready 后通过统一 preview hook 获取 daemon 副本。缩略图失败改用图片文件图标。

- [ ] **步骤 4：给 Composer 增加显式附件 props**

```ts
attachments: DesktopAttachmentDraft[];
attachmentInteractionEnabled: boolean;
attachmentReadOnly?: boolean;
onPickFiles: () => void;
onPickImages: () => void;
onDropFiles: (files: readonly File[]) => void;
onPasteFiles: (files: readonly File[]) => void;
onCancelAttachment: (draftId: string) => void;
onRetryAttachment: (draftId: string) => void;
onRemoveAttachment: (draftId: string) => void;
```

`canSubmit` 由页面依据 scope 计算，Composer 不自行猜测。

- [ ] **步骤 5：实现 drop 与 paste 分流**

Composer `onDragOver/onDrop` 只接收 `DataTransfer.files`，目录交给 Main 拒绝。`RichPromptInput` 的 paste plugin 先检查 `clipboardData.files`；有二进制条目时调用 `onPasteFiles`，没有时保留现有纯文本插入。混合剪贴板只添加一次图片，同时把非空 `text/plain` 插入当前光标，不能因为有二进制条目吞掉配套文字。

- [ ] **步骤 6：运行交互、可访问性和现有 Composer 测试**

运行：`pnpm --filter @vykor/desktop test -- src/renderer/src/components/desktop/conversation-page/composer-attachments.test.tsx src/renderer/src/components/desktop/conversation-page/composer-skill-commands.test.ts src/renderer/src/components/desktop/conversation-page/conversation-page-draft.test.ts`

运行：`pnpm --filter @vykor/desktop typecheck:web`

预期：全部 PASS。

- [ ] **步骤 7：提交 Composer UI**

```bash
git add apps/desktop/src/renderer/src/components/desktop/conversation-page apps/desktop/src/renderer/src/components/ui/attachment.tsx
git commit -m "feat(desktop): render composer attachment cards"
```

## 任务 6：让已有会话发送附件并正确合并 optimistic transcript

**交付物：** 已有会话支持文字+附件和纯附件；只有全部 ready 才发送；有序快照进入 Client；失败和 IPC/SSE 竞态不会清空或重复。

**文件：**

- 修改：`apps/desktop/src/main/features/session/session-service.ts`
- 修改：`apps/desktop/src/main/features/session/session-service.test.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/types.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/prompt-actions.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/prompt-actions.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/optimistic-transcript.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/optimistic-transcript.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx`

- [ ] **步骤 1：写 Main 纯附件和有序 refs 失败测试**

```ts
await service.sendPrompt({
  id: "input-1",
  sessionId: "session-1",
  content: "",
  attachments: [
    { assetId: "att-b", intent: "auto", displayName: "b.png" },
    { assetId: "att-a", intent: "auto", displayName: "a.pdf" },
  ],
});
expect(client.admitPrompt).toHaveBeenCalledWith("session-1", expect.objectContaining({
  content: "",
  attachments: [expect.objectContaining({ assetId: "att-b" }), expect.objectContaining({ assetId: "att-a" })],
}));
```

文字和附件都为空必须拒绝。

- [ ] **步骤 2：实现 Main prompt 校验和透传**

用 `normalizeDesktopPromptContent(content, attachments)` 替代 `requireString(content)`。逐项校验 assetId/displayName/intent，保持数组顺序，调用 `client.admitPrompt({ attachments })`。

- [ ] **步骤 3：写 renderer 发送快照失败测试**

固定 ready 顺序、uploading 阻止发送、纯附件允许、失败保留 scope。`PendingPromptSubmission` 保存附件展示快照；重试匹配文字和 ordered asset IDs，不能只按文字命中旧请求。

- [ ] **步骤 4：实现不可变快照与草稿清理**

```ts
interface PendingPromptAttachmentSnapshot extends DesktopPromptAttachmentInput {
  mediaType: string;
  sizeBytes: number;
}

interface PendingPromptSubmission {
  // existing fields
  attachments: PendingPromptAttachmentSnapshot[];
}
```

`sendMessage(content, { attachments })` 在开始时复制数组。IPC 成功后清除的只是在相同 scope 中仍匹配发送快照的 draft IDs；用户发送后新加入的卡片不能被清掉。失败时 ready 草稿保留。

- [ ] **步骤 5：投影 optimistic attachment parts**

文字为空时不创建空 text part；附件从 seq 0 或 text 后的 seq 开始，使用稳定 ID `optimistic-attachment:${inputId}:${assetId}:${seq}`。权威 user message 含相同 inputId 时过滤整个 optimistic message 与其 parts。

- [ ] **步骤 6：接线已有会话 Composer**

`conversation-page.tsx` 删除单一组件级 `useState("")`，从 `session:<activeSessionId>` 选择同 scope 的 text 和 attachments；`onDraftChange` 写回该 scope。发送门槛计算：

```ts
const canSubmit =
  (Boolean(draft.trim()) || attachments.length > 0) &&
  attachments.every((item) => item.status === "ready");
```

命令行带附件时明确阻止并提示先移除附件，不得静默丢弃。

- [ ] **步骤 7：运行已有会话测试**

运行：`pnpm --filter @vykor/desktop test -- src/main/features/session/session-service.test.ts src/renderer/src/stores/desktop-session/prompt-actions.test.ts src/renderer/src/components/desktop/conversation-page/optimistic-transcript.test.ts`

预期：全部 PASS。

- [ ] **步骤 8：提交已有会话发送闭环**

```bash
git add apps/desktop/src/main/features/session apps/desktop/src/renderer/src/stores/desktop-session apps/desktop/src/renderer/src/components/desktop/conversation-page
git commit -m "feat(desktop): send attachments from existing sessions"
```

## 任务 7：让新会话首条消息复用同一附件语义

**交付物：** `new-conversation` scope 可发送首条文字+附件或纯附件；创建/打开/发送失败保留草稿；成功后 scope 只迁移一次且不重复上传。

**文件：**

- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/types.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/session-actions.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/session-actions.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/new-conversation-start.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/draft-submission.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page-draft.test.ts`

- [ ] **步骤 1：写新会话失败与迁移测试**

覆盖：切换会话后各自文字恢复；create 失败时文字和附件仍在 `new-conversation`；create 成功/open 失败时二者只归新 session；send 失败时文字和 ready 卡片仍可重试；send 成功后只删除发送快照中的文字/附件；用户切走页面时不误清其他 scope。

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @vykor/desktop test -- src/renderer/src/stores/desktop-session/session-actions.test.ts src/renderer/src/components/desktop/conversation-page/conversation-page-draft.test.ts`

预期：FAIL，`startSession` 仍要求非空文字且没有附件 scope。

- [ ] **步骤 3：扩展 `startSession` 签名与输入门槛**

```ts
startSession: (
  content: string,
  options?: SubmitPromptOptions & { attachments?: DesktopAttachmentDraft[] }
) => Promise<string | null>;
```

创建 session 前验证附件全部 ready，并生成与任务 6 同形状快照。标题为空时使用第一个附件安全文件名，而不是生成空标题。

- [ ] **步骤 4：实现 scope 原子迁移**

session create 成功后，在一次 Zustand `set` 中把 `new-conversation` 的文字和 attachments 整体移到 `session:<id>` 并清空 source；如果该 navigation generation 已失去页面所有权，仍只能选择一个 owner scope。open/send 失败不把它搬回造成双份。

- [ ] **步骤 5：接线新会话 Composer**

`new-conversation-start.tsx` 读取固定 `new-conversation` scope 的文字和附件，保留项目/外部工作区门槛，再叠加附件 ready 门槛。发送成功后只在当前 scope 仍匹配发送快照时清理文字，并用 snapshot draft IDs 清理附件；失败不调用清理。

- [ ] **步骤 6：运行新会话和 store 集成测试**

运行：`pnpm --filter @vykor/desktop test -- src/renderer/src/stores/desktop-session/session-actions.test.ts src/renderer/src/stores/desktop-session/store.integration.test.ts src/renderer/src/components/desktop/conversation-page/conversation-page-draft.test.ts`

预期：全部 PASS。

- [ ] **步骤 7：提交新会话闭环**

```bash
git add apps/desktop/src/renderer/src/stores/desktop-session apps/desktop/src/renderer/src/components/desktop/conversation-page
git commit -m "feat(desktop): send first-message attachments"
```

## 任务 8：展示历史附件并限制编辑为只改文字

**交付物：** 用户消息显示 typed attachment/transformation parts；安全位图使用 daemon 缩略图；文件可打开/另存为；编辑最近消息保留原 ordered refs 且附件只读。

**文件：**

- 创建：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message-attachment.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message-attachment.test.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message-block.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/transcript.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/transcript.test.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/prompt-actions.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/prompt-actions.test.ts`
- 修改：`apps/desktop/src/main/features/session/session-service.ts`
- 修改：`apps/desktop/src/main/features/session/session-service.test.ts`

- [ ] **步骤 1：写消息卡片与预览安全失败测试**

测试 PNG 请求 `readPreview` 并创建 Blob URL；SVG/HTML 不请求 preview；preview reject 后显示普通图标；unmount 和 assetId 变化都调用 `URL.revokeObjectURL`。文件名按文本节点显示。

- [ ] **步骤 2：运行消息附件测试确认失败**

运行：`pnpm --filter @vykor/desktop test -- src/renderer/src/components/desktop/conversation-page/message-attachment.test.tsx src/renderer/src/components/desktop/conversation-page/transcript.test.ts`

预期：FAIL，历史消息仍只显示 text。

- [ ] **步骤 3：实现历史卡片和 transformation 槽位**

`MessageBlock` 将 user parts 分成 text、attachment、transformation。附件保持 part seq 顺序；安全位图才传给 preview hook。`transformation` 显示 processing/completed/failed 槽位，但不触发任何处理。

- [ ] **步骤 4：接线 open/saveAs**

卡片操作只调用 `window.desktop.attachments.open({ assetId })` 和 `saveAs({ assetId })`。不创建 `file://`、daemon 裸 URL、iframe、webview 或 shell 命令。

- [ ] **步骤 5：写只读编辑附件失败测试**

进入最近消息编辑态时断言原 attachment cards 可见但无移除/添加入口；纯附件消息也显示“重新编辑”，编辑器初始文字为空但允许输入新文字；消息气泡不能为纯附件伪造“已发送消息”文本。提交新文字时 Main `editLatestPrompt` 收到从权威 source input 得到的原 ordered refs。

- [ ] **步骤 6：实现编辑引用保留**

Renderer 从当前 `sessionView.inputs` 按 `sourceMessage.inputId` 取 attachments，作为 `EditLatestDesktopPromptInput.attachments` 快照传入。Main 校验并原样传给 Client。不得从页面展示卡片反推引用，也不得重新上传。

- [ ] **步骤 7：运行消息、编辑和类型测试**

运行：`pnpm --filter @vykor/desktop test -- src/renderer/src/components/desktop/conversation-page/message-attachment.test.tsx src/renderer/src/components/desktop/conversation-page/transcript.test.ts src/renderer/src/stores/desktop-session/prompt-actions.test.ts src/main/features/session/session-service.test.ts`

运行：`pnpm --filter @vykor/desktop typecheck`

预期：全部 PASS。

- [ ] **步骤 8：提交历史展示和编辑约束**

```bash
git add apps/desktop/src/renderer/src/components/desktop/conversation-page apps/desktop/src/renderer/src/stores/desktop-session apps/desktop/src/main/features/session
git commit -m "feat(desktop): render message attachments safely"
```

## 任务 9：补齐安全、竞态、功能开关和 Desktop 全链路测试

**交付物：** picker/drop/clipboard 到 daemon asset、消息引用和重载展示的开发模式链路有测试；生产 gate、主动内容、源文件删除、窗口关闭和 IPC/SSE 顺序均被固定。

**文件：**

- 修改：`apps/desktop/src/main/features/attachment/attachment-service.test.ts`
- 修改：`apps/desktop/src/main/features/session/session-service.test.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/composer-draft-state.test.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/prompt-actions.test.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/session-actions.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer-attachments.test.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message-attachment.test.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/transcript.test.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/README.md`

- [ ] **步骤 1：添加全链路测试夹具**

使用临时普通文件和真实/内嵌 daemon 测试：stage → stream upload → admit prompt → snapshot/event → Desktop view → attachment part。上传完成后删除源文件，再断言 `readPreview/download` 仍读取 daemon 副本。

- [ ] **步骤 2：固定三种入口的一致结果**

picker path、drop path 和 clipboard bytes 分别上传相同 PNG，断言三者都返回 ready `AttachmentAssetRecord`，发送后都产生同形状 `attachment` part；Blob 可去重，但 UI draft 不去重。

- [ ] **步骤 3：固定竞态矩阵**

参数化测试：IPC success 在 SSE 前/后；cancel 后 success；retry 后旧 failure；remove ready 同时 `attachment_in_use`；切换 session 时 progress；create 成功/open 失败；窗口销毁时 uploading。每个用例都断言最终只有一个 owner scope 和一组卡片。

- [ ] **步骤 4：固定主动内容和路径泄漏**

用 SVG、HTML、伪装成 PNG 的内容和含 `<img onerror>` 的文件名测试：不创建图片预览、不插入 HTML、不暴露完整路径、不开 iframe/webview。检查 IPC event/error 快照不含 `Authorization`、token、路径或 stack。

- [ ] **步骤 5：固定 feature gate**

测试矩阵：旧 daemon、开发构建、测试强制开启、production 默认关闭。生产默认必须无法通过 UI 发起附件上传/发送；纯文本发送保持原样。

- [ ] **步骤 6：更新 Desktop store 运行说明**

在 README 写清入口、状态位置、上传事件返回路径、发送快照、scope 迁移、权威 SSE 对账和重启不恢复；明确模型/OCR 不在本阶段。

- [ ] **步骤 7：运行 Desktop 完整验证**

运行：`pnpm --filter @vykor/desktop test`

运行：`pnpm --filter @vykor/desktop lint`

运行：`pnpm --filter @vykor/desktop typecheck`

预期：全部 PASS，无跳过或新增未解释快照。

- [ ] **步骤 8：提交收束测试**

```bash
git add apps/desktop/src apps/desktop/src/renderer/src/stores/desktop-session/README.md
git commit -m "test(desktop): verify attachment user flow"
```

## 任务 10：阶段验收、文档收束与最终提交

**交付物：** 设计和路线文档记录实际交付与验证证据；相关包和全仓检查通过；工作区只含有意变更。

**文件：**

- 修改：`docs/superpowers/specs/2026-08-27-conversation-attachments-roadmap-design.md`
- 修改：`docs/superpowers/specs/2026-08-28-conversation-attachments-stage-3-design.md`

- [ ] **步骤 1：按设计验收门槛逐项核对**

核对 picker/drop/clipboard、路径隔离、进度/取消/重试/移除、纯附件、新会话、只读编辑、IPC/SSE 竞态、源文件删除、主动内容和 production gate。任何一项没有测试证据都不能标记阶段完成。

- [ ] **步骤 2：更新阶段状态和证据**

把两份设计文档的阶段 3 状态改为已完成，记录真实测试数量、命令、构建模式和安全用例。不要提前把阶段 4/5 标为开始或完成。

- [ ] **步骤 3：运行最终验证**

运行：`pnpm --filter @vykor/desktop test`

运行：`pnpm --filter @vykor/desktop lint`

运行：`pnpm --filter @vykor/desktop typecheck`

运行：`pnpm check-types`

运行：`node scripts/check-docs.mjs`

运行：`git diff --check`

预期：所有命令退出码为 0；文档检查报告所有 Markdown 有效；Git 无空白错误。

- [ ] **步骤 4：确认没有越过阶段边界**

运行：`git diff --name-only dfd2972..HEAD`

检查结果不得包含 Provider 图片适配、`ImageToText` OCR 实现、PDF/Word 提取、分片上传或文件夹遍历代码。`IconFolderPlus` 可以保留，菜单项必须 disabled。

- [ ] **步骤 5：提交文档收束**

```bash
git add docs/superpowers/specs/2026-08-27-conversation-attachments-roadmap-design.md docs/superpowers/specs/2026-08-28-conversation-attachments-stage-3-design.md
git commit -m "docs: complete conversation attachments stage 3"
```

- [ ] **步骤 6：报告阶段结果**

向用户报告：实现范围、关键数据流、测试/类型/文档检查证据、生产 gate 状态、未包含的阶段 4/5 工作、提交列表和工作区状态。不得只说“已完成”。
