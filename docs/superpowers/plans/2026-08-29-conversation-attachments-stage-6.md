# 对话附件阶段 6：文本与代码资源实现计划

> 状态：历史计划。Docker 只读挂载步骤已被后续宿主 `attachment://` 工具覆盖设计取代。

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 支持安全的文本与代码附件、小文件有界内联、大文件通过现有 `Read` 按行读取，并在 Provider 执行前阻止 PDF、Office、压缩包和其他二进制文档。

**架构：** Attachment Service 保管不可变原始字节并负责严格文本解码；路由器只生成 `text_inline`、`text_resource` 或稳定 blocked decision。Core 把会话级附件资源宿主注入现有 `Read` 工具，Docker 只读挂载会话资源目录，Desktop 提前展示支持状态但 daemon 保持最终裁决权。

**技术栈：** TypeScript、Node.js Web Streams/TextDecoder、Vitest、Hono、React、Electron、现有 SQLite Attachment Store 与 Docker sandbox。

---

## 文件结构

- `packages/services/src/attachment/attachment-text.ts`：文本候选分类、严格编码识别、换行归一化和有界按行读取。
- `packages/services/src/attachment/attachment-application-service.ts`：对 ready asset 暴露受控文本读取和只读资源物化。
- `packages/core/src/types/tools.ts`、`packages/core/src/types/runtime.ts`：定义并注入 `AgentAttachmentResourceHost`。
- `packages/tools/src/file/attachment-uri.ts`、`packages/tools/src/file/read.ts`：解析 `attachment://` 并复用现有 Read。
- `packages/server/src/application/attachment-routing/*`：文本/代码路由、预览和二进制阻止。
- `packages/server/src/application/attachment-resource/*`：校验 session 引用、调用 Attachment Service、管理会话只读资源目录。
- `packages/sandbox/src/*`：安全追加 daemon 管理的会话附件只读挂载。
- `apps/desktop/src/shared/attachment-types.ts` 与 composer 组件：提前显示不支持原因并阻止发送。
- 对应 `__test__` 文件：每个边界先写失败测试再实现。

### 任务 1：统一文本分类、严格解码与路由（已完成）

**文件：**
- 创建：`packages/services/src/attachment/attachment-text.ts`
- 创建：`packages/services/src/attachment/__test__/attachment-text.test.ts`
- 修改：`packages/services/src/attachment/index.ts`
- 修改：`packages/server/src/application/attachment-routing/attachment-routing-types.ts`
- 修改：`packages/server/src/application/attachment-routing/attachment-capability-router.ts`
- 修改：`packages/server/src/application/attachment-routing/__test__/attachment-capability-router.test.ts`

- [x] **步骤 1：写分类和解码失败测试**

覆盖 UTF-8、BOM、UTF-16LE/BE、无 MIME 代码扩展名、PDF/ZIP 签名优先、NUL、错误编码和伪装 `.txt` 二进制。测试期望公开函数：

```ts
classifyAttachmentCandidate({ displayName, mediaType }): "image" | "text" | "document" | "archive" | "binary"
decodeAttachmentText(bytes): { text: string; encoding: "utf-8" | "utf-16le" | "utf-16be" }
```

运行：`pnpm --filter @vykor/services test -- attachment-text.test.ts`

预期：FAIL，模块尚不存在。

- [x] **步骤 2：实现最小分类和严格解码**

使用显式 MIME/扩展名集合和 fatal `TextDecoder`。PDF、ZIP 和已知 Office 扩展名必须先归入不支持类型；UTF-16 只接受 BOM；规范化 CRLF/CR 为 LF；拒绝 NUL 和二进制控制字符。

- [x] **步骤 3：写路由失败测试**

断言小文本得到 `text_inline` 和完整性标志，大文本得到 `text_resource`、3,000 字符内预览与 `attachment://` URI；PDF/DOCX/XLSX/PPTX/ZIP/未知二进制分别得到稳定错误码，且 `resolveReadyContentPath` 或文本读取器不会在 blocked 路径后继续调用 Provider。

运行：`pnpm --filter @vykor/server test -- attachment-capability-router.test.ts`

预期：FAIL，现有路由只接受图片。

- [x] **步骤 4：实现文本路由并跑回归**

为 router options 增加有界 `readReadyText`。不超过 16,000 字符的正文进入安全包装；更大文件只进入 3,000 字符预览。保持阶段 5 图片代码路径不变。

运行：

```bash
pnpm --filter @vykor/services test -- attachment-text.test.ts attachment-media-type.test.ts
pnpm --filter @vykor/server test -- attachment-capability-router.test.ts attachment-capabilities.test.ts
```

预期：PASS。

- [x] **步骤 5：提交**

```bash
git add packages/services/src/attachment packages/server/src/application/attachment-routing
git commit -m "feat(attachments): route safe text resources"
```

### 任务 2：让现有 Read 安全读取 attachment URI（已完成）

**文件：**
- 修改：`packages/core/src/types/tools.ts`
- 修改：`packages/core/src/types/runtime.ts`
- 修改：`packages/core/src/engine/query-engine.ts`
- 修改：`packages/core/src/index.ts`
- 创建：`packages/tools/src/file/attachment-uri.ts`
- 修改：`packages/tools/src/file/read.ts`
- 修改：`packages/tools/src/file/__test__/read.test.ts`
- 创建：`packages/server/src/application/attachment-resource/agent-attachment-resource-host.ts`
- 创建：`packages/server/src/application/attachment-resource/__test__/agent-attachment-resource-host.test.ts`
- 修改：`packages/server/src/daemon/daemon-agent.ts`
- 修改：`packages/server/src/application/daemon-application.ts`

- [x] **步骤 1：写 URI 与 Read 失败测试**

断言 `attachment://att_123/report.log` 调用 `context.attachments.readText({ assetId: "att_123", offset, limit })`；普通绝对路径仍使用现有 file operations；编码后的斜杠、空 asset ID、userinfo、port、query 和 fragment 被拒绝；宿主缺失返回稳定错误而不是尝试本地路径。

运行：`pnpm --filter @vykor/tools test -- read.test.ts`

预期：FAIL，Read 尚不理解附件 URI。

- [x] **步骤 2：定义宿主接口并注入 QueryEngine**

新增：

```ts
interface AgentAttachmentResourceHost {
  readText(
    input: { assetId: string; offset: number; limit: number },
    context: { sessionId?: string; signal?: AbortSignal },
  ): Promise<AgentAttachmentTextSlice>
}
```

`QueryEngine.setAttachments` 与 `ToolContext.attachments` 使用同一个命名；`inspect().hostCapabilities` 增加 `attachments`，子 Agent 沿用宿主但仍按自己的 session 权限校验。

- [x] **步骤 3：实现 attachment URI 分支**

Read 在调用 `resolveToolPath` 前识别 URI，校验 `offset`、`limit` 为正整数并限制最大行数，格式化宿主返回的行号，末尾明确输出 `has_more: true/false`。不得把 URI 交给 `sandboxPathError` 或 Node `fs`。

- [x] **步骤 4：写并实现 daemon 宿主授权测试**

测试 ready/current-session/same-input 引用成功，其他 session、未引用 asset、deleted asset、PDF、二进制、范围越界和 abort 失败。宿主从 Session Store 查询引用关系，再调用 Attachment Application Service 的有界读取，不信任 URI 展示名。

运行：

```bash
pnpm --filter @vykor/core test
pnpm --filter @vykor/tools test -- read.test.ts
pnpm --filter @vykor/server test -- agent-attachment-resource-host.test.ts
```

预期：PASS。

- [x] **步骤 5：提交**

```bash
git add packages/core packages/tools/src/file packages/server/src/application/attachment-resource packages/server/src/daemon/daemon-agent.ts packages/server/src/application/daemon-application.ts
git commit -m "feat(tools): read conversation attachment resources"
```

### 任务 3：只读资源目录、运行生命周期和 Desktop 阻止提示（已完成）

**文件：**
- 创建：`packages/server/src/application/attachment-resource/session-attachment-resources.ts`
- 创建：`packages/server/src/application/attachment-resource/__test__/session-attachment-resources.test.ts`
- 修改：`packages/server/src/application/session/session-run-executor.ts`
- 修改：`packages/server/src/application/session/__test__/session-run-executor.test.ts`
- 修改：`packages/sandbox/src/types.ts`
- 修改：`packages/sandbox/src/lifecycle.ts`
- 修改：`packages/sandbox/src/docker-backend.ts`
- 修改：`packages/sandbox/src/index.test.ts`
- 修改：`apps/desktop/src/shared/attachment-types.ts`
- 修改：`apps/desktop/src/shared/attachment-types.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer-attachments.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer-attachments.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx`

- [x] **步骤 1：写资源生命周期和挂载失败测试**

断言每个 session 使用独立目录；物化名只含 asset ID；只允许已路由为 text 的 ready asset；文件为只读；同一 asset 重用；run 完成/失败/中断均清理本次条目。Docker argv 只能出现 `<session-resource-root>:/mnt/vykor-attachments:ro`，不能出现 blob store 根目录。

运行：

```bash
pnpm --filter @vykor/server test -- session-attachment-resources.test.ts session-run-executor.test.ts
pnpm --filter @vykor/sandbox test
```

预期：FAIL，资源生命周期尚未接线。

- [x] **步骤 2：实现受管只读资源根**

在 daemon 创建 Agent/sandbox 前创建空的 session 资源目录并通过受管字段追加只读 mount；不复用用户可编辑的 `settings.sandbox.docker.extraMounts` 字符串。路由成功后物化本 run 的 text asset，`finally` 清理；清理只能作用于验证过的 session 资源根。

- [x] **步骤 3：写 Desktop 失败测试**

用 shared classifier 断言 PDF、DOCX、XLSX、PPTX、ZIP 卡片显示不支持原因且 `canSend` 为 false；TXT/MD/TS/JSON 和图片保持可发送；“添加文件夹”菜单项仍存在且禁用。

运行：`pnpm --filter @vykor/desktop test -- attachment-types.test.ts composer-attachments.test.ts`

预期：FAIL，草稿没有支持状态。

- [x] **步骤 4：实现 Desktop 预检和服务端兜底**

附件卡片只展示通俗原因，不展示内部错误码；发送按钮根据所有附件 ready 且 supported 决定。服务端路由仍做真实签名和编码校验，Desktop 判断不是安全边界。

运行：

```bash
pnpm --filter @vykor/server test -- session-attachment-resources.test.ts session-run-executor.test.ts
pnpm --filter @vykor/sandbox test
pnpm --filter @vykor/desktop test -- attachment-types.test.ts composer-attachments.test.ts composer-attachment-preview.test.ts
```

预期：PASS。

- [x] **步骤 5：提交**

```bash
git add packages/server/src/application/attachment-resource packages/server/src/application/session packages/sandbox apps/desktop/src
git commit -m "feat(attachments): isolate text resources and block documents"
```

### 任务 4：真实文件、重放、全仓与打包验收（已完成）

**文件：**
- 修改：`packages/server/src/http/__test__/http.test.ts`
- 修改：`packages/server/src/application/session/__test__/transcript-projection.test.ts`
- 修改：`packages/services/src/session-runtime/__test__/prompt-attachments.test.ts`
- 修改：`docs/superpowers/specs/2026-08-29-conversation-attachments-stage-6-design.md`
- 修改：`docs/superpowers/specs/2026-08-27-conversation-attachments-roadmap-design.md`

- [x] **步骤 1：增加真实字节端到端测试**

通过真实 HTTP 上传并发送 UTF-8 中文、UTF-8 BOM、UTF-16LE/BE、5 MiB 日志、TypeScript、JSON、PDF、最小 DOCX/ZIP 签名和伪装 `.txt` 二进制。断言文本可重放且 attachment URI 可读，不支持格式在 mock Provider 收到请求前失败。

- [x] **步骤 2：验证 transcript、retry、fork 与重启**

路由 decision 在 transcript/run metadata 中稳定；重试和 daemon 重启后仍能授权已引用文本 asset；另一个 session 无法读取；失败附件不生成虚假的 transformation completed。

运行：

```bash
pnpm --filter @vykor/server test -- http.test.ts transcript-projection.test.ts
pnpm --filter @vykor/services test -- prompt-attachments.test.ts
```

预期：PASS。

- [x] **步骤 3：运行全仓验证**

```bash
pnpm test
pnpm check-types
pnpm check-docs
pnpm lint
git diff --check
```

预期：测试、类型、文档和 diff 检查通过。若根 `lint` 仍因仓库没有 Turbo lint task 失败，记录为仓库脚本缺口，并执行所有受影响 package 的实际 lint/静态检查，不能写成“lint 通过”。

- [x] **步骤 4：运行 Desktop 生产构建和打包 smoke**

```bash
pnpm --filter @vykor/desktop build
pnpm --filter @vykor/desktop exec electron-builder --win --x64 --dir
```

使用打包产物启动 smoke，确认 TXT/代码可发送、PDF/DOCX/XLSX/PPTX 禁止发送、“添加文件夹”仍显示、图片原生与 OCR 路线可用。

- [x] **步骤 5：更新设计验收记录并提交**

```bash
git add docs packages/server/src/http/__test__/http.test.ts packages/server/src/application/session/__test__/transcript-projection.test.ts packages/services/src/session-runtime/__test__/prompt-attachments.test.ts
git commit -m "test(attachments): verify text resource stage"
```
