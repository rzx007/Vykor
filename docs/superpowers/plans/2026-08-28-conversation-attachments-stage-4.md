# 对话附件阶段 4 实现计划

> **执行状态：已完成（2026-08-28）。** 五个大任务均已实现并按任务提交；真实测试数量、环境基线和功能边界记录在对应设计文档的“实施结果与验证证据”中。

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 在当前分支内联执行本计划。步骤使用复选框（`- [ ]`）跟踪进度；本项目已明确不使用子代理拆分实现。

**目标：** 把 durable 图片附件安全地转成模型原生图片输入；能力不支持、未知或内容无效时，在 Provider 请求前明确阻止整条 run。

**架构：** Server 中央 `AttachmentCapabilityRouter` 在 run 真正执行时求模型、adapter、intent 和 MIME 的交集，再通过 daemon 内容寻址 Blob 物化 `ContentBlock[]`。OpenAI、Codex、Anthropic adapter 只声明能力并进行请求格式转换；路由决定写进现有 run metadata 和 transformation part，不新建平行状态系统。

**技术栈：** TypeScript、Vitest、Node.js 文件 API、Core `ContentBlock[]`、SessionStore/SQLite、OpenAI SDK、Anthropic SDK、Codex Responses、Electron/React。

**设计依据：** `docs/superpowers/specs/2026-08-28-conversation-attachments-stage-4-design.md`

---

## 执行原则

- 共 5 个大任务，每个任务必须完成红—绿测试循环、定向类型检查和独立 commit，再进入下一任务。
- 保留用户现有未提交修改；只暂存当前任务明确列出的文件。
- 不修改 `packages/tools/src/media/image-to-text.ts`，不接 OCR，不开放生产附件 feature gate。
- 不用模型名字猜图片能力；缺少声明一律是 `unknown`。
- 多附件全有或全无；任何失败路径都断言 Provider 调用次数为零。
- Desktop 全量测试使用 `--maxWorkers=1`，避免当前环境并行 worker 不稳定拖慢反馈。

## 文件结构

### 新建

- `packages/server/src/application/attachment-routing/attachment-capabilities.ts`：三态能力求交集和 catalog/custom 映射。
- `packages/server/src/application/attachment-routing/attachment-capability-router.ts`：批量路由、错误码、ordered `ContentBlock[]` 物化。
- `packages/server/src/application/attachment-routing/attachment-routing-types.ts`：路由 decision、metadata 和 typed error。
- `packages/server/src/application/attachment-routing/__test__/attachment-capabilities.test.ts`：能力矩阵。
- `packages/server/src/application/attachment-routing/__test__/attachment-capability-router.test.ts`：intent、MIME、顺序、全有或全无和中断测试。

### 修改

- `packages/core/src/types/settings.ts`、`packages/core/src/index.ts`：自定义模型图片能力设置。
- `packages/api/src/providers/registry.ts`、`packages/api/src/index.ts`：adapter 图片能力声明和导出。
- `packages/server/src/application/settings-api.ts`：`ModelInfo.inputCapabilities` 和自定义 Provider 入参。
- `packages/server/src/application/default-services/model-service.ts`：catalog modality 三态映射。
- `packages/server/src/application/default-services/provider-service.ts`：保存显式自定义模型能力。
- `apps/desktop/src/shared/provider-types.ts`、`apps/desktop/src/shared/session-types.ts`：Desktop 边界类型。
- `apps/desktop/src/main/features/provider/provider-service.ts`：Provider snapshot 透传能力。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-form.ts`：表单标准化和默认 unknown。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-dialog.tsx`：每个模型的图片能力选择。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/model-picker.tsx`：显示 canonical 能力，不再用 `vision` 猜。
- `packages/services/src/attachment/attachment-blob-store.ts`：验证并返回内容寻址 Blob 稳定路径。
- `packages/services/src/attachment/attachment-application-service.ts`、`packages/services/src/index.ts`：按 asset ID 解析 ready 内容路径。
- `packages/api/src/providers/openai.ts`、`packages/api/src/providers/codex.ts`、`packages/api/src/providers/anthropic.ts`：三家精确图片请求转换。
- `packages/server/src/application/session/session-run-executor.ts`：运行前路由、ContentBlock 提交和结构化失败结算。
- `packages/server/src/application/session/transcript-projection.ts`：direct transformation 投影。
- `packages/server/src/application/daemon-application.ts`：向 executor 注入附件服务和能力解析依赖。
- `packages/protocol/src/session.ts`、`packages/protocol/src/serialization.ts`：仅在结构化错误事件需要时补齐类型化字段，不改变存储格式版本。
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/message-attachment.tsx`：稳定错误码的人话展示。
- 上述模块的现有 `*.test.ts` / `*.test.tsx`：contract、集成与回归测试。
- `docs/superpowers/specs/2026-08-27-conversation-attachments-roadmap-design.md`、`docs/superpowers/specs/2026-08-28-conversation-attachments-stage-4-design.md`：完成后记录真实结果和验证证据。

---

### 任务 1：统一能力契约并打通模型与自定义 Provider 配置

**交付物：** Server 能对任意执行时 provider/model 得到确定的 `native | unsupported | unknown`；Desktop 能显式配置自定义模型，缺省严格为 unknown。

**文件：**

- 创建：`packages/server/src/application/attachment-routing/attachment-capabilities.ts`
- 测试：`packages/server/src/application/attachment-routing/__test__/attachment-capabilities.test.ts`
- 修改：`packages/core/src/types/settings.ts`
- 修改：`packages/core/src/index.ts`
- 修改：`packages/api/src/providers/registry.ts`
- 修改：`packages/api/src/index.ts`
- 修改：`packages/server/src/application/settings-api.ts`
- 修改：`packages/server/src/application/default-services/model-service.ts`
- 修改：`packages/server/src/application/default-services/provider-service.ts`
- 修改：`packages/server/src/application/__test__/default-application-services.test.ts`
- 修改：`apps/desktop/src/shared/provider-types.ts`
- 修改：`apps/desktop/src/shared/session-types.ts`
- 修改：`apps/desktop/src/main/features/provider/provider-service.ts`
- 修改：`apps/desktop/src/main/features/provider/provider-service.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-form.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-form.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-dialog.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/model-picker.tsx`

- [ ] **步骤 1：先写失败测试，固定三态规则和自定义配置往返**

核心断言必须包含：

```ts
expect(modelInputCapabilities({ modalities: { input: ["text", "image"] } })).toEqual({ image: "native" });
expect(modelInputCapabilities({ modalities: { input: ["text"] } })).toEqual({ image: "unsupported" });
expect(modelInputCapabilities({})).toEqual({ image: "unknown" });
expect(resolveEffectiveImageSupport({ image: "native" }, { image: "unknown", imageMediaTypes: [] }))
  .toBe("unknown");
```

自定义模型表单测试必须验证 `imageInputSupport` 的 `native`、`unsupported`、`unknown` 都能保存并从 snapshot 恢复；字段缺失时规范化为 `unknown`，不能根据 `gpt-4o` 等 ID 自动改成 native。

- [ ] **步骤 2：运行定向测试，确认因字段和解析器不存在而失败**

```powershell
pnpm --filter @vykor/server test -- attachment-capabilities default-application-services
pnpm --filter @vykor/desktop exec vitest run custom-provider-form provider-service --maxWorkers=1
```

预期：新增断言 FAIL，错误指向 `inputCapabilities` / `imageInputSupport` 或解析函数尚不存在；既有纯文本模型字段测试不能被删除。

- [ ] **步骤 3：实现单一能力来源和端到端配置透传**

固定公开形状：

```ts
export type InputSupport = "native" | "unsupported" | "unknown";
export interface ModelInputCapabilities { image: InputSupport }
export interface ProviderInputCapabilities {
  image: InputSupport;
  imageMediaTypes: readonly string[];
}
export interface CustomProviderModelSettings {
  id: string;
  displayName: string;
  imageInputSupport: InputSupport;
}
```

`ModelInfo`/`DesktopModel` 增加 `inputCapabilities`。model picker 用该字段显示“图像 / 不支持图像 / 图像能力未知”；现有 `vision` 可以保留展示兼容，但不得参与路由。Provider registry 为 `openai_compat`、`codex`、`anthropic` 声明 adapter 能力与四种 MIME 白名单。

- [ ] **步骤 4：跑能力链路测试和相关类型检查**

```powershell
pnpm --filter @vykor/server test -- attachment-capabilities default-application-services
pnpm --filter @vykor/desktop exec vitest run custom-provider-form provider-service --maxWorkers=1
pnpm --filter @vykor/core check-types
pnpm --filter @vykor/api check-types
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/desktop typecheck
```

预期：全部 exit 0；测试覆盖 catalog 三态、自定义设置往返和缺省 unknown。

- [ ] **步骤 5：只提交任务 1 文件**

```powershell
git add packages/core/src/types/settings.ts packages/core/src/index.ts packages/api/src/providers/registry.ts packages/api/src/index.ts packages/server/src/application/settings-api.ts packages/server/src/application/default-services/model-service.ts packages/server/src/application/default-services/provider-service.ts packages/server/src/application/attachment-routing/attachment-capabilities.ts packages/server/src/application/attachment-routing/__test__/attachment-capabilities.test.ts packages/server/src/application/__test__/default-application-services.test.ts apps/desktop/src/shared/provider-types.ts apps/desktop/src/shared/session-types.ts apps/desktop/src/main/features/provider/provider-service.ts apps/desktop/src/main/features/provider/provider-service.test.ts apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-form.ts apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-form.test.ts apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-dialog.tsx apps/desktop/src/renderer/src/components/desktop/conversation-page/model-picker.tsx
git commit -m "feat(attachments): define native image capabilities (stage 4 task 1/5)"
```

---

### 任务 2：建立安全 Blob 解析和批量附件路由

**交付物：** 给定 durable input refs、执行时能力和 AbortSignal，路由器要么返回完整有序 `ContentBlock[]`，要么返回一个可落库的结构化失败；不会部分物化或接受任意路径。

**文件：**

- 创建：`packages/server/src/application/attachment-routing/attachment-routing-types.ts`
- 创建：`packages/server/src/application/attachment-routing/attachment-capability-router.ts`
- 测试：`packages/server/src/application/attachment-routing/__test__/attachment-capability-router.test.ts`
- 修改：`packages/services/src/attachment/attachment-blob-store.ts`
- 修改：`packages/services/src/attachment/attachment-application-service.ts`
- 修改：`packages/services/src/attachment/__test__/attachment-blob-store.test.ts`
- 修改：`packages/services/src/attachment/__test__/attachment-application-service.test.ts`
- 修改：`packages/services/src/index.ts`
- 修改：`packages/core/src/types/messages.ts`（删除或禁止 runtime `originalPath`）

- [ ] **步骤 1：先写 Blob 与路由失败测试**

至少固定以下矩阵：

```ts
it.each([
  ["unknown", "attachment_model_capability_unknown"],
  ["unsupported", "attachment_model_unsupported"],
])("blocks model image support %s", async (image, code) => {
  await expect(route({ modelCapabilities: { image }, attachments: [png] }))
    .rejects.toMatchObject({ code, assetIds: [png.assetId] });
});
```

另测：adapter unknown/unsupported、OCR intent、PDF、BMP、缺失 Blob、非普通文件、大小不符、非法 SHA、纯图片、文字加两图顺序、中途 abort、多附件一项失败时不返回部分 blocks。

- [ ] **步骤 2：运行测试确认红灯**

```powershell
pnpm --filter @vykor/services test -- attachment-blob-store attachment-application-service
pnpm --filter @vykor/server test -- attachment-capability-router
```

预期：`resolveReadOnlyPath`、`resolveReadyContentPath`、路由类型或错误码不存在导致 FAIL。

- [ ] **步骤 3：实现内容寻址路径和两阶段批量路由**

Blob API 固定为：

```ts
AttachmentBlobStore.resolveReadOnlyPath(
  sha256: string,
  expectedSizeBytes: number,
): Promise<string>

AttachmentApplicationService.resolveReadyContentPath(
  assetId: string,
): Promise<{ assetId: string; path: string; mediaType: string; sizeBytes: number }>
```

路由器先对整批做无 I/O capability/intent/MIME 判断，再按 `seq` 物化。只在全部成功后组装 `[nonEmptyText?, ...images]`。错误类型包含 `code`、安全 `message`、`assetIds`、`retryable=false` 和不含路径的 decisions。

- [ ] **步骤 4：跑服务与路由全量测试、类型检查和泄漏扫描**

```powershell
pnpm --filter @vykor/services test
pnpm --filter @vykor/server test -- attachment-capability-router
pnpm --filter @vykor/services check-types
pnpm --filter @vykor/server check-types
rg -n "originalPath" packages/core packages/server/src/application/attachment-routing packages/services/src/attachment
```

预期：测试和类型检查 exit 0；`originalPath` 不再出现在新运行时链路，测试夹具若必须描述拒绝输入需写明用途。

- [ ] **步骤 5：只提交任务 2 文件**

```powershell
git add packages/core/src/types/messages.ts packages/services/src/attachment packages/services/src/index.ts packages/server/src/application/attachment-routing/attachment-routing-types.ts packages/server/src/application/attachment-routing/attachment-capability-router.ts packages/server/src/application/attachment-routing/__test__/attachment-capability-router.test.ts
git commit -m "feat(attachments): route safe native image blocks (stage 4 task 2/5)"
```

---

### 任务 3：完成三家 Provider 的图片请求 contract

**交付物：** OpenAI、Codex、Anthropic 都能从相同 `ContentBlock[]` 生成合法图片请求；Anthropic 删除错误强转；转换失败绝不重发纯文本。

**文件：**

- 修改：`packages/api/src/providers/openai.ts`
- 修改：`packages/api/src/providers/openai.test.ts`
- 修改：`packages/api/src/providers/codex.ts`
- 修改：`packages/api/src/providers/codex.test.ts`
- 修改：`packages/api/src/providers/anthropic.ts`
- 修改：`packages/api/src/providers/anthropic.test.ts`
- 修改：`packages/api/src/errors/index.ts`（只在统一 mismatch 分类需要时）
- 修改：`packages/agent-runtime/src/default-runtime.ts`
- 修改：`packages/agent-runtime/src/default-runtime.test.ts`

- [ ] **步骤 1：为最终 SDK 请求写失败的 contract test**

每家都要断言文字、两张图片和顺序；Anthropic 的关键断言为：

```ts
expect(stream).toHaveBeenCalledWith(
  expect.objectContaining({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "compare" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: png64 } },
      ],
    }],
  }),
  expect.any(Object),
);
```

同时测试纯图片、不支持 MIME、读文件失败、AbortSignal、API 400 不触发第二次纯文本请求。用临时目录创建小字节文件，测试后清理。

- [ ] **步骤 2：运行 Provider 测试确认 Anthropic 红灯、既有 OpenAI/Codex 约束可见**

```powershell
pnpm --filter @vykor/api test -- openai codex anthropic
```

预期：Anthropic 图片请求因当前错误强转而 FAIL；新增严格 MIME/失败语义测试按缺口失败。

- [ ] **步骤 3：实现异步 Anthropic 转换并统一 adapter 边界**

Anthropic 用户内容转换签名固定为：

```ts
async function convertUserContentToAnthropic(
  content: string | ContentBlock[],
): Promise<string | Anthropic.ContentBlockParam[]>
```

OpenAI 与 Codex 保留现有正确 Data URL 形状，补 MIME 收窄、错误传播和 contract export。`default-runtime` 继续按 backend type 创建 adapter，不在这里做模型能力判断。Provider 400 若明确是图片能力不匹配，规范化为 `provider_capability_mismatch`，不得动态修改设置。

- [ ] **步骤 4：运行 API/agent-runtime 全量测试和类型检查**

```powershell
pnpm --filter @vykor/api test
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/api check-types
pnpm --filter @vykor/agent-runtime check-types
```

预期：全部 exit 0；三家请求 contract 覆盖相同顺序和失败不降级。

- [ ] **步骤 5：只提交任务 3 文件**

```powershell
git add packages/api/src/providers packages/api/src/errors packages/agent-runtime/src/default-runtime.ts packages/agent-runtime/src/default-runtime.test.ts
git commit -m "feat(attachments): send native images to providers (stage 4 task 3/5)"
```

---

### 任务 4：把路由接入 durable run、落库和 transcript

**交付物：** `SessionRunExecutor` 真正提交 ordered blocks；blocked run 零 Provider 调用、无 attempt、不关闭热 Agent，并产生可解释 metadata、事件和 transformation。

**文件：**

- 修改：`packages/server/src/application/session/session-run-executor.ts`
- 修改：`packages/server/src/application/session/__test__/session-run-executor.test.ts`
- 修改：`packages/server/src/application/session/transcript-projection.ts`
- 修改：`packages/server/src/application/session/__test__/transcript-projection.test.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/application/agent/daemon-agent-event-projector.ts`
- 修改：`packages/server/src/application/agent/__test__/daemon-agent-event-projector.test.ts`
- 修改：`packages/server/src/application/session/__test__/session-run-engine.test.ts`
- 修改：`packages/protocol/src/session.ts`、`packages/protocol/src/serialization.ts`（若事件结构需要公开 errorKind）

- [ ] **步骤 1：写 Executor 集成失败测试，覆盖成功和全部阻止语义**

成功断言：

```ts
expect(submitMessage).toHaveBeenCalledWith([
  { type: "text", text: "compare" },
  { type: "image", source: expect.objectContaining({ type: "file", mediaType: "image/png" }) },
], expect.objectContaining({ ids: { inputId: "input-1", runId: "run-1", traceId: "trace-1" } }));
```

失败断言必须包含：`acquireSession` 为 0 次、`submitMessage` 为 0 次、`close` 为 0 次、attempt 数量为 0、run failed、metadata 有 blocked decision、事件有 `errorKind`、相关 transformation failed。另测 queued run 执行前切模、纯文本保持 string 输入、AbortSignal 优先、两图一项失败全不发送。

- [ ] **步骤 2：运行 Server 定向测试确认红灯**

```powershell
pnpm --filter @vykor/server test -- session-run-executor transcript-projection daemon-agent-event-projector session-run-engine
```

预期：Executor 仍只提交字符串，路由依赖和 transformation API 不存在导致 FAIL。

- [ ] **步骤 3：实现预检、原子结算和 direct transformation**

向 Executor 注入：

```ts
attachments: Pick<AttachmentApplicationService, "resolveReadyContentPath">;
routeAttachments(input: RouteAttachmentBatchInput): Promise<NativeAttachmentRouteResult>;
resolveCapabilities(session: SessionRecord): Promise<ResolvedAttachmentCapabilities>;
```

先读 `readSessionRuntimeConfig(session)`，再路由；通过后才 `acquireSession()`。用 `agentAcquired` 控制失败清理。路由结果合并进 `run.metadata.attachmentRouting`；失败事务内完成 transformation、part、event、run 结算。成功 direct transformation 在 Provider 调用前落库，但不代表 run completed。

- [ ] **步骤 4：跑 Server 全量测试、类型检查和敏感字段扫描**

```powershell
pnpm --filter @vykor/server test
pnpm --filter @vykor/protocol test
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/protocol check-types
rg -n "data:image|base64,|originalPath" packages/server/src/application/session packages/server/src/application/attachment-routing
```

预期：全部测试/类型检查 exit 0；运行 metadata、事件和日志构造代码中没有 Data URL、Base64 或原始路径。

- [ ] **步骤 5：只提交任务 4 文件**

```powershell
git add packages/server/src/application/session packages/server/src/application/daemon-application.ts packages/server/src/application/agent/daemon-agent-event-projector.ts packages/server/src/application/agent/__test__/daemon-agent-event-projector.test.ts packages/protocol/src/session.ts packages/protocol/src/serialization.ts
git commit -m "feat(attachments): execute durable native image runs (stage 4 task 4/5)"
```

---

### 任务 5：补齐 Desktop 反馈、端到端回归和阶段收束

**交付物：** 用户能看懂 blocked/direct 状态；完整链路在开发和测试环境可验证；纯文本、队列、retry/edit/fork/restart 不回归；生产 gate 与 OCR 边界不变。

**文件：**

- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message-attachment.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/transcript.test.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/conversation-page/model-picker.test.tsx`
- 修改：`packages/server/src/application/session/__test__/session-run-executor.test.ts`
- 修改：`packages/server/src/application/session/__test__/session-run-engine.test.ts`
- 修改：`docs/superpowers/specs/2026-08-27-conversation-attachments-roadmap-design.md`
- 修改：`docs/superpowers/specs/2026-08-28-conversation-attachments-stage-4-design.md`
- 修改：`docs/superpowers/plans/2026-08-28-conversation-attachments-stage-4.md`

- [ ] **步骤 1：写用户反馈与跨生命周期回归测试**

固定文案映射，例如：

```ts
expect(attachmentRoutingMessage("attachment_model_capability_unknown"))
  .toBe("当前模型没有声明图片能力，请切换支持图片的模型后重试。");
expect(attachmentRoutingMessage("attachment_intent_unavailable"))
  .toBe("当前阶段还不能执行 OCR 或文档处理，请移除附件处理方式后重试。");
```

集成测试覆盖：模型支持时真实 `ImageBlock` 到假 Provider；不支持时假 Provider 零调用；排队切模；retry/edit/fork/restart refs 顺序；多轮第二次请求仍能读取 daemon Blob；纯文本输入仍是 string；`ImageToText` 未注册为自动 fallback。

- [ ] **步骤 2：实现错误文案和 transformation 展示，不增加降级按钮**

direct completed 显示“已作为原生图片输入”；failed 根据稳定错误码显示短文案。允许用户沿用现有切模型、编辑、重试操作，不新增“忽略图片”“自动 OCR”“只发文字”。模型能力 unknown 在 picker 中清楚显示，但不禁用普通纯文本使用。

- [ ] **步骤 3：先跑所有受影响包的完整测试**

```powershell
pnpm --filter @vykor/services test
pnpm --filter @vykor/api test
pnpm --filter @vykor/server test
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/desktop exec vitest run --maxWorkers=1
```

预期：全部 exit 0；不得只凭定向测试进入收束。如果 Desktop 全量失败，先确认是否为已有基线，并对本阶段相关测试单独复现和修复新增失败。

- [ ] **步骤 4：跑完整类型、文档、diff 和 scoped lint 验证**

```powershell
pnpm check-types
pnpm check-docs
git diff --check
pnpm exec eslint apps/desktop/src/shared/provider-types.ts apps/desktop/src/shared/session-types.ts apps/desktop/src/main/features/provider/provider-service.ts apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-form.ts apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-dialog.tsx apps/desktop/src/renderer/src/components/desktop/conversation-page/model-picker.tsx apps/desktop/src/renderer/src/components/desktop/conversation-page/message-attachment.tsx
```

预期：全仓类型检查、文档检查、diff check 和改动文件 lint 均 exit 0。额外核对：

```powershell
git diff --name-only HEAD~4
git diff HEAD~4 -- packages/tools/src/media/image-to-text.ts
rg -n "FEATURE.*ATTACH|attachment.*enabled" apps/desktop/src | Select-Object -First 80
```

第二条必须无 diff；生产附件 gate 仍保持关闭。

- [ ] **步骤 5：把真实验证证据写回文档并提交任务 5**

只记录刚刚实际运行的测试数量、退出码和仍存在的基线，不写推测数字。然后：

```powershell
git add packages/server/src/application/session/__test__/session-run-executor.test.ts packages/server/src/application/session/__test__/session-run-engine.test.ts apps/desktop/src/renderer/src/components/desktop/conversation-page apps/desktop/src/renderer/src/components/desktop/settings-page docs/superpowers/specs/2026-08-27-conversation-attachments-roadmap-design.md docs/superpowers/specs/2026-08-28-conversation-attachments-stage-4-design.md docs/superpowers/plans/2026-08-28-conversation-attachments-stage-4.md
git commit -m "docs: complete conversation attachments stage 4 (task 5/5)"
```

---

## 最终验收清单

- [ ] OpenAI、Codex、Anthropic 的请求 contract 都验证真实图片字节和顺序。
- [ ] unsupported/unknown/非法内容的 Provider 调用次数为零。
- [ ] 多附件不会部分发送，纯附件不会生成空文本占位。
- [ ] blocked run 没有 attempt、不获取或关闭 Agent，run/part/event/metadata 状态一致。
- [ ] Provider 实际拒图时才产生 `provider_capability_mismatch` attempt。
- [ ] 排队切模、retry、edit、fork、restart、多轮历史都重新使用 daemon Blob。
- [ ] metadata、SSE、日志不包含 Base64、Data URL、原始路径或 Blob 绝对路径。
- [ ] 自定义模型能力可显式设置，缺省 unknown，不猜模型名。
- [ ] 纯文本和工具调用回归测试通过。
- [ ] `ImageToText` 无改动、无自动调用；生产附件 gate 仍关闭。
- [ ] 受影响包全量测试、全仓类型、文档检查、diff check、改动文件 lint 有新鲜成功证据。

## 完成后的下一步

阶段 4 验收后再开始阶段 5：移除 `ImageToText` 的远程视觉模型能力，接入 `light-ocr` 本地 OCR，并让不支持图片的主 Agent 通过正常工具调用主动识别。阶段 4 不提前混入这部分实现。
