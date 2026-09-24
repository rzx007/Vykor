# 对话附件阶段 2 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让已上传的附件作为 Prompt 的持久引用，与 input 和 owning run 原子提交，并在队列、恢复、编辑、重放、fork、Snapshot、SSE、Transcript 和 Client 中保持一致。

**架构：** `session_input_attachment` 是输入附件引用的唯一真实来源，`SessionInputRecord.attachments` 是对它的有序读取模型，message attachment part 是 Transcript 投影。admission 在 `SessionStore` 的一个事务内检查资产、配额和幂等后写入 input、refs、run；模型输入与 OCR 不在本阶段执行。

**技术栈：** TypeScript、SQLite、better-sqlite3、Drizzle schema/migrations、Hono、Vitest、pnpm/Turbo。

---

## 实施边界

设计依据：`docs/superpowers/specs/2026-08-28-conversation-attachments-stage-2-design.md`。

本计划只实现阶段 2。不要增加 Desktop 上传入口，不要把附件转换成 Provider 图片输入，不要改造 `ImageToText`，不要引入 OCR、PDF 提取、文件挂载、分片上传或 Blob GC。

## 文件结构与职责

### 新建文件

- `packages/services/src/session-runtime/migrations/0014_session_input_attachments.sql`：创建输入附件引用表、外键和查询索引。
- `packages/services/src/session-runtime/prompt-attachments.ts`：附件输入规范化、幂等指纹、资产状态和配额计算的纯函数。
- `packages/services/src/session-runtime/__test__/prompt-attachments.test.ts`：覆盖规范化、顺序、重复引用和唯一资产计费。

### 修改文件

- `packages/protocol/src/attachment.ts`：定义并解析 `SessionInputAttachmentRecord`。
- `packages/protocol/src/attachment.test.ts`：引用记录协议测试。
- `packages/protocol/src/session.ts`：Prompt 附件输入、必填 `attachments`、attachment/transformation part 类型。
- `packages/protocol/src/requests.ts`、`packages/protocol/src/requests.test.ts`：解析 HTTP Prompt 的附件数组。
- `packages/protocol/src/serialization.ts`、`packages/protocol/src/serialization.test.ts`：严格解析 Snapshot、SSE 中的附件与新 part。
- `packages/protocol/src/index.ts`：导出新增协议类型和解析函数。
- `packages/services/src/session-runtime/migrations/0000_session_runtime.sql`：新数据库基线移除 `session_run.input_id` 唯一约束。
- `packages/services/src/session-runtime/migrations/0011_storage_format.sql`：新数据库直接写入 storage format 2。
- `packages/services/src/session-runtime/migrations/meta/_journal.json`：注册 migration 0014。
- `packages/services/src/session-runtime/schema.ts`：Drizzle 引用表和普通 run-input 索引。
- `packages/services/src/session-runtime/store-state.ts`：引用 mutation 集合和附件限制配置。
- `packages/services/src/session-runtime/store.ts`：批量加载引用、原子 admission、引用查询、run 查询、edit/fork/delete 生命周期。
- `packages/services/src/session-runtime/__test__/store.test.ts`：format 2、事务、重启、引用、run 一对多、级联和压力测试。
- `packages/services/src/attachment/attachment-errors.ts`：补充阶段 2 稳定错误码。
- `packages/services/src/attachment/attachment-application-service.ts`：删除前引用保护。
- `packages/services/src/attachment/__test__/attachment-application-service.test.ts`：被引用附件禁止删除。
- `packages/server/src/application/daemon-application.ts`：将同一份附件 limits 传给运行引擎。
- `packages/server/src/application/session/session-run-engine.ts`：附件 steer 入队、附件幂等和原子 run admission。
- `packages/server/src/application/session/session-application-service.ts`：live child 分流、resume、edit 和 fork 的附件语义。
- `packages/server/src/application/session/session-application-error.ts`：保留会话通用错误；附件错误不靠文字匹配。
- `packages/server/src/application/session/transcript-projection.ts`：按 input refs 投影 text/attachment parts。
- `packages/server/src/application/session/__test__/session-run-engine.test.ts`：queue、幂等和原子 admission。
- `packages/server/src/application/session/__test__/session-application-service.test.ts`：resume 与 live child 分流。
- `packages/server/src/application/session/__test__/session-application-service-edit.test.ts`：编辑替换 refs。
- `packages/server/src/application/session/__test__/session-application-service-queue-actions.test.ts`：附件 queued input 禁止 promote。
- `packages/server/src/application/session/__test__/transcript-projection.test.ts`：纯附件和混合 Prompt 投影。
- `packages/server/src/application/agent/agent-transcript.ts`：返回 Provider-safe messages 与附件 sidecar。
- `packages/server/src/application/agent/__test__/agent-transcript.test.ts`：附件 sidecar 不进入 Provider content。
- `packages/server/src/daemon/daemon-agent.ts`：加载 history 时只传 `.messages`。
- `packages/server/src/http/support.ts`：阶段 2 附件错误码到 HTTP 状态的唯一映射。
- `packages/server/src/http/routes/run-execution.ts`：edit 请求接收附件；普通 Prompt 继续使用协议解析器。
- `packages/server/src/http/routes/attachment.ts`：删除保护错误响应。
- `packages/server/src/http/routes/__test__/protocol-validation.test.ts`：Prompt 附件 JSON 形状。
- `packages/server/src/http/routes/__test__/routes.test.ts`：edit、promote 和稳定错误状态。
- `packages/server/src/http/__test__/http.test.ts`：真实上传、发送、恢复、删除保护和重启闭环。
- `packages/server/src/session/export-session.ts`、`packages/server/src/session/__test__/export-session.test.ts`：Markdown/JSON 导出附件。
- `packages/server/src/application/session/session-maintenance-service.ts`、`packages/server/src/application/session/__test__/session-maintenance-service.test.ts`：compaction 保留引用事实。
- `packages/client/src/types/index.ts`、`packages/client/src/index.ts`：复用并导出协议附件类型。
- `packages/client/src/transport/http-client.ts`、`packages/client/src/transport/__test__/http-client.test.ts`：普通发送和 edit 的附件请求。
- `packages/client/src/state/reducer.ts`、`packages/client/src/state/__test__/reducer.test.ts`：Snapshot/SSE 重放时按 input ID 收敛完整附件数组。
- `docs/superpowers/specs/2026-08-27-conversation-attachments-roadmap-design.md`、`docs/superpowers/specs/2026-08-28-conversation-attachments-stage-2-design.md`：实现完成后更新状态和验证证据。

## 任务 1：建立严格的协议契约

**交付物：** 协议层能表达、解析并拒绝错误的 Prompt 附件、输入引用和两种新 message part；无附件请求仍规范化为 `[]`。

**文件：**

- 修改：`packages/protocol/src/attachment.ts`
- 修改：`packages/protocol/src/attachment.test.ts`
- 修改：`packages/protocol/src/session.ts`
- 修改：`packages/protocol/src/requests.ts`
- 修改：`packages/protocol/src/requests.test.ts`
- 修改：`packages/protocol/src/serialization.ts`
- 修改：`packages/protocol/src/serialization.test.ts`
- 修改：`packages/protocol/src/index.ts`
- 修改：`packages/client/src/types/index.ts`
- 修改：`packages/client/src/index.ts`

- [ ] **步骤 1：先写请求解析和 Snapshot 解码失败测试**

在 `requests.test.ts` 固定输入规范化：

```ts
expect(parseAdmitPromptRequest({
  content: "",
  attachments: [{ assetId: "att_1", intent: "ocr", displayName: "scan.png" }],
})).toEqual({
  content: "",
  attachments: [{ assetId: "att_1", intent: "ocr", displayName: "scan.png" }],
});

expect(() => parseAdmitPromptRequest({
  content: "look",
  attachments: [{ assetId: 7 }],
})).toThrow(/attachments\[0\]\.assetId/);
```

在 `serialization.test.ts` 增加缺少 `input.attachments` 必须失败、attachment/transformation part 字段缺失必须失败的用例。

- [ ] **步骤 2：运行协议测试并确认失败**

运行：`pnpm --filter @vykor/protocol test -- src/requests.test.ts src/serialization.test.ts src/attachment.test.ts`

预期：FAIL，错误指向 `attachments` 尚未解析或新 part 类型尚未被接受。

- [ ] **步骤 3：实现协议类型和逐字段解析**

在 `session.ts` 使用同一组公开类型：

```ts
export interface AdmitPromptAttachmentInput {
  assetId: string;
  intent?: AttachmentIntent;
  displayName?: string;
}

export interface SessionInputRecord {
  // existing fields
  attachments: SessionInputAttachmentRecord[];
}

export type SessionMessagePartRecord =
  | SessionTextualMessagePartRecord
  | SessionAttachmentMessagePartRecord
  | SessionTransformationMessagePartRecord
  | SessionToolMessagePartRecord;
```

`parseAdmitPromptRequest` 只做 JSON 形状校验；缺省附件返回 `attachments: []`，但不在协议层查询 asset。`validateInput` 必须调用 `arrayField(item, "attachments", ...)`，不能接受字段缺失。attachment part 校验 `assetId/intent/displayName/mediaType/sizeBytes`；transformation part 校验 `kind/status` 和可选结果字段。

- [ ] **步骤 4：让 Client 直接重导出协议类型**

删除 Client 中含义相同的镜像声明，保留：

```ts
export type PromptInputForClient = Omit<AdmitPromptInput, "sessionId">;
export type {
  AdmitPromptAttachmentInput,
  SessionInputAttachmentRecord,
  SessionAttachmentMessagePartRecord,
  SessionTransformationMessagePartRecord,
} from "@vykor/protocol";
```

- [ ] **步骤 5：运行协议、Client 类型检查和测试**

运行：`pnpm --filter @vykor/protocol test && pnpm --filter @vykor/protocol check-types && pnpm --filter @vykor/client check-types`

预期：全部 PASS。

- [ ] **步骤 6：提交协议契约**

```bash
git add packages/protocol/src packages/client/src/types/index.ts packages/client/src/index.ts
git commit -m "feat(attachments): define prompt reference protocol"
```

## 任务 2：建立 storage format 2 和引用表

**交付物：** 新数据库只生成 format 2，format 1 在 migration 前被拒绝；引用表约束正确；一条 input 可以对应多个 run。

**文件：**

- 修改：`packages/services/src/session-runtime/migrations/0000_session_runtime.sql`
- 修改：`packages/services/src/session-runtime/migrations/0011_storage_format.sql`
- 创建：`packages/services/src/session-runtime/migrations/0014_session_input_attachments.sql`
- 修改：`packages/services/src/session-runtime/migrations/meta/_journal.json`
- 修改：`packages/services/src/session-runtime/schema.ts`
- 修改：`packages/services/src/session-runtime/store.ts`
- 测试：`packages/services/src/session-runtime/__test__/store.test.ts`

- [ ] **步骤 1：写 format 和约束测试**

测试必须直接打开 SQLite 检查：

```ts
expect(db.prepare(
  "SELECT version FROM application_storage_format WHERE id = 1",
).get()).toEqual({ version: 2 });

expect(indexNames(db, "session_input_attachment")).toEqual(expect.arrayContaining([
  "session_input_attachment_input_seq_idx",
  "session_input_attachment_asset_idx",
  "session_input_attachment_session_idx",
]));

expect(() => openFormatOneDatabase(path)).toThrow(/format 1.*delete|move/i);
```

再创建同一 `input_id` 的两个 `session_run`，断言都可插入；重复 `(input_id, seq)` 和 `(input_id, asset_id)` 必须失败。

- [ ] **步骤 2：运行 Store 测试并确认失败**

运行：`pnpm --filter @vykor/services test -- src/session-runtime/__test__/store.test.ts`

预期：FAIL，当前 format 为 1、引用表不存在、第二个 run 触发唯一约束。

- [ ] **步骤 3：修改新数据库基线和 migration**

`0000_session_runtime.sql` 将 `input_id TEXT UNIQUE` 改为 `input_id TEXT`；`0011_storage_format.sql` 写入 version 2。`0014` 使用设计文档给出的表结构，并以 `--> statement-breakpoint` 分隔语句。

`schema.ts` 的 run 索引改为：

```ts
index("session_run_input_idx").on(table.inputId),
```

并新增 `sessionInputAttachments`，三个外键分别使用 session/input cascade、asset restrict。`0014` 同时给 `session_message_part` 增加这些 nullable 类型化列：`asset_id`、`attachment_intent`、`display_name`、`media_type`、`size_bytes`、`transformation_kind`、`representation_id`、`processor`、`transformation_error`；`schema.ts` 使用同名字段描述它们。

- [ ] **步骤 4：把 Store 的格式断言改成只接受 version 2**

空数据库仍先通过 `assertCurrentStorageFormatOrEmpty()`，然后执行 migration；非空 format 1 在 `applyMigrations()` 之前抛出包含“move or delete the old database”的错误。不要编写 format 1 升级分支。

- [ ] **步骤 5：运行 migration 检查和 Store 测试**

运行：`pnpm --filter @vykor/services db:check && pnpm --filter @vykor/services test -- src/session-runtime/__test__/store.test.ts`

预期：全部 PASS。

- [ ] **步骤 6：提交数据库基线**

```bash
git add packages/services/src/session-runtime/migrations packages/services/src/session-runtime/schema.ts packages/services/src/session-runtime/store.ts packages/services/src/session-runtime/__test__/store.test.ts
git commit -m "feat(attachments): add durable prompt reference schema"
```

## 任务 3：实现引用规范化和原子 Store admission

**交付物：** Store 在一个事务中验证 asset、配额和幂等，写入 input、ordered refs、owning run；重启后一次查询批量恢复引用。

**文件：**

- 创建：`packages/services/src/session-runtime/prompt-attachments.ts`
- 创建：`packages/services/src/session-runtime/__test__/prompt-attachments.test.ts`
- 修改：`packages/services/src/session-runtime/store-state.ts`
- 修改：`packages/services/src/session-runtime/store.ts`
- 修改：`packages/services/src/session-runtime/index.ts`
- 修改：`packages/services/src/attachment/attachment-errors.ts`
- 测试：`packages/services/src/session-runtime/__test__/store.test.ts`

- [ ] **步骤 1：写纯函数和事务失败测试**

纯函数测试固定 ordered fingerprint 和唯一资产计费：

```ts
expect(promptAttachmentFingerprint([
  { assetId: "b", intent: "auto", displayName: "b.png" },
  { assetId: "a", intent: "ocr", displayName: "a.png" },
])).not.toEqual(promptAttachmentFingerprint([
  { assetId: "a", intent: "ocr", displayName: "a.png" },
  { assetId: "b", intent: "auto", displayName: "b.png" },
]));

expect(uniqueReferencedBytes(existingRefs, proposedRefs)).toBe(300);
```

Store 测试用触发器让 ref 或 run 插入失败，随后断言 input、refs、run、`session.input.admitted` 全部不存在；再覆盖 unknown/importing/failed/deleted、重复 asset、数量和两级字节配额。

- [ ] **步骤 2：运行新增测试并确认失败**

运行：`pnpm --filter @vykor/services test -- src/session-runtime/__test__/prompt-attachments.test.ts src/session-runtime/__test__/store.test.ts`

预期：FAIL，辅助函数和引用 Store API 尚不存在。

- [ ] **步骤 3：实现纯函数与稳定错误**

`normalizePromptAttachments` 输出：

```ts
type NormalizedPromptAttachment = {
  assetId: string;
  intent: AttachmentIntent;
  displayName?: string;
};
```

它保持数组顺序、把 intent 缺省为 `auto`、拒绝重复 asset。扩充 `AttachmentErrorCode`，准确加入设计文档的九个阶段 2 code；错误实例继续把 code 放在消息前缀中，供当前 `{ error: string }` 响应稳定识别。

- [ ] **步骤 4：把 refs 纳入 Store 内存状态和 transaction rollback**

`SessionState` 增加按 ID 保存的 refs；`StoreMutations` 增加 `inputAttachments` 与 `deletedInputAttachments`。`cloneMutations`、`emptyMutations`、事务快照和 rollback 都必须包含它们。

`load()` 只执行一次：

```sql
SELECT * FROM session_input_attachment ORDER BY input_id, seq
```

然后按 `input_id` 分组组装每个 `SessionInputRecord.attachments`，禁止在 input 循环里查询数据库。

- [ ] **步骤 5：实现原子 admission 与明确 run 查询**

`admitPrompt` 在事务内完成 asset 查询、状态检查、displayName 快照、mediaType/sizeBytes 快照、配额、input 和 refs。`admitPromptWithRun` 在同一外层事务创建 owning run。成功后事件 payload 使用已组装的完整 input。

替换含义含糊的查询：

```ts
listInputAttachments(inputId: string): SessionInputAttachmentRecord[];
countInputAttachmentReferences(assetId: string): number;
listRunsByInput(inputId: string): SessionRunRecord[];
findOwningRunByInput(inputId: string): SessionRunRecord | undefined;
```

owning run 是按 `createdAt`、再按 `id` 排序的第一条；启动恢复与 admission 幂等使用它。

- [ ] **步骤 6：运行 Store 测试和类型检查**

运行：`pnpm --filter @vykor/services test -- src/session-runtime/__test__/prompt-attachments.test.ts src/session-runtime/__test__/store.test.ts && pnpm --filter @vykor/services check-types`

预期：全部 PASS，包括关闭并重开数据库后附件顺序和快照不变。

- [ ] **步骤 7：提交原子持久化**

```bash
git add packages/services/src/session-runtime packages/services/src/attachment/attachment-errors.ts
git commit -m "feat(attachments): persist prompt references atomically"
```

## 任务 4：接通 application admission、幂等和 queue

**交付物：** 普通 Prompt、纯附件 Prompt 和带附件 steer 通过同一条应用链路；附件参与并发幂等；带附件 queued input 不能 promote。

**文件：**

- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/application/session/session-run-engine.ts`
- 修改：`packages/server/src/application/session/session-application-service.ts`
- 修改：`packages/server/src/http/support.ts`
- 测试：`packages/server/src/application/session/__test__/session-run-engine.test.ts`
- 测试：`packages/server/src/application/session/__test__/session-application-service.test.ts`
- 测试：`packages/server/src/application/session/__test__/session-application-service-queue-actions.test.ts`

- [ ] **步骤 1：写应用行为测试**

固定三条关键行为：

```ts
await expect(engine.admitPromptAndMaybeRun("s1", {
  id: "only-file",
  content: "",
  attachments: [{ assetId: "att_1" }],
})).resolves.toMatchObject({ input: { attachments: [{ assetId: "att_1" }] } });

await expect(engine.admitPromptAndMaybeRun("s1", {
  id: "steer-file",
  delivery: "steer",
  content: "inspect",
  attachments: [{ assetId: "att_1" }],
})).resolves.toMatchObject({ input: { delivery: "queue" }, queue_state: "queued" });
```

相同 ID 改变附件顺序、intent 或 displayName 返回 `prompt_id_conflict`；并发相同请求只调用一次 Store admission。promote 带附件 input 返回 `attachment_structured_steer_unsupported`。

- [ ] **步骤 2：运行 application 测试并确认失败**

运行：`pnpm --filter @vykor/server test -- src/application/session/__test__/session-run-engine.test.ts src/application/session/__test__/session-application-service.test.ts src/application/session/__test__/session-application-service-queue-actions.test.ts`

预期：FAIL，当前并发指纹只比较文字，steer 仍尝试直接送 active run。

- [ ] **步骤 3：让所有 admission 使用规范化后的附件指纹**

`pendingAdmissions` 保存最终 delivery 和 ordered attachment fingerprint。已存在 input 的比较使用 Store 返回的 refs，不比较 ref ID/createdAt。发生冲突时抛出带 `prompt_id_conflict` code 的错误。

Daemon 装配把 `this.attachments.limits` 传入 `SessionRunEngine`；运行引擎把同一份 limits 传给 Store admission，避免上传限制和 Prompt 限制使用两份配置。

- [ ] **步骤 4：实现 steer 降级和 live child 分流**

规范化逻辑必须在检查 active run 和 live child 之前执行：

```ts
const finalDelivery = normalizedAttachments.length > 0 && requestedDelivery === "steer"
  ? "queue"
  : requestedDelivery;
```

附件请求不调用 `liveChildren.send()`；它进入 daemon 的 durable queue。无附件 steer 保持原行为。`promoteQueuedPrompt` 在调用 run engine 前检查 `input.attachments.length` 并返回 409 稳定 code。

- [ ] **步骤 5：统一 HTTP 错误映射**

`applicationErrorResponse` 同时识别 `ApplicationError` 和 `AttachmentError`，阶段 2 错误按设计表映射到 400/404/409/413。不要在 route 中用正则或消息文本判断状态。

- [ ] **步骤 6：运行 application 测试和类型检查**

运行：`pnpm --filter @vykor/server test -- src/application/session/__test__/session-run-engine.test.ts src/application/session/__test__/session-application-service.test.ts src/application/session/__test__/session-application-service-queue-actions.test.ts && pnpm --filter @vykor/server check-types`

预期：全部 PASS。

- [ ] **步骤 7：提交应用 admission**

```bash
git add packages/server/src/application packages/server/src/http/support.ts
git commit -m "feat(attachments): admit prompt references through session queue"
```

## 任务 5：投影 Transcript 并建立 Agent sidecar

**交付物：** 用户消息按文字和附件顺序投影；Agent history 能恢复附件元数据，但 Provider 仍只收到既有 message 内容。

**文件：**

- 修改：`packages/services/src/session-runtime/store.ts`
- 修改：`packages/server/src/application/session/transcript-projection.ts`
- 修改：`packages/server/src/application/session/__test__/transcript-projection.test.ts`
- 修改：`packages/server/src/application/agent/agent-transcript.ts`
- 修改：`packages/server/src/application/agent/__test__/agent-transcript.test.ts`
- 修改：`packages/server/src/daemon/daemon-agent.ts`

- [ ] **步骤 1：写 Transcript 投影测试**

纯附件 input 应生成一个 user message 和一个 attachment part，不生成空 text part；混合 input 应先生成 text part，再按 ref seq 生成 attachment parts。断言 attachment part 的 `metadata.inputAttachmentId` 存在且核心字段不藏在 metadata。

- [ ] **步骤 2：写 Agent sidecar 测试**

固定返回形状：

```ts
expect(buildAgentTranscript(messages, parts)).toEqual({
  messages: [{ type: "user", content: "inspect this" }],
  attachmentsByMessageId: {
    m1: [{
      assetId: "att_1",
      intent: "vision",
      displayName: "screen.png",
      mediaType: "image/png",
      sizeBytes: 42,
    }],
  },
});
```

另外断言 `.messages` 中没有 `ImageBlock`、路径、base64 或未知 content part。

- [ ] **步骤 3：运行投影测试并确认失败**

运行：`pnpm --filter @vykor/server test -- src/application/session/__test__/transcript-projection.test.ts src/application/agent/__test__/agent-transcript.test.ts`

预期：FAIL，当前投影无条件创建 text part，Agent transcript 丢弃附件。

- [ ] **步骤 4：实现统一的用户输入投影**

在 `SessionTranscriptProjection` 提取 `projectUserInput(message, input)`：文字非空时写 text part；逐个写 attachment part。`beginRun` 和 `projectSteeredInputs` 都调用它，避免两条路径行为不同。

Store 的 part 持久化和 load 必须读写任务 2 已加入的专有列：attachment 使用 `asset_id/attachment_intent/display_name/media_type/size_bytes`，transformation 使用 `asset_id/transformation_kind/representation_id/processor/transformation_error`，status 继续使用现有 `status` 列。把这些列加入所有 part INSERT/SELECT，核心字段不能放进 metadata 或借用 tool JSON。

- [ ] **步骤 5：实现 Provider-safe sidecar**

把 `transcriptToAgentMessages` 改为 `buildAgentTranscript`，返回 `{ messages, attachmentsByMessageId }`。`daemon-agent.ts` 使用：

```ts
const transcript = buildAgentTranscript(history, parts);
agent.loadHistory(transcript.messages);
```

阶段 2 不把 sidecar 传给 Provider；阶段 4 再消费它。反向 compaction 转换保留已有 tool/text 行为，不生成虚假的 transformation。

- [ ] **步骤 6：运行投影、Agent 和 Store 测试**

运行：`pnpm --filter @vykor/server test -- src/application/session/__test__/transcript-projection.test.ts src/application/agent/__test__/agent-transcript.test.ts && pnpm --filter @vykor/services test -- src/session-runtime/__test__/store.test.ts`

预期：全部 PASS。

- [ ] **步骤 7：提交 Transcript 支持**

```bash
git add packages/services/src/session-runtime packages/server/src/application/session/transcript-projection.ts packages/server/src/application/session/__test__/transcript-projection.test.ts packages/server/src/application/agent packages/server/src/daemon/daemon-agent.ts
git commit -m "feat(attachments): project references into conversation history"
```

## 任务 6：完成 replay、edit、fork 和删除 Session 的引用生命周期

**交付物：** 重放复用 input/refs 创建新 run；编辑原子替换输入引用；fork 创建新 input/ref/message/part ID 并复用 asset；删除分支只移除自身引用。

**文件：**

- 修改：`packages/services/src/session-runtime/store.ts`
- 修改：`packages/services/src/session-runtime/__test__/store.test.ts`
- 修改：`packages/server/src/application/session/session-application-service.ts`
- 修改：`packages/server/src/application/session/session-run-engine.ts`
- 修改：`packages/server/src/application/session/__test__/session-application-service.test.ts`
- 修改：`packages/server/src/application/session/__test__/session-application-service-edit.test.ts`
- 修改：`packages/server/src/application/session/__test__/session-run-engine.test.ts`

- [ ] **步骤 1：写 replay 一对多 run 测试**

中断 run 的 resume 使用原 `sourceInput.id`：

```ts
expect(resumed.input.id).toBe(sourceInput.id);
expect(resumed.run.inputId).toBe(sourceInput.id);
expect(store.listRunsByInput(sourceInput.id)).toHaveLength(2);
expect(resumed.input.attachments).toEqual(sourceInput.attachments);
```

相同 recovery run ID 与 sourceRunId 返回第一次结果；同 ID 指向另一 source 返回 409。

- [ ] **步骤 2：写 edit 和 fork 原子测试**

编辑失败触发器应保留旧 message/input/refs/run；成功后旧替换段全部删除，新 input/refs/run 同时出现。fork 测试逐项断言：新 session/input/ref/message/part ID 不等于父分支，`assetId` 相等；删除子分支后父分支 ref 仍存在。

- [ ] **步骤 3：运行生命周期测试并确认失败**

运行：`pnpm --filter @vykor/services test -- src/session-runtime/__test__/store.test.ts && pnpm --filter @vykor/server test -- src/application/session/__test__/session-application-service.test.ts src/application/session/__test__/session-application-service-edit.test.ts src/application/session/__test__/session-run-engine.test.ts`

预期：FAIL，当前 resume 创建新 input，fork 只复制 messages/parts，edit 不删除旧 input refs。

- [ ] **步骤 4：实现 Store 原子生命周期 API**

新增职责明确的方法：

```ts
createReplayRun(inputId, { id, metadata }): SessionRunRecord;
replaceLatestPromptWithAdmission(command): { input; run?; transcript };
forkSessionWithHistory(command): SessionRecord;
```

`forkSessionWithHistory` 建立 source→fork 的 input/message ID 映射，再复制 refs 和 parts；不得让子 session 的 message 指向父 input。`deleteSessionTree` 从内存 state 和 mutation 集合中同步移除 refs，但不调用 attachment soft delete 或 Blob 删除。

- [ ] **步骤 5：修改 application 只编排 Store 原子 API**

`resumeRun` 的 command `id` 解释为 recovery run ID，不再创建 recovery input。`editLatestPrompt` 的幂等比较加入 ordered attachments。`forkSession` 不再先 `createSession` 再 `replaceTranscript`，而是一次调用 `forkSessionWithHistory`，事务提交后才发布事件。

- [ ] **步骤 6：运行生命周期测试和类型检查**

运行：`pnpm --filter @vykor/services test -- src/session-runtime/__test__/store.test.ts && pnpm --filter @vykor/server test -- src/application/session/__test__/session-application-service.test.ts src/application/session/__test__/session-application-service-edit.test.ts src/application/session/__test__/session-run-engine.test.ts && pnpm --filter @vykor/server check-types`

预期：全部 PASS。

- [ ] **步骤 7：提交引用生命周期**

```bash
git add packages/services/src/session-runtime packages/server/src/application/session
git commit -m "feat(attachments): preserve references across conversation lifecycle"
```

## 任务 7：增加附件删除保护和稳定 HTTP 契约

**交付物：** 被任一 input 引用的 asset 返回 409；解除最后一个引用后可逻辑删除；Blob 永不在阶段 2 删除。

**文件：**

- 修改：`packages/services/src/session-runtime/store.ts`
- 修改：`packages/services/src/attachment/attachment-application-service.ts`
- 修改：`packages/services/src/attachment/__test__/attachment-application-service.test.ts`
- 修改：`packages/server/src/http/support.ts`
- 修改：`packages/server/src/http/routes/attachment.ts`
- 修改：`packages/server/src/http/routes/__test__/routes.test.ts`
- 修改：`packages/server/src/http/routes/attachment.test.ts`

- [ ] **步骤 1：写删除保护测试**

同一 asset 被两个 session/fork 引用时，连续删除一个分支后仍返回 409；删除最后一个引用后：

```ts
expect(service.delete("att_shared")).toMatchObject({
  id: "att_shared",
  status: "deleted",
});
```

HTTP 响应断言 status 409 且 body 的 `error` 以 `attachment_in_use:` 开头，不包含数据库路径、表名或 SQLite 原始错误。

- [ ] **步骤 2：运行附件服务和路由测试并确认失败**

运行：`pnpm --filter @vykor/services test -- src/attachment/__test__/attachment-application-service.test.ts && pnpm --filter @vykor/server test -- src/http/routes/attachment.test.ts src/http/routes/__test__/routes.test.ts`

预期：FAIL，当前 delete 不检查 refs。

- [ ] **步骤 3：实现同事务引用检查和逻辑删除**

Store 暴露 `countInputAttachmentReferences(assetId)` 和 `softDeleteUnreferencedAttachment(id, deletedAt)`。后者在一个 SQLite transaction 中重新计数并更新 asset；计数大于零抛 `AttachmentError("attachment_in_use", ...)`。服务层不使用“先 count、后 delete”的两个独立事务。

- [ ] **步骤 4：验证不触碰 Blob**

测试上传内容，在解除引用并逻辑删除后直接检查 Blob Store 的 hash 文件仍存在；不要在生产代码增加 unlink 调用。

- [ ] **步骤 5：运行测试和类型检查**

运行：`pnpm --filter @vykor/services test -- src/attachment && pnpm --filter @vykor/server test -- src/http/routes/attachment.test.ts src/http/routes/__test__/routes.test.ts && pnpm --filter @vykor/services check-types && pnpm --filter @vykor/server check-types`

预期：全部 PASS。

- [ ] **步骤 6：提交删除保护**

```bash
git add packages/services/src/attachment packages/services/src/session-runtime/store.ts packages/server/src/http
git commit -m "feat(attachments): protect assets referenced by conversations"
```

## 任务 8：接通 HTTP、Client、Snapshot 和 SSE 收敛

**交付物：** Client 可在普通发送和 edit 中携带附件；真实 HTTP 请求、Snapshot、SSE replay/live 都保留完整 ordered refs，不产生重复引用。

**文件：**

- 修改：`packages/server/src/http/routes/run-execution.ts`
- 修改：`packages/server/src/http/routes/__test__/protocol-validation.test.ts`
- 修改：`packages/server/src/http/routes/__test__/routes.test.ts`
- 修改：`packages/client/src/transport/http-client.ts`
- 修改：`packages/client/src/transport/__test__/http-client.test.ts`
- 修改：`packages/client/src/state/reducer.ts`
- 修改：`packages/client/src/state/__test__/reducer.test.ts`
- 修改：`packages/client/src/types/index.ts`

- [ ] **步骤 1：写 HTTP 与 Client 请求测试**

断言普通 admit 和 edit 发出的 JSON 都保留附件顺序：

```ts
attachments: [
  { assetId: "att_b", intent: "auto" },
  { assetId: "att_a", intent: "ocr", displayName: "receipt.png" },
]
```

非法的非数组、缺少 assetId、未知 intent 在 route 进入 application 前返回 400。route 只限制明显异常数组长度；资产存在性和配额仍由 Store 决定。

- [ ] **步骤 2：写 reducer 收敛测试**

先 apply `session.input.admitted`，再 hydrate 含同 input 的 Snapshot；再反向执行一次。两种顺序都断言 bucket 只有一个 input，且它的 `attachments` 与服务端最后记录完全相同。

- [ ] **步骤 3：运行 Client 和 route 测试并确认失败**

运行：`pnpm --filter @vykor/client test -- src/transport/__test__/http-client.test.ts src/state/__test__/reducer.test.ts && pnpm --filter @vykor/server test -- src/http/routes/__test__/protocol-validation.test.ts src/http/routes/__test__/routes.test.ts`

预期：FAIL，edit route 尚未解析附件，测试 fixture 缺少必填 attachments。

- [ ] **步骤 4：实现请求透传和 reducer 原子 upsert**

普通 admit 继续调用 `parseAdmitPromptRequest`；edit route 复用同一个 `parsePromptAttachments` 辅助函数，避免两套枚举。Client transport 不转换字段名。reducer 按 input ID 整体替换 `SessionInputRecord`，不要逐 ref merge。

- [ ] **步骤 5：修正全仓测试 fixture**

所有手写 `SessionInputRecord` 明确加 `attachments: []`。不要把协议字段重新改为可选来减少 fixture 修改；缺失字段必须继续被 decoder 拒绝。

- [ ] **步骤 6：运行 Client、route 和协议测试**

运行：`pnpm --filter @vykor/protocol test && pnpm --filter @vykor/client test && pnpm --filter @vykor/server test -- src/http/routes`

预期：全部 PASS。

- [ ] **步骤 7：提交 Client 与传输链路**

```bash
git add packages/server/src/http/routes packages/client/src packages/protocol/src
git commit -m "feat(attachments): carry prompt references through HTTP and client state"
```

## 任务 9：补齐导出、compaction 和真实重启闭环

**交付物：** 文本/JSON 导出可见附件；compaction 不删除 refs；端到端测试证明上传后发送、重启和分支删除均保持一致。

**文件：**

- 修改：`packages/server/src/session/export-session.ts`
- 修改：`packages/server/src/session/__test__/export-session.test.ts`
- 修改：`packages/server/src/application/session/session-maintenance-service.ts`
- 修改：`packages/server/src/application/session/__test__/session-maintenance-service.test.ts`
- 修改：`packages/server/src/http/__test__/http.test.ts`
- 修改：`docs/superpowers/specs/2026-08-27-conversation-attachments-roadmap-design.md`
- 修改：`docs/superpowers/specs/2026-08-28-conversation-attachments-stage-2-design.md`

- [ ] **步骤 1：写导出与 compaction 测试**

Markdown 导出使用固定、可读格式，例如：

```md
[附件: screen.png | image/png | 42 bytes | assetId=att_1]
```

JSON 导出保留 typed attachment part 和完整 input refs。compaction 前后查询 `listInputAttachments(inputId)`，断言 ID、assetId、seq、intent 和快照字段不变；摘要中不得出现伪造 OCR 文字。

- [ ] **步骤 2：写真实 HTTP 重启测试**

测试流程固定为：上传两个文件 → 发送纯附件 Prompt → 读取 202 结果 → 读取 Snapshot → 断开 daemon → 使用同一 DB 和 Blob 根重启 → 再读 Snapshot/SSE → fork → 删除一个分支 → 验证另一分支仍可读取 asset → 解除最后引用 → DELETE asset 成功。

同时增加事务提交后、事件 publish 前抛错的恢复测试，重启后 input/refs/run 必须完整存在，Client 由 Snapshot 收敛。

- [ ] **步骤 3：运行专项测试并确认失败**

运行：`pnpm --filter @vykor/server test -- src/session/__test__/export-session.test.ts src/application/session/__test__/session-maintenance-service.test.ts src/http/__test__/http.test.ts`

预期：FAIL，导出和端到端断言尚未满足。

- [ ] **步骤 4：实现导出和 compaction 保留规则**

Markdown 只输出显示名、MIME、大小和 assetId，不输出 storage key、Blob 路径或 sha256。JSON 使用现有记录结构。compaction 替换 messages/parts 时不得删除 `session_input_attachment`；若重建 user message，则从 refs 重建 attachment parts。

- [ ] **步骤 5：加入规模和并发验证**

在 Store/HTTP 测试生成 1000 条 input、每条多个 ref，重开数据库并确认一次批量加载完成；使用 `Promise.all` 发两个相同 ID 的 admission，断言只有一条 input、一组 refs 和一个 owning run。

- [ ] **步骤 6：运行阶段 2 完整验证**

运行：

```bash
pnpm --filter @vykor/protocol test
pnpm --filter @vykor/services test
pnpm --filter @vykor/server test
pnpm --filter @vykor/client test
pnpm --filter @vykor/services db:check
pnpm check-types
node scripts/check-docs.mjs
git diff --check
```

预期：全部命令退出码为 0；format 1 拒绝测试、附件引用闭环和 1000-input 测试均通过。

- [ ] **步骤 7：更新阶段状态与验证证据**

把阶段 2 设计文档状态改为“已实现”，记录各包实际测试数量、类型检查数量和最终审查结论。总路线只勾选阶段 2，不提前标记阶段 3—5。

- [ ] **步骤 8：提交端到端闭环**

```bash
git add packages/server/src docs/superpowers/specs
git commit -m "test(attachments): verify durable conversation reference lifecycle"
```

## 任务 10：独立审查和分支交付

**交付物：** 实现与设计逐条对齐，没有把模型路由或 OCR 偷带进阶段 2，分支处于可合并状态。

**文件：**

- 审查：本计划列出的全部变更文件
- 审查：`docs/superpowers/specs/2026-08-28-conversation-attachments-stage-2-design.md`

- [ ] **步骤 1：逐条核对完成标准**

审查者必须给出设计文档八项完成标准到测试名称的映射，特别检查：原子回滚、ordered refs 幂等、附件 steer queue、fork 共享 asset、format 1 拒绝和 Provider-safe sidecar。

- [ ] **步骤 2：扫描越界实现**

运行：

```bash
git diff codex/conversation-attachments-stage-1...HEAD -- packages | rg "light-ocr|ImageToText|visionModel|data:image|base64|pdf_text|tool_mount"
```

预期：没有新增 OCR、视觉模型路由、Data URL、PDF 提取或挂载实现；协议里的 transformation 枚举声明可以出现，但不能有主动创建逻辑。

- [ ] **步骤 3：执行最终新鲜验证**

重新运行任务 9 步骤 6 的全部命令，不引用较早缓存结论。保存每条命令的退出码和测试统计。

- [ ] **步骤 4：处理审查意见并再次验证**

每个必须修复项先补失败测试，再修改实现，再运行所属包测试和最终全量检查。所有必须修复项清零后才能声明阶段完成。

- [ ] **步骤 5：提交审查修正**

只有存在修正时执行：

```bash
git add -u
git commit -m "fix(attachments): close stage two review findings"
```

- [ ] **步骤 6：准备分支交付摘要**

摘要必须包含：最终 commit 范围、实际测试统计、storage format 2 的破坏性说明、用户需要移动或删除 format 1 DB 的操作提示，以及阶段 3 尚未开始的明确说明。
